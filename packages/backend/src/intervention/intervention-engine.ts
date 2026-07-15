import { LawTrigger, PromptEvent, PromptType } from '@gleameet/shared';
import { RANKING_WEIGHTS, MAX_PROMPTS_PER_30_MIN, PROMPT_LIMITS } from '@gleameet/shared';
import { loadLawById } from '@gleameet/law-registry';
import {
  MeetingState,
  isGlobalCooldownActive,
  setGlobalCooldown,
  setLawCooldown,
  incrementPromptCount,
  getPromptCount,
  isUserSpeaking,
} from '../db/redis';
import { v4 as uuidv4 } from 'uuid';
import { buildLLMClient, LLM_MODEL } from '../services/llm-client';

/** Candidate prompt with ranking score */
interface RankedCandidate {
  trigger: LawTrigger;
  prompt: PromptEvent;
  score: number;
}

const RECENT_PROMPT_LAW_MEMORY = 5;

/**
 * Rank candidate triggers and select at most one prompt (FR-045).
 * Applies throttling, safety rules, and timing constraints.
 */
export async function rankAndSelectPrompt(
  meetingSessionId: string,
  triggers: LawTrigger[],
  state: MeetingState
): Promise<PromptEvent | null> {
  // Check for positive reinforcement opportunity first (every ~5 good behaviors)
  const reinforcementPrompt = await maybeGenerateReinforcement(meetingSessionId, state);
  if (reinforcementPrompt) return reinforcementPrompt;

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

  if (triggers.length === 0) return null;

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
    const repeatPenalty = computeRepeatPenalty(trigger, state);
    const timingFit = speaking ? 0.1 : 0.9; // FR-050: penalize if user speaking
    const estimatedUsefulness = trigger.trigger_confidence * 0.8;

    const score =
      (trigger.trigger_confidence * RANKING_WEIGHTS.TRIGGER_CONFIDENCE) +
      (urgency * RANKING_WEIGHTS.URGENCY) +
      (novelty * RANKING_WEIGHTS.NOVELTY) +
      (timingFit * RANKING_WEIGHTS.TIMING_FIT) +
      (estimatedUsefulness * RANKING_WEIGHTS.ESTIMATED_USEFULNESS) -
      repeatPenalty;

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

  // Select one prompt with diversity-weighted randomness among the strongest
  // candidates so one law does not monopolize the nudge stream.
  candidates.sort((a, b) => b.score - a.score);
  const selected = selectCandidateWithDiversity(candidates, state);

  // SR-006: Favor silence over low-confidence coaching
  if (selected.score < 0.1) return null;

  // Generate personalized nudge via LLM (non-blocking fallback to static text)
  const law = loadLawById(selected.trigger.law_id);
  if (law) {
    const personalized = await generatePersonalizedNudge(
      law,
      selected.trigger,
      state,
      selected.prompt.short_text
    );
    selected.prompt.short_text = personalized.short_text;
    selected.prompt.rationale_text = personalized.rationale_text;
    console.log(`[INTERVENTION] Nudge text: "${personalized.short_text}" | rationale: "${personalized.rationale_text}"`);
    await setLawCooldown(meetingSessionId, selected.trigger.law_id, law.cooldown_seconds);
  }

  // Set global cooldown (FR-046)
  await setGlobalCooldown(meetingSessionId, 15); // 15s between prompts
  await incrementPromptCount(meetingSessionId);

  // Update state
  state.prompts_shown_count++;
  state.last_prompt_shown_at = new Date().toISOString();
  const recentLawIds = state.recent_prompt_law_ids || [];
  recentLawIds.push(selected.trigger.law_id);
  state.recent_prompt_law_ids = recentLawIds.slice(-RECENT_PROMPT_LAW_MEMORY);

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
  const recentLawIds = state.recent_prompt_law_ids || [];

  // First prompt is always novel
  if (state.prompts_shown_count === 0 || recentLawIds.length === 0) return 1.0;

  const lastLawId = recentLawIds[recentLawIds.length - 1];
  if (lastLawId === trigger.law_id) {
    return 0.05;
  }

  if (recentLawIds.includes(trigger.law_id)) {
    return 0.35;
  }

  // Overall prompt volume still matters, but fresh laws should keep
  // outranking repeated ones so the nudge stream stays varied.
  return Math.max(0.55, 1.0 - (state.prompts_shown_count * 0.05));
}

