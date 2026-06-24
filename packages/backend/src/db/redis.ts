import Redis from 'ioredis';

/** Redis client for rolling meeting state + cooldown tracking — supports REDIS_URL (Render) or individual vars (local) */
export const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, {
      keyPrefix: 'gleameet:',
      tls: process.env.REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
      retryStrategy(times: number) {
        return Math.min(times * 50, 2000);
      },
    })
  : new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      keyPrefix: 'gleameet:',
      retryStrategy(times: number) {
        return Math.min(times * 50, 2000);
      },
    });

redis.on('error', (err) => {
  console.error('[REDIS] Connection error:', err.message);
});

// --- Meeting state helpers ---

/** Key for a meeting's rolling state in Redis */
function meetingStateKey(meetingSessionId: string): string {
  return `meeting:${meetingSessionId}:state`;
}

/** Key for law cooldown tracking */
function lawCooldownKey(meetingSessionId: string, lawId: string): string {
  return `meeting:${meetingSessionId}:cooldown:${lawId}`;
}

/** Key for global prompt cooldown */
function globalCooldownKey(meetingSessionId: string): string {
  return `meeting:${meetingSessionId}:global_cooldown`;
}

/** Key for prompt count tracking per intensity window */
function promptCountKey(meetingSessionId: string): string {
  return `meeting:${meetingSessionId}:prompt_count`;
}

/** Key for user speaking state */
function speakingStateKey(meetingSessionId: string): string {
  return `meeting:${meetingSessionId}:speaking`;
}

export interface MeetingState {
  meeting_session_id: string;
  user_id: string;
  status: string;
  started_at: string;
  speaking_time_total_ms: number;
  other_speaking_time_total_ms: number;
  turn_count: number;
  interruption_count: number;
  question_count: number;
  clarifying_question_count: number;
  summary_or_recap_count: number;
  acknowledgment_count: number;
  last_speech_start_ms: number | null;
  last_turn_change_ms: number | null;
  user_is_speaking: boolean;
  prompts_shown_count: number;
  last_prompt_shown_at: string | null;
  last_reinforcement_behavior_count: number; // Tracks positive behaviors since last reinforcement
  events_ingested: number;
  // Linguistic classifier accumulators
  hedging_hits: number;
  certainty_hits: number;
  loss_frame_hits: number;
  gain_frame_hits: number;
  action_specificity_hits: number;
  transcript_segment_count: number;
  disagreement_detected: boolean;
  option_count_presented: number;
  default_recommendation_present: boolean;
  owner_assignment_present: boolean;
  deadline_present: boolean;
  evidence_reference_present: boolean;
  peer_example_present: boolean;
  shared_goal_language_present: boolean;
  // Track law triggers for reports
  law_trigger_ids: string[];
  prompt_ids: string[];
  recent_prompt_law_ids: string[];
  // Rolling buffer of recent transcript segments for LLM nudge personalization
  recent_transcript: Array<{ speaker: 'user' | 'other'; text: string; ts: number }>;
}

/** Initialize meeting state in Redis */
export async function initMeetingState(sessionId: string, userId: string): Promise<void> {
  const state: MeetingState = {
    meeting_session_id: sessionId,
    user_id: userId,
    status: 'active',
    started_at: new Date().toISOString(),
    speaking_time_total_ms: 0,
    other_speaking_time_total_ms: 0,
    turn_count: 0,
    interruption_count: 0,
    question_count: 0,
    clarifying_question_count: 0,
    summary_or_recap_count: 0,
    acknowledgment_count: 0,
    last_speech_start_ms: null,
    last_turn_change_ms: null,
    user_is_speaking: false,
    prompts_shown_count: 0,
    last_prompt_shown_at: null,
    last_reinforcement_behavior_count: 0,
    events_ingested: 0,
    hedging_hits: 0,
    certainty_hits: 0,
    loss_frame_hits: 0,
    gain_frame_hits: 0,
    action_specificity_hits: 0,
    transcript_segment_count: 0,
    disagreement_detected: false,
    option_count_presented: 0,
    default_recommendation_present: false,
    owner_assignment_present: false,
    deadline_present: false,
    evidence_reference_present: false,
    peer_example_present: false,
    shared_goal_language_present: false,
    law_trigger_ids: [],
    prompt_ids: [],
    recent_prompt_law_ids: [],
    recent_transcript: [],
  };
  await redis.set(meetingStateKey(sessionId), JSON.stringify(state), 'EX', 14400); // 4h TTL
}

/** Get current meeting state */
export async function getMeetingState(sessionId: string): Promise<MeetingState | null> {
  const data = await redis.get(meetingStateKey(sessionId));
  return data ? JSON.parse(data) : null;
}

/** Update meeting state */
export async function updateMeetingState(sessionId: string, state: MeetingState): Promise<void> {
  await redis.set(meetingStateKey(sessionId), JSON.stringify(state), 'EX', 14400);
}

/** Set law cooldown */
export async function setLawCooldown(sessionId: string, lawId: string, seconds: number): Promise<void> {
  await redis.set(lawCooldownKey(sessionId, lawId), '1', 'EX', seconds);
}

/** Check if law is on cooldown */
export async function isLawOnCooldown(sessionId: string, lawId: string): Promise<boolean> {
  const val = await redis.get(lawCooldownKey(sessionId, lawId));
  return val !== null;
}

/** Set global prompt cooldown */
export async function setGlobalCooldown(sessionId: string, seconds: number): Promise<void> {
  await redis.set(globalCooldownKey(sessionId), '1', 'EX', seconds);
}

/** Check global cooldown */
export async function isGlobalCooldownActive(sessionId: string): Promise<boolean> {
  const val = await redis.get(globalCooldownKey(sessionId));
  return val !== null;
}

/** Increment and get prompt count for rate limiting (FR-048) */
export async function incrementPromptCount(sessionId: string): Promise<number> {
  const key = promptCountKey(sessionId);
  const count = await redis.incr(key);
  // Set expiry to 30 minutes if this is the first prompt
  if (count === 1) {
    await redis.expire(key, 1800);
  }
  return count;
}

/** Get current prompt count */
export async function getPromptCount(sessionId: string): Promise<number> {
  const val = await redis.get(promptCountKey(sessionId));
  return val ? parseInt(val, 10) : 0;
}

/** Track user speaking state */
export async function setUserSpeaking(sessionId: string, isSpeaking: boolean): Promise<void> {
  await redis.set(speakingStateKey(sessionId), isSpeaking ? '1' : '0', 'EX', 14400);
}

/** Check if user is currently speaking */
export async function isUserSpeaking(sessionId: string): Promise<boolean> {
  const val = await redis.get(speakingStateKey(sessionId));
  return val === '1';
}
