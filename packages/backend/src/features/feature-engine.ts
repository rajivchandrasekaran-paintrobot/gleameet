import { RawEvent, FeatureObservation, FeatureName, WindowType, EvidenceRef } from '@gleameet/shared';
import { MeetingState } from '../db/redis';
import { v4 as uuidv4 } from 'uuid';

/** Feature snapshot: current values of all features for law evaluation */
export interface FeatureSnapshot {
  [key: string]: number | boolean;
}

interface TranscriptSegmentPayload {
  text?: string;
  speaker?: 'user' | 'other';
  attribution?: {
    passes_user_attribution?: boolean;
    final_speaker?: 'user' | 'other';
  };
}

// --- Keyword lists for rule-based classifiers ---

const HEDGING_PATTERNS = [
  /\b(maybe|perhaps|possibly|probably|might|could be|sort of|kind of)\b/i,
  /\bi think\b/i,
  /\bi guess\b/i,
  /\bi believe\b/i,
  /\bnot sure\b/i,
  /\bnot certain\b/i,
  /\bit seems\b/i,
  /\bit appears\b/i,
  /\bi suppose\b/i,
  /\bmore or less\b/i,
  /\bin a way\b/i,
  /\bif (i'm|i am) not mistaken\b/i,
  /\btend to\b/i,
  /\bto some extent\b/i,
  /\bas far as i know\b/i,
];

const CERTAINTY_PATTERNS = [
  /\b(definitely|absolutely|certainly|clearly|obviously|undoubtedly)\b/i,
  /\bi know\b/i,
  /\bi('m| am) (sure|certain|confident|positive)\b/i,
  /\bwithout (a )?doubt\b/i,
  /\bno question\b/i,
  /\bfor sure\b/i,
  /\bthere's no way\b/i,
  /\bguaranteed\b/i,
  /\b100 percent\b/i,
  /\bof course\b/i,
  /\bplain and simple\b/i,
];

const LOSS_FRAME_PATTERNS = [
  /\b(lose|loss|losing|lost)\b/i,
  /\b(risk|risks|risky)\b/i,
  /\b(downside|downsides)\b/i,
  /\b(cost|costs|costly)\b/i,
  /\b(threat|threats|threatened)\b/i,
  /\b(fail|failure|failing)\b/i,
  /\b(miss out|missing out)\b/i,
  /\b(danger|dangerous)\b/i,
  /\b(penalty|penalties)\b/i,
  /\b(worst case|worst-case)\b/i,
  /\b(fall behind|falling behind)\b/i,
  /\b(damage|damages)\b/i,
  /\b(decline|declining)\b/i,
  /\b(problem|problems)\b/i,
  /\b(negative impact|negatively)\b/i,
];

const GAIN_FRAME_PATTERNS = [
  /\b(opportunity|opportunities)\b/i,
  /\b(benefit|benefits|beneficial)\b/i,
  /\b(upside|upsides)\b/i,
  /\b(advantage|advantages)\b/i,
  /\b(gain|gains|gaining)\b/i,
  /\b(growth|growing|grow)\b/i,
  /\b(improve|improvement|improving)\b/i,
  /\b(profit|profitable)\b/i,
  /\b(win|winning|wins)\b/i,
  /\b(positive impact|positively)\b/i,
  /\b(best case|best-case)\b/i,
  /\b(save|savings)\b/i,
  /\b(reward|rewards)\b/i,
  /\b(success|successful)\b/i,
  /\b(value|valuable)\b/i,
];

const ACKNOWLEDGMENT_PATTERNS = [
  /\bi (understand|see|hear you|agree|appreciate)\b/i,
  /\bthat's a (good|fair|valid|great|excellent) point\b/i,
  /\byou're right\b/i,
  /\bmakes sense\b/i,
  /\bgood point\b/i,
  /\bfair point\b/i,
  /\bi hear what you('re| are) saying\b/i,
  /\bthat's true\b/i,
  /\babsolutely right\b/i,
  /\bwell said\b/i,
  /\bgreat observation\b/i,
  /\bthat resonates\b/i,
];

const DISAGREEMENT_PATTERNS = [
  /\bbut\b/i,
  /\bhowever\b/i,
  /\bi disagree\b/i,
  /\bactually\b/i,
  /\bno,\s/i,
  /\bthat's not\b/i,
  /\bi don't (think|agree|believe)\b/i,
  /\bon the contrary\b/i,
  /\bi beg to differ\b/i,
  /\bthat's wrong\b/i,
  /\bnot necessarily\b/i,
  /\bi take issue\b/i,
  /\bi wouldn't say\b/i,
  /\bi challenge\b/i,
  /\bwith all due respect\b/i,
];

const OPTION_PATTERNS = [
  /\boption (a|b|c|d|one|two|three|1|2|3)\b/i,
  /\b(first|second|third) option\b/i,
  /\bwe could (either|do)?\s*\w+.{0,40}\bor\b/i,
  /\balternatively\b/i,
  /\banother (approach|option|way|possibility)\b/i,
  /\bon (the )?one hand\b/i,
  /\bon the other hand\b/i,
  /\bchoice (a|b|c|1|2|3)\b/i,
  /\b(path|route|approach) (a|b|c|1|2|3)\b/i,
  /\b(1\)|2\)|3\))\s/,
  /\beither\b.{0,40}\bor\b/i,
];

