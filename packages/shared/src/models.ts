// User entity
export interface User {
  user_id: string;           // UUID
  google_subject_id: string;
  email: string;
  display_name: string;
  created_at: string;        // ISO 8601
  status: 'active' | 'suspended' | 'deleted';
  preferences_json: UserPreferences;
}

export interface UserPreferences {
  coaching_intensity: CoachingIntensity;
  enabled_prompt_categories: PromptType[];
  retention: RetentionPreferences;
  global_cooldown_seconds: number;
}

export type CoachingIntensity = 'minimal' | 'standard' | 'high-support';

export interface RetentionPreferences {
  raw_transcript_days: number;
  derived_features_days: number;
  prompts_days: number;
  reports_days: number;
}

// MeetingSession entity
export type SessionStatus = 'pending' | 'active' | 'muted' | 'ended' | 'error';

export interface MeetingSession {
  meeting_session_id: string; // UUID
  user_id: string;
  platform: Platform;
  meeting_label: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  extension_version: string;
  status: SessionStatus;
}

export type Platform = 'google_meet' | 'teams' | 'zoom' | 'slack';

// ConsentRecord entity
export interface ConsentRecord {
  consent_record_id: string;
  meeting_session_id: string;
  user_id: string;
  consent_version: string;
  granted_at: string;
  revoked_at: string | null;
  scope_json: ConsentScope;
}

export interface ConsentScope {
  capture_audio_events: boolean;
  capture_transcript: boolean;
  capture_timing: boolean;
  live_coaching: boolean;
  post_meeting_report: boolean;
  capture_mode?: 'full_meeting' | 'user_voice_only';
  capture_other_participants?: boolean;
}

// RawEvent entity (section 24 normalized event schema)
export type EventType =
  | 'speech_started'
  | 'speech_ended'
  | 'turn_change'
  | 'interruption_candidate'
  | 'transcript_segment'
  | 'prompt_shown'
  | 'prompt_dismissed'
  | 'session_state_changed';

export type EventSource = 'extension' | 'backend' | 'adapter';

export interface RawEvent {
  event_id: string;
  meeting_session_id: string;
  user_id: string;
  platform: Platform;
  event_type: EventType;
  event_time_utc: string;
  source: EventSource;
  capture_confidence: number | null;
  payload: Record<string, unknown>;
}

// FeatureObservation entity
export type WindowType = '30s' | '90s' | 'full_meeting';

export type FeatureName =
  | 'speaking_time_total_seconds'
  | 'speaking_share_percent'
  | 'current_continuous_speaking_seconds'
  | 'turn_count'
  | 'interruption_count'
  | 'response_latency_seconds'
  | 'question_count'
  | 'clarifying_question_count'
  | 'summary_or_recap_count'
  | 'acknowledgment_count'
  | 'certainty_language_score'
  | 'hedging_language_score'
  | 'loss_frame_score'
  | 'gain_frame_score'
  | 'action_specificity_score'
  | 'option_count_presented'
  | 'default_recommendation_present'
  | 'owner_assignment_present'
  | 'deadline_present'
  | 'evidence_reference_present'
  | 'peer_example_present'
  | 'shared_goal_language_present';

export interface FeatureObservation {
  feature_observation_id: string;
  meeting_session_id: string;
  feature_name: FeatureName;
  feature_value: number | boolean;
  window_type: WindowType;
  computed_at: string;
  confidence: number;
  evidence_refs_json: EvidenceRef[];
}

export interface EvidenceRef {
  event_id: string;
  feature_name?: string;
  description?: string;
}

// LawRegistryEntry entity (section 25 schema)
export type LawStatus = 'draft' | 'active' | 'deprecated' | 'disabled';
export type TriggerType = 'event' | 'rolling_window';
export type SourceFamily = 'Kahneman' | 'Cialdini' | 'Thaler';

export interface TriggerCondition {
  feature: string;
  op: 'eq' | 'gt' | 'lt' | 'gte' | 'lte' | 'ne';
  value: number | boolean | string;
}

export interface TriggerLogic {
  all?: TriggerCondition[];
  any?: TriggerCondition[];
}

export interface PromptTemplate {
  type: PromptType;
  text: string;
}

