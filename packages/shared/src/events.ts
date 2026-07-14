import { RawEvent, EventType, Platform, EventSource } from './models';

/** All valid event types per FR-019 */
export const EVENT_TYPES: EventType[] = [
  'speech_started',
  'speech_ended',
  'turn_change',
  'interruption_candidate',
  'transcript_segment',
  'prompt_shown',
  'prompt_dismissed',
  'session_state_changed',
];

/** Validates that a raw event has all required fields per FR-020 */
export function validateRawEvent(event: Partial<RawEvent>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const required: (keyof RawEvent)[] = [
    'event_id', 'meeting_session_id', 'user_id', 'platform',
    'event_type', 'event_time_utc', 'source', 'payload',
  ];
  for (const field of required) {
    if (event[field] === undefined || event[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  if (event.event_type && !EVENT_TYPES.includes(event.event_type)) {
    errors.push(`Invalid event_type: ${event.event_type}`);
  }
  return { valid: errors.length === 0, errors };
}

/** Payload type for transcript_segment events */
export type TranscriptSource = 'mic' | 'tab' | 'caption' | 'web_speech';

export interface TranscriptAttribution {
  source: TranscriptSource;
  candidate_speaker: 'user' | 'other';
  final_speaker: 'user' | 'other';
  passes_user_attribution: boolean;
  reason?: 'self_declared' | 'trusted_mic_capture' | 'non_user_context' | 'overlap_with_recent_non_user_context';
  overlap_score?: number;
  matched_source?: TranscriptSource;
}

export interface TranscriptPayload {
  text: string;
  speaker: 'user' | 'other';
  start_offset_ms: number;
  end_offset_ms: number;
  attribution?: TranscriptAttribution;
}

/** Payload type for speech timing events */
export interface SpeechTimingPayload {
  speaker: 'user' | 'other';
  offset_ms: number;
}

/** Payload type for turn_change events */
export interface TurnChangePayload {
  from_speaker: 'user' | 'other';
  to_speaker: 'user' | 'other';
  gap_ms: number;
}

/** Payload for session_state_changed */
export interface SessionStatePayload {
  previous_state: string;
  new_state: string;
  reason?: string;
}