const DEFAULT_RECOMMENDATION_PATTERNS = [
  /\bi (recommend|suggest)\b/i,
  /\bmy recommendation\b/i,
  /\bwe should (go with|choose|pick|use|do)\b/i,
  /\bi('d| would) (recommend|suggest|propose|advise)\b/i,
  /\bthe best (option|approach|choice|path) (is|would be)\b/i,
  /\blet's go with\b/i,
  /\bi propose\b/i,
  /\bi advise\b/i,
];

const OWNER_ASSIGNMENT_PATTERNS = [
  /\b\w+ will (do|handle|take care of|own|lead|manage|complete|finish|deliver)\b/i,
  /\bassigned to\b/i,
  /\b@\w+\s+will\b/i,
  /\b(you|I|he|she|they|we) (will|should|can) (take|own|handle|lead|be responsible)\b/i,
  /\b(action item|action) for\b/i,
  /\bresponsible for\b/i,
  /\bowner(ship)?[:\s]+\w/i,
  /\bI'll take\b/i,
  /\byou take\b/i,
];

const DEADLINE_PATTERNS = [
  /\bby (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\bby (end of |eod|eow|eom|end of day|end of week|end of month)\b/i,
  /\bby (next|this) (week|month|quarter|sprint)\b/i,
  /\bdue (date|on|by)\b/i,
  /\bdeadline\b/i,
  /\b\d{1,2}[\/-]\d{1,2}([\/-]\d{2,4})?\b/,
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/i,
  /\bwithin\s+\d+\s+(days?|weeks?|hours?)\b/i,
  /\bby (tomorrow|tonight)\b/i,
  /\bnext (monday|tuesday|wednesday|thursday|friday)\b/i,
  /\bQ[1-4]\b/,
];

const EVIDENCE_REFERENCE_PATTERNS = [
  /\bdata shows\b/i,
  /\baccording to\b/i,
  /\bresearch (shows|suggests|indicates)\b/i,
  /\bstudy (shows|found|suggests)\b/i,
  /\bstatistics\b/i,
  /\bmetrics (show|indicate|suggest)\b/i,
  /\bthe numbers\b/i,
  /\bbased on (the )?(data|evidence|research|numbers|analysis)\b/i,
  /\bevidence (shows|suggests|indicates)\b/i,
  /\banalysis (shows|reveals|suggests)\b/i,
  /\bsurvey (shows|found|results)\b/i,
  /\breport (shows|found|indicates)\b/i,
  /\bbenchmark\b/i,
];

const PEER_EXAMPLE_PATTERNS = [
  /\bsimilar to (what )?\w+/i,
  /\blike \w+ (company|team|org|did|does)\b/i,
  /\bas \w+ did\b/i,
  /\b(competitor|industry) (standard|benchmark|practice)\b/i,
  /\b(google|amazon|apple|microsoft|facebook|netflix|spotify|uber|airbnb|slack) (does|did|uses?|built)\b/i,
  /\b(other (companies|teams|organizations)|peers) (have|do|did)\b/i,
  /\bbest practice\b/i,
  /\bjust like\b/i,
  /\bfollowing (the )?example\b/i,
];

const SHARED_GOAL_PATTERNS = [
  /\bwe all (want|need|agree|share)\b/i,
  /\bour (goal|objective|mission|aim|target|shared)\b/i,
  /\btogether we\b/i,
  /\bas a team\b/i,
  /\bcommon (goal|ground|interest|objective)\b/i,
  /\bshared (goal|interest|objective|vision)\b/i,
  /\bwe're all (in|on|aligned)\b/i,
  /\bin this together\b/i,
  /\bcollective(ly)?\b/i,
  /\bmutual (benefit|interest|goal)\b/i,
];

const SUMMARY_RECAP_PATTERNS = [
  /\bto summarize\b/i,
  /\bso we agree\b/i,
  /\blet me recap\b/i,
  /\bin summary\b/i,
  /\bto (sum|wrap) (it )?up\b/i,
  /\bso (to|in) (summary|recap)\b/i,
  /\blet me (summarize|recap)\b/i,
  /\bin (short|brief)\b/i,
  /\bkey takeaway\b/i,
  /\bto recap\b/i,
  /\bbottom line\b/i,
  /\bso what we('ve| have) agreed\b/i,
];

const QUESTION_PATTERNS = [
  /^(what|how|why|when|where|who|which|could|would|should|do you|can you|is there|are there|have you|will you|shall we|don't you|isn't|aren't|won't|wouldn't|couldn't|shouldn't|does|did|has|was|were)\b/i,
];

const CLARIFYING_QUESTION_PATTERNS = [
  /\bclarif/i,
  /\bunderstand\b/i,
  /\bmean by\b/i,
  /\bcould you explain\b/i,
  /\bwhat do you mean\b/i,
  /\bcan you elaborate\b/i,
  /\bcould you be more specific\b/i,
  /\bwhat exactly\b/i,
  /\bjust to be clear\b/i,
  /\bam i understanding correctly\b/i,
  /\bso you're saying\b/i,
  /\blet me make sure i understand\b/i,
];

// --- Action specificity detection ---
// Looks for owner + verb + deadline-like patterns in one segment

const ACTION_SPECIFICITY_INDICATORS = [
  /\b(I|we|you|he|she|they|@?\w+)\s+(will|should|need to|must|going to)\s+\w+/i,
];

/** Count how many patterns from a list match the text */
function countPatternMatches(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const p of patterns) {
    if (p.test(text)) count++;
  }
  return count;
}

/** Check if any pattern matches */
function anyPatternMatches(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

/**
 * Process a batch of events and update meeting state + compute features.
 * Returns the current feature snapshot for law evaluation.
 * Implements FR-023 through FR-029.
 */
export async function processEvents(
  events: RawEvent[],
  state: MeetingState
): Promise<FeatureSnapshot> {
  const sorted = [...events].sort(
    (a, b) => new Date(a.event_time_utc).getTime() - new Date(b.event_time_utc).getTime()
  );

  for (const event of sorted) {
    updateStateFromEvent(event, state);
  }

  return computeFeatureSnapshot(state);
}

/** Update rolling meeting state from a single event */
function updateStateFromEvent(event: RawEvent, state: MeetingState): void {
  const now = new Date(event.event_time_utc).getTime();

  switch (event.event_type) {
    case 'speech_started': {
      const speaker = (event.payload as any)?.speaker;
      if (speaker === 'user') {
        state.last_speech_start_ms = now;
        state.user_is_speaking = true;
      }
      break;
    }

    case 'speech_ended': {
      const speaker = (event.payload as any)?.speaker;
      if (speaker === 'user' && state.last_speech_start_ms !== null) {
        const duration = now - state.last_speech_start_ms;
        state.speaking_time_total_ms += duration;
        state.user_is_speaking = false;
        state.last_speech_start_ms = null;
      } else if (speaker === 'other') {
        const startMs = (event.payload as any)?.start_offset_ms;
        const endMs = (event.payload as any)?.end_offset_ms;
        if (startMs !== undefined && endMs !== undefined) {
          state.other_speaking_time_total_ms += (endMs - startMs);
        }
      }
      break;
    }

    case 'turn_change': {
      state.turn_count++;
      state.last_turn_change_ms = now;
      break;
    }

    case 'interruption_candidate': {
      state.interruption_count++;
      break;
    }

    case 'transcript_segment': {
      const payload = event.payload as TranscriptSegmentPayload;
      const resolvedSpeaker = payload?.attribution?.final_speaker || payload?.speaker;
      const passesUserAttribution = payload?.attribution?.passes_user_attribution !== false;
      if (payload?.text) {
        // Push to rolling transcript buffer for both speakers
        state.recent_transcript.push({ speaker: resolvedSpeaker || 'other', text: payload.text, ts: now });
        if (state.recent_transcript.length > 10) state.recent_transcript.shift();
      }
      if (payload?.text) {
        // Count turn changes when speaker alternates
        const lastSpeaker = state.recent_transcript.length >= 2
          ? state.recent_transcript[state.recent_transcript.length - 2]?.speaker
          : null;
        if (lastSpeaker && resolvedSpeaker && lastSpeaker !== resolvedSpeaker) {
          state.turn_count++;
          state.last_turn_change_ms = now;
        }
      }
      if (resolvedSpeaker === 'user' && payload?.text && passesUserAttribution) {
        state.transcript_segment_count++;
        state.last_speech_start_ms = now;
        state.user_is_speaking = true;
        analyzeTranscriptText(payload.text, state);
      } else if (resolvedSpeaker === 'other' && payload?.text) {
        // Analyze other speaker's text for turn context (interruptions, disagreement, etc.)
        state.other_speaking_time_total_ms += 2000; // ~2s estimate per caption segment
      }
      break;
    }

    default:
      break;
  }
}

/** Analyze transcript text for all linguistic features (FR-025) */
function analyzeTranscriptText(text: string, state: MeetingState): void {
  // Question detection
  if (text.includes('?') || anyPatternMatches(text, QUESTION_PATTERNS)) {
    state.question_count++;

    if (anyPatternMatches(text, CLARIFYING_QUESTION_PATTERNS)) {
      state.clarifying_question_count++;
    }
  }

  // Summary/recap detection
  if (anyPatternMatches(text, SUMMARY_RECAP_PATTERNS)) {
    state.summary_or_recap_count++;
  }

  // Acknowledgment detection
  if (anyPatternMatches(text, ACKNOWLEDGMENT_PATTERNS)) {
    state.acknowledgment_count++;
  }

  // Hedging language
  if (anyPatternMatches(text, HEDGING_PATTERNS)) {
    state.hedging_hits++;
  }

  // Certainty language
  if (anyPatternMatches(text, CERTAINTY_PATTERNS)) {
    state.certainty_hits++;
  }

  // Loss framing
  if (anyPatternMatches(text, LOSS_FRAME_PATTERNS)) {
    state.loss_frame_hits++;
  }

  // Gain framing
  if (anyPatternMatches(text, GAIN_FRAME_PATTERNS)) {
    state.gain_frame_hits++;
  }

  // Action specificity (owner + verb pattern)
  if (anyPatternMatches(text, ACTION_SPECIFICITY_INDICATORS)) {
    state.action_specificity_hits++;
  }

  // Disagreement detection (sticky — once detected, stays true)
  if (!state.disagreement_detected && anyPatternMatches(text, DISAGREEMENT_PATTERNS)) {
    state.disagreement_detected = true;
  }

  // Option counting (additive per segment)
  const optionMatches = countPatternMatches(text, OPTION_PATTERNS);
  if (optionMatches > 0) {
    state.option_count_presented += optionMatches;
  }

  // Default recommendation (sticky)
  if (!state.default_recommendation_present && anyPatternMatches(text, DEFAULT_RECOMMENDATION_PATTERNS)) {
    state.default_recommendation_present = true;
  }

  // Owner assignment (sticky)
  if (!state.owner_assignment_present && anyPatternMatches(text, OWNER_ASSIGNMENT_PATTERNS)) {
    state.owner_assignment_present = true;
  }

  // Deadline present (sticky)
  if (!state.deadline_present && anyPatternMatches(text, DEADLINE_PATTERNS)) {
    state.deadline_present = true;
  }

  // Evidence reference (sticky)
  if (!state.evidence_reference_present && anyPatternMatches(text, EVIDENCE_REFERENCE_PATTERNS)) {
    state.evidence_reference_present = true;
  }

  // Peer example (sticky)
  if (!state.peer_example_present && anyPatternMatches(text, PEER_EXAMPLE_PATTERNS)) {
    state.peer_example_present = true;
  }

  // Shared goal language (sticky)
  if (!state.shared_goal_language_present && anyPatternMatches(text, SHARED_GOAL_PATTERNS)) {
    state.shared_goal_language_present = true;
  }
}

/**
 * Compute the full feature snapshot from current meeting state.
 * All 22 features from FR-025 plus derived signals.
 */
function computeFeatureSnapshot(state: MeetingState): FeatureSnapshot {
  const meetingDurationMs = Date.now() - new Date(state.started_at).getTime();
  const totalSpeakingMs = state.speaking_time_total_ms + state.other_speaking_time_total_ms;

  // Current continuous speaking (if user is currently speaking)
  let currentContinuousSpeaking = 0;
  if (state.user_is_speaking && state.last_speech_start_ms !== null) {
    currentContinuousSpeaking = (Date.now() - state.last_speech_start_ms) / 1000;
  }

  // Response latency: time since last turn change to now (if user is speaking)
  let responseLatency = 0;
  if (state.last_turn_change_ms !== null && state.last_speech_start_ms !== null) {
    responseLatency = (state.last_speech_start_ms - state.last_turn_change_ms) / 1000;
  }

  // Speaking share
  const speakingShare = totalSpeakingMs > 0
    ? (state.speaking_time_total_ms / totalSpeakingMs) * 100
    : 50;

  // Linguistic scores (0-1): ratio of hits to total transcript segments, capped at 1.0
  const segCount = Math.max(state.transcript_segment_count, 1);
  const hedgingScore = Math.min(state.hedging_hits / segCount, 1.0);
  const certaintyScore = Math.min(state.certainty_hits / segCount, 1.0);
  const lossFrameScore = Math.min(state.loss_frame_hits / segCount, 1.0);
  const gainFrameScore = Math.min(state.gain_frame_hits / segCount, 1.0);
  const actionSpecificityScore = Math.min(state.action_specificity_hits / segCount, 1.0);
  const transcriptWordCount = state.recent_transcript
    .filter(segment => segment.speaker === 'user')
    .reduce((count, segment) => count + segment.text.split(/\s+/).filter(Boolean).length, 0);
  const transcriptVolumeTurns = Math.ceil(transcriptWordCount / 12);
  const activityCount = Math.max(state.turn_count, state.transcript_segment_count, transcriptVolumeTurns);

  return {
    // Timing features
    speaking_time_total_seconds: state.speaking_time_total_ms / 1000,
    speaking_share_percent: speakingShare,
    current_continuous_speaking_seconds: currentContinuousSpeaking,
    // Audio-only capture often sees the user's mic transcript before it can
    // reliably attribute other-speaker captions. Keep law gates alive by using
    // user transcript activity as a fallback conversation activity signal.
    turn_count: activityCount,
    interruption_count: state.interruption_count,
    response_latency_seconds: responseLatency,

    // Engagement features
    question_count: state.question_count,
    clarifying_question_count: state.clarifying_question_count,
    summary_or_recap_count: state.summary_or_recap_count,
    acknowledgment_count: state.acknowledgment_count,

    // Linguistic features (scored 0-1)
    certainty_language_score: certaintyScore,
    hedging_language_score: hedgingScore,
    loss_frame_score: lossFrameScore,
    gain_frame_score: gainFrameScore,
    action_specificity_score: actionSpecificityScore,

    // Structural features (boolean/count)
    option_count_presented: state.option_count_presented,
    default_recommendation_present: state.default_recommendation_present,
    owner_assignment_present: state.owner_assignment_present,
    deadline_present: state.deadline_present,
    evidence_reference_present: state.evidence_reference_present,
    peer_example_present: state.peer_example_present,
    shared_goal_language_present: state.shared_goal_language_present,

    // Derived signals for law evaluation
    disagreement_detected: state.disagreement_detected,
  };
}

/**
 * Create a FeatureObservation record for persistence.
 * Links feature value to evidence (FR-027).
 */
export function createFeatureObservation(
  meetingSessionId: string,
  featureName: FeatureName,
  value: number | boolean,
  windowType: WindowType,
  confidence: number,
  evidenceRefs: EvidenceRef[]
): FeatureObservation {
  return {
    feature_observation_id: uuidv4(),
    meeting_session_id: meetingSessionId,
    feature_name: featureName,
    feature_value: value,
    window_type: windowType,
    computed_at: new Date().toISOString(),
    confidence,
    evidence_refs_json: evidenceRefs,
  };
}

// Export pattern lists for testing
export const PATTERNS = {
  HEDGING_PATTERNS,
  CERTAINTY_PATTERNS,
  LOSS_FRAME_PATTERNS,
  GAIN_FRAME_PATTERNS,
  ACKNOWLEDGMENT_PATTERNS,
  DISAGREEMENT_PATTERNS,
  OPTION_PATTERNS,
  DEFAULT_RECOMMENDATION_PATTERNS,
  OWNER_ASSIGNMENT_PATTERNS,
  DEADLINE_PATTERNS,
  EVIDENCE_REFERENCE_PATTERNS,
  PEER_EXAMPLE_PATTERNS,
  SHARED_GOAL_PATTERNS,
  SUMMARY_RECAP_PATTERNS,
  QUESTION_PATTERNS,
  CLARIFYING_QUESTION_PATTERNS,
  ACTION_SPECIFICITY_INDICATORS,
};