function computeRepeatPenalty(trigger: LawTrigger, state: MeetingState): number {
  const recentLawIds = state.recent_prompt_law_ids || [];
  if (recentLawIds.length === 0) return 0;

  const lastLawId = recentLawIds[recentLawIds.length - 1];
  if (lastLawId === trigger.law_id) {
    return 0.22;
  }

  if (recentLawIds.includes(trigger.law_id)) {
    return 0.08;
  }

  return 0;
}

function selectCandidateWithDiversity(
  candidates: RankedCandidate[],
  state: MeetingState
): RankedCandidate {
  const topScore = candidates[0]?.score ?? 0;
  const recentLawIds = state.recent_prompt_law_ids || [];
  const lastLawId = recentLawIds[recentLawIds.length - 1];
  const scoreFloor = Math.max(0.1, topScore - 0.18);
  const eligible = candidates.filter((candidate) => candidate.score >= scoreFloor);

  let totalWeight = 0;
  const weighted = eligible.map((candidate) => {
    const seenRecently = recentLawIds.includes(candidate.trigger.law_id);
    const sameAsLast = lastLawId === candidate.trigger.law_id;
    const diversityMultiplier = sameAsLast ? 0.2 : (seenRecently ? 0.7 : 1.25);
    const weight = Math.max(0.01, candidate.score + 0.05) * diversityMultiplier;
    totalWeight += weight;
    return { candidate, weight };
  });

  let draw = Math.random() * totalWeight;
  for (const entry of weighted) {
    draw -= entry.weight;
    if (draw <= 0) {
      return entry.candidate;
    }
  }

  return weighted[weighted.length - 1]?.candidate || candidates[0];
}

/** Generate a personalized nudge using GPT-4o with transcript context */
async function generatePersonalizedNudge(
  law: any,
  trigger: LawTrigger,
  state: MeetingState,
  templateText: string
): Promise<{ short_text: string; rationale_text: string }> {
  const fallback = { short_text: templateText, rationale_text: law.meeting_relevance?.slice(0, 60) || '' };

  try {
    const recentLines = (state.recent_transcript || []).slice(-12);
    if (recentLines.length === 0) return fallback;

    const transcriptBlock = recentLines
      .map((l) => `[${l.speaker}]: ${l.text}`)
      .join('\n');

    const featureSnapshot = trigger.feature_snapshot_json
      ? (typeof trigger.feature_snapshot_json === 'string'
          ? trigger.feature_snapshot_json
          : JSON.stringify(trigger.feature_snapshot_json))
      : '{}';

    const prompt = `You are a real-time meeting coach. Rewrite the nudge below so it feels personal and in-the-moment.
You are coaching ONLY the [user] speaker. Other participants ([other]) appear for context only — NEVER coach, critique, or reference their behavior.

Behavioral law: ${law.law_name} — ${law.description}
Trigger confidence: ${trigger.trigger_confidence}
Feature snapshot: ${featureSnapshot}

Recent conversation:
${transcriptBlock}

Template nudge: "${templateText}"

Rules:
- short_text: ONE actionable sentence, up to 25 words. Reference something specific from the [user]'s own words or behavior.
- rationale_text: ONE sentence explaining exactly WHY this nudge is being given — cite the [user]'s specific behavior observed (e.g. "You've used hedging phrases 3 times in the last 2 minutes" or "You interrupted before they finished their point"). Up to 20 words. Be specific, not generic.
- Do NOT use quotes inside the strings.
- Address the user as "you" — never mention other participants by name or role.

Respond in exactly this JSON format (no markdown):
{"short_text": "...", "rationale_text": "..."}`;

    const client = buildLLMClient();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const response = await client.chat.completions.create(
      {
        model: LLM_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.7,
      },
      { signal: controller.signal }
    );

    clearTimeout(timeout);

    const content = response.choices?.[0]?.message?.content?.trim();
    if (!content) return fallback;

    const parsed = JSON.parse(content);
    if (parsed.short_text && typeof parsed.short_text === 'string') {
      return {
        short_text: parsed.short_text.slice(0, 100),
        rationale_text: (parsed.rationale_text || '').slice(0, 150),
      };
    }
    return fallback;
  } catch (err: any) {
    console.warn(`[INTERVENTION] LLM nudge generation failed, using template: ${err.message}`);
    return fallback;
  }
}

