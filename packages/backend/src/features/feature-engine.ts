import { RawEvent, FeatureObservation, FeatureName, WindowType, EvidenceRef } from '@gleameet/shared';
import { MeetingState } from '../db/redis';
import { v4 as uuidv4 } from 'uuid';

/** Feature snapshot: current values of all features for law evaluation */
export interface FeatureSnapshot {
  [key: string]: number | boolean;
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
  // Sort events by time
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
        // Track other speaking time for share calculation
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
      const payload = event.payload as any;
      if (payload?.speaker === 'user' && payload?.text) {
        analyzeTranscriptText(payload.text, state);
      }
      break;
    }

    default:
      break;
  }
}

/** Analyze transcript text for linguistic features (FR-025) */
function analyzeTranscriptText(text: string, state: MeetingState): void {
  const lower = text.toLowerCase();

  // Question detection
  if (text.includes('?') || /^(what|how|why|when|where|who|could|would|should|do you|can you|is there)/i.test(lower)) {
    state.question_count++;

    // Clarifying question heuristic
    if (/clarif|understand|mean by|could you explain|what do you mean|can you elaborate/i.test(lower)) {
      state.clarifying_question_count++;
    }
  }

  // Summary/recap detection
  if (/so (to|in) (summary|sum|recap)|let me (summarize|recap)|to summarize|in short/i.test(lower)) {
    state.summary_or_recap_count++;
  }

  // Acknowledgment detection
  if (/i (see|understand|hear you|agree|appreciate)|that's a (good|fair|valid) point|you're right|makes sense/i.test(lower)) {
    state.acknowledgment_count++;
  }
}

/**
 * Compute the full feature snapshot from current meeting state.
 * All 22 features from FR-025.
 */
function computeFeatureSnapshot(state: MeetingState): FeatureSnapshot {
  const meetingDurationMs = Date.now() - new Date(state.started_at).getTime();
  const meetingDurationSec = meetingDurationMs / 1000;
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

  return {
    // Timing features
    speaking_time_total_seconds: state.speaking_time_total_ms / 1000,
    speaking_share_percent: speakingShare,
    current_continuous_speaking_seconds: currentContinuousSpeaking,
    turn_count: state.turn_count,
    interruption_count: state.interruption_count,
    response_latency_seconds: responseLatency,

    // Engagement features
    question_count: state.question_count,
    clarifying_question_count: state.clarifying_question_count,
    summary_or_recap_count: state.summary_or_recap_count,
    acknowledgment_count: state.acknowledgment_count,

    // Linguistic features (scored 0-1, require transcript analysis)
    // These use placeholder heuristics; production would use ML classifiers
    certainty_language_score: 0.0,
    hedging_language_score: 0.0,
    loss_frame_score: 0.0,
    gain_frame_score: 0.0,
    action_specificity_score: 0.0,

    // Structural features (boolean/count)
    option_count_presented: 0,
    default_recommendation_present: false,
    owner_assignment_present: false,
    deadline_present: false,
    evidence_reference_present: false,
    peer_example_present: false,
    shared_goal_language_present: false,

    // Derived signals for law evaluation
    disagreement_detected: false,
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
