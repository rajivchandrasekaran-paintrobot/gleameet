import { RawEvent, Platform, MeetingSession, PromptEvent, PostMeetingReport, LawRegistryEntry, UserPreferences, CoachingIntensity } from './models';

// POST /auth/session
export interface AuthSessionRequest {
  google_id_token: string;
}
export interface AuthSessionResponse {
  session_token: string;
  user_id: string;
  preferences: UserPreferences;
}

// POST /meetings/start
export interface MeetingStartRequest {
  platform: Platform;
  meeting_label?: string;
  extension_version: string;
  consent: {
    consent_version: string;
    scope: {
      capture_audio_events: boolean;
      capture_transcript: boolean;
      capture_timing: boolean;
      live_coaching: boolean;
      post_meeting_report: boolean;
    };
  };
}
export interface MeetingStartResponse {
  meeting_session_id: string;
  session_config: {
    polling_interval_ms: number;
    batch_max_size: number;
    batch_interval_ms: number;
  };
  active_laws: Array<{ law_id: string; law_name: string; version: string }>;
  preferences: UserPreferences;
}

// POST /events/batch
export interface EventsBatchRequest {
  meeting_session_id: string;
  events: RawEvent[];
}
export interface EventsBatchResponse {
  accepted_count: number;
  errors: Array<{ event_id: string; error: string }>;
  prompts?: PromptEvent[];
}

// GET /prompts/poll
export interface PromptPollResponse {
  prompts: PromptEvent[];
}

// POST /prompts/ack
export interface PromptAckRequest {
  prompt_id: string;
  meeting_session_id: string;
  action: 'shown' | 'dismissed' | 'muted';
  timestamp: string;
}
export interface PromptAckResponse {
  ok: boolean;
}

// POST /meetings/end
export interface MeetingEndRequest {
  meeting_session_id: string;
}
export interface MeetingEndResponse {
  report_id: string;
  report_available: boolean;
}

// GET /reports/:meeting_session_id
export type ReportResponse = PostMeetingReport;

// GET /history
export interface HistoryResponse {
  meetings: Array<MeetingSession & { report_available: boolean }>;
}

// DELETE /meetings/:meeting_session_id
export interface DeleteMeetingResponse {
  deletion_audit_id: string;
  status: string;
}

// DELETE /user/data
export interface DeleteUserDataResponse {
  deletion_audit_id: string;
  status: string;
}

// GET /registry/active
export interface RegistryActiveResponse {
  laws: LawRegistryEntry[];
  registry_version: string;
}

// Common error response
export interface ApiErrorResponse {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}