/**
 * Check if the speaker has done something worth reinforcing.
 * Fires at most once per 5 new positive behaviors, with global cooldown respected.
 */
async function maybeGenerateReinforcement(
  meetingSessionId: string,
  state: MeetingState
): Promise<PromptEvent | null> {
  try {
    // Compute total positive behaviors so far
    const positiveBehaviorCount =
      state.question_count +
      state.acknowledgment_count +
      state.summary_or_recap_count +
      (state.owner_assignment_present ? 1 : 0) +
      (state.deadline_present ? 1 : 0) +
      (state.evidence_reference_present ? 1 : 0) +
      (state.shared_goal_language_present ? 1 : 0);

    // Fire reinforcement every 5 new positive behaviors
    const newBehaviors = positiveBehaviorCount - state.last_reinforcement_behavior_count;
    if (newBehaviors < 5) return null;

    // Respect global cooldown
    const globalCooldown = await isGlobalCooldownActive(meetingSessionId);
    if (globalCooldown) return null;

    // Don't reinforce if not active
    if (state.status !== 'active') return null;

    // Identify the most recent positive thing they did
    const recentTranscript = (state.recent_transcript || []).slice(-5)
      .map(t => `${t.speaker === 'user' ? 'You' : 'Other'}: ${t.text}`)
      .join('\n');

    const positiveContext = [
      state.question_count > 0 ? `asked ${state.question_count} question(s)` : null,
      state.acknowledgment_count > 0 ? `acknowledged others ${state.acknowledgment_count} time(s)` : null,
      state.summary_or_recap_count > 0 ? `summarized/recapped ${state.summary_or_recap_count} time(s)` : null,
      state.evidence_reference_present ? 'referenced evidence or data' : null,
      state.shared_goal_language_present ? 'used shared goal language' : null,
    ].filter(Boolean).join(', ');

    const prompt = `You are a real-time meeting coach giving positive reinforcement.
You are coaching ONLY the user ("You" in the transcript). Other participants appear for context only — NEVER praise or reference their behavior.

The user has done something well: ${positiveContext}

Recent conversation:
${recentTranscript || '(no transcript yet)'}

Generate a brief, qualified compliment that:
- Acknowledges a SPECIFIC positive behavior by the user (labeled "You") in the data or transcript
- Uses a qualified statement (not over-the-top praise) — e.g. "Good instinct to summarize there" or "Asking that question helped clarify the goal"
- Is 10-20 words
- Feels natural and coach-like, not sycophantic
- Never mentions other participants by name or role

Also write a short rationale (max 15 words) explaining what specific user behavior triggered this.

Respond in exactly this JSON format (no markdown):
{"short_text": "...", "rationale_text": "..."}`;

    const client = buildLLMClient();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const response = await client.chat.completions.create(
      { model: LLM_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 150, temperature: 0.7 },
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    const content_resp = response.choices?.[0]?.message?.content?.trim();
    if (!content_resp) return null;

    const parsed = JSON.parse(content_resp);
    if (!parsed.short_text) return null;

    // Update tracker
    state.last_reinforcement_behavior_count = positiveBehaviorCount;

    await setGlobalCooldown(meetingSessionId, 10);
    await incrementPromptCount(meetingSessionId);
    state.prompts_shown_count++;
    state.last_prompt_shown_at = new Date().toISOString();
    const recentLawIds = state.recent_prompt_law_ids || [];
    recentLawIds.push('REINFORCE');
    state.recent_prompt_law_ids = recentLawIds.slice(-RECENT_PROMPT_LAW_MEMORY);

    const promptEvent: PromptEvent = {
      prompt_id: uuidv4(),
      meeting_session_id: meetingSessionId,
      law_id: 'REINFORCE',
      prompt_type: 'reinforce' as PromptType,
      short_text: parsed.short_text.slice(0, 120),
      rationale_text: (parsed.rationale_text || '').slice(0, 150),
      example_phrase: null,
      shown_at: null,
      expired_at: new Date(Date.now() + 30000).toISOString(),
      display_state: 'pending',
      dismissed_at: null,
      confidence: 0.9,
    };

    console.log(`[INTERVENTION] Positive reinforcement fired: "${promptEvent.short_text}"`);
    return promptEvent;
  } catch (err: any) {
    console.warn(`[INTERVENTION] Reinforcement generation failed: ${err.message}`);
    return null;
  }
}
