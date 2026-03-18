import { LawTrigger, PromptEvent, PromptType } from '@gleameet/shared';
import { RANKING_WEIGHTS, MAX_PROMPTS_PER_30_MIN, PROMPT_LIMITS } from '@gleameet/shared';
import { loadLawById } from '@gleameet/law-registry';
import {
  MeetingState,
  isGlobalCooldownActive,
  setGlobalCooldown,
  incrementPromptCount,
  getPromptCount,
  isUserSpeaking,
} from '../db/redis';
import { v4 as uuidv4 } from 'uuid';

/** Candidate prompt with ranking score */
interface RankedCandidate {
  trigger: LawTrigger;
  prompt: PromptEvent;
  score: number;
}

/**
 * Rank candidate triggers and select at most one prompt (FR-045).
 * Applies throttling, safety rules, and timing constraints.
 */
export async function rankAndSelectPrompt(
  meetingSessionId: string,
  triggers: LawTrigger[],
  state: MeetingState
): Promise<PromptEvent | null> {
  if (triggers.length === 0) return null;

  // Check session status (muted sessions don't get prompts)
  if (state.status === 'muted') return null;

  // FR-046: Check global cooldown
  const globalCooldown = await isGlobalCooldownActive(meetingSessionId);
  if (globalCooldown) return null;

  // FR-048: Check per-intensity rate limit
  const intensity = 'standard'; // TODO: Get from user preferences
  const maxRate = MAX_PROMPTS_PER_30_MIN[intensity];
  const currentCount = await getPromptCount(meetingSessionId);
  if (currentCount >= maxRate) return null;

  // FR-050: Check if user is speaking (suppress non-urgent prompts)
  const speaking = await isUserSpeaking(meetingSessionId);

  // Score and rank all candidates
  const candidates: RankedCandidate[] = [];

  for (const trigger of triggers) {
    // SR-001: No prompt without active law + supporting evidence
    const law = loadLawById(trigger.law_id);
    if (!law || law.status !== 'active') continue;

    // SR-005: No prompt if confidence below threshold
    if (trigger.trigger_confidence < law.confidence_threshold) continue;

    // Select a prompt template from the law
    const template = law.prompt_templates_live[0]; // Pick first matching template
    if (!template) continue;

    // Validate prompt length constraints
    if (!validatePromptLength(template.text)) continue;

    // Compute ranking score (section 26 heuristic)
    const urgency = computeUrgency(trigger, law);
    const novelty = computeNovelty(trigger, state);
    const timingFit = speaking ? 0.1 : 0.9; // FR-050: penalize if user speaking
    const estimatedUsefulness = trigger.trigger_confidence * 0.8;

    // Fatigue penalty: increases with more prompts shown
    const fatiguePenalty = state.prompts_shown_count * 0.05;

    const score =
      (trigger.trigger_confidence * RANKING_WEIGHTS.TRIGGER_CONFIDENCE) +
      (urgency * RANKING_WEIGHTS.URGENCY) +
      (novelty * RANKING_WEIGHTS.NOVELTY) +
      (timingFit * RANKING_WEIGHTS.TIMING_FIT) +
      (estimatedUsefulness * RANKING_WEIGHTS.ESTIMATED_USEFULNESS) -
      fatiguePenalty;

    // FR-050: Skip non-urgent prompts while speaking
    if (speaking && urgency < 0.8) continue;

    const prompt: PromptEvent = {
      prompt_id: uuidv4(),
      meeting_session_id: meetingSessionId,
      law_id: trigger.law_id,
      prompt_type: template.type as PromptType,
      short_text: template.text,
      rationale_text: law.meeting_relevance.length <= 60 ? law.meeting_relevance : null,
      example_phrase: null,
      shown_at: null,
      expired_at: null,
      display_state: 'pending',
      dismissed_at: null,
      confidence: trigger.trigger_confidence,
    };

    candidates.push({ trigger, prompt, score });
  }

  if (candidates.length === 0) return null;

  // Sort by score descending, select top candidate (FR-045: at most one)
  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates[0];

  // SR-006: Favor silence over low-confidence coaching
  if (selected.score < 0.2) return null;

  // Set global cooldown (FR-046)
  await setGlobalCooldown(meetingSessionId, 60); // default 60s
  await incrementPromptCount(meetingSessionId);

  // Update state
  state.prompts_shown_count++;
  state.last_prompt_shown_at = new Date().toISOString();

  // Set prompt timing
  selected.prompt.shown_at = new Date().toISOString();
  selected.prompt.display_state = 'pending'; // Will be 'shown' once acked by extension

  // Set expiry (prompts expire after 30 seconds if not shown)
  const expiryDate = new Date(Date.now() + 30000);
  selected.prompt.expired_at = expiryDate.toISOString();

  console.log(`[INTERVENTION] Selected prompt: law=${selected.trigger.law_id} score=${selected.score.toFixed(3)} text="${selected.prompt.short_text}"`);

  return selected.prompt;
}

/** Validate prompt text length constraints (FR-058, FR-059, FR-060) */
function validatePromptLength(text: string): boolean {
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  return wordCount <= PROMPT_LIMITS.BODY_MAX_WORDS;
}

/** Compute urgency score (0-1) based on trigger type and context */
function computeUrgency(trigger: LawTrigger, law: any): number {
  // Event-based triggers are more urgent than rolling window
  const baseUrgency = law.trigger_type === 'event' ? 0.7 : 0.4;

  // Higher confidence = higher urgency
  const confidenceBoost = trigger.trigger_confidence * 0.3;

  return Math.min(baseUrgency + confidenceBoost, 1.0);
}

/** Compute novelty score (0-1) — higher if this law hasn't triggered recently (FR-049) */
function computeNovelty(trigger: LawTrigger, state: MeetingState): number {
  // First prompt is always novel
  if (state.prompts_shown_count === 0) return 1.0;

  // Novelty decreases with more prompts shown
  // In production, track per-law trigger history for better novelty scoring
  return Math.max(0.3, 1.0 - (state.prompts_shown_count * 0.15));
}