export interface LawRegistryEntry {
  law_id: string;
  version: string;
  status: LawStatus;
  source_family: SourceFamily;
  law_name: string;
  description: string;
  meeting_relevance: string;
  observable_inputs: string[];
  trigger_type: TriggerType;
  trigger_logic: TriggerLogic;
  disconfirming_logic: TriggerLogic;
  prompt_templates_live: PromptTemplate[];
  prompt_templates_post: string[];
  confidence_threshold: number;
  cooldown_seconds: number;
  risk_notes: string[];
  allowed_inferences: string[];
}

// LawTrigger entity
export interface LawTrigger {
  trigger_id: string;
  meeting_session_id: string;
  law_id: string;
  law_version: string;
  triggered_at: string;
  trigger_confidence: number;
  evidence_refs_json: EvidenceRef[];
  feature_snapshot_json: Record<string, number | boolean>;
  suppressed_reason: string | null;
}

// PromptEvent entity
export type PromptType = 'pause' | 'acknowledge' | 'ask' | 'frame' | 'close' | 'reinforce';
export type DisplayState = 'pending' | 'shown' | 'dismissed' | 'expired' | 'muted';

export interface PromptEvent {
  prompt_id: string;
  meeting_session_id: string;
  law_id: string;
  prompt_type: PromptType;
  short_text: string;
  rationale_text: string | null;
  example_phrase: string | null;
  shown_at: string | null;
  expired_at: string | null;
  display_state: DisplayState;
  dismissed_at: string | null;
  confidence: number;
}

// PostMeetingReport entity
export interface PostMeetingReport {
  report_id: string;
  meeting_session_id: string;
  generated_at: string;
  summary_json: ReportSummary;
  insights_json: ReportInsight[];
  strengths_json: string[];
  growth_areas_json: string[];
  timeline_json: TimelineEntry[];
  transcript_with_nudges?: TranscriptWithNudgesEntry[]; // Full annotated transcript
  summary_analysis?: string; // Narrative post-call analysis paragraph
}

// Transcript entry annotated with nudges that fired around the same time
export interface TranscriptWithNudgesEntry {
  type: 'speech' | 'nudge' | 'reinforcement';
  speaker?: 'user' | 'other';
  text: string;
  timestamp_ms: number;
  nudge_law_id?: string; // For nudge entries
}

export interface RecommendedAction {
  action: string;
  reason: string;  // Which behavioral pattern triggered this recommendation
}

export interface ReportSummary {
  meeting_label: string | null;
  duration_seconds: number;
  total_prompts_shown: number;
  laws_triggered: string[];
  recommended_actions: RecommendedAction[];
}

// Aggregated transcript saved at end of meeting
export interface TranscriptEntry {
  speaker: 'user' | 'other';
  text: string;
  start_offset_ms: number;
  end_offset_ms: number;
  event_time_utc: string;
  attribution?: {
    source?: 'mic' | 'tab' | 'caption' | 'web_speech';
    candidate_speaker?: 'user' | 'other';
    final_speaker?: 'user' | 'other';
    passes_user_attribution?: boolean;
    reason?: 'self_declared' | 'trusted_mic_capture' | 'non_user_context' | 'overlap_with_recent_non_user_context';
    overlap_score?: number;
    matched_source?: 'mic' | 'tab' | 'caption' | 'web_speech';
  };
}

export interface MeetingTranscript {
  meeting_session_id: string;
  entries: TranscriptEntry[];
  saved_at: string;
}

export interface ReportInsight {
  category: 'observed_fact' | 'model_interpretation' | 'recommendation';
  text: string;
  evidence_refs: EvidenceRef[];
  law_id: string | null;
}

export interface TimelineEntry {
  time_utc: string;
  offset_seconds: number;
  event_type: 'prompt_shown' | 'law_triggered' | 'session_state_changed';
  details: Record<string, unknown>;
}

// DeletionAudit entity
export type DeletionScope = 'meeting' | 'all_user_data';
export type DeletionStatus = 'requested' | 'in_progress' | 'completed' | 'failed';

export interface DeletionAudit {
  deletion_audit_id: string;
  user_id: string;
  scope: DeletionScope;
  meeting_session_id: string | null; // null for all_user_data scope
  requested_at: string;
  completed_at: string | null;
  status: DeletionStatus;
}
