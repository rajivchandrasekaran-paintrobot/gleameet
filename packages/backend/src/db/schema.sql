-- GleaMeet v1 Database Schema
-- All entities from SRS section 15

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (FR-001 through FR-004)
CREATE TABLE IF NOT EXISTS users (
    user_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    google_subject_id VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
    preferences_json JSONB NOT NULL DEFAULT '{
        "coaching_intensity": "standard",
        "enabled_prompt_categories": ["pause", "acknowledge", "ask", "frame", "close"],
        "retention": {
            "raw_transcript_days": 7,
            "derived_features_days": 30,
            "prompts_days": 90,
            "reports_days": 365
        },
        "global_cooldown_seconds": 60
    }'::jsonb
);

-- Meeting sessions (FR-005 through FR-011)
CREATE TABLE IF NOT EXISTS meeting_sessions (
    meeting_session_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    platform VARCHAR(20) NOT NULL CHECK (platform IN ('google_meet', 'teams', 'zoom', 'slack')),
    meeting_label VARCHAR(500),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    duration_seconds INTEGER,
    extension_version VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'muted', 'ended', 'error'))
);
CREATE INDEX IF NOT EXISTS idx_meeting_sessions_user ON meeting_sessions(user_id);

-- Consent records (FR-012 through FR-015)
CREATE TABLE IF NOT EXISTS consent_records (
    consent_record_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meeting_session_id UUID UNIQUE NOT NULL REFERENCES meeting_sessions(meeting_session_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    consent_version VARCHAR(20) NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    scope_json JSONB NOT NULL
);

-- Raw events (FR-016 through FR-022, section 24 schema)
CREATE TABLE IF NOT EXISTS raw_events (
    event_id UUID PRIMARY KEY,
    meeting_session_id UUID NOT NULL REFERENCES meeting_sessions(meeting_session_id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    platform VARCHAR(20) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    event_time_utc TIMESTAMPTZ NOT NULL,
    source VARCHAR(20) NOT NULL CHECK (source IN ('extension', 'backend', 'adapter')),
    capture_confidence REAL,
    payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raw_events_session ON raw_events(meeting_session_id, event_time_utc);
CREATE INDEX IF NOT EXISTS idx_raw_events_type ON raw_events(meeting_session_id, event_type);

-- Feature observations (FR-023 through FR-029)
CREATE TABLE IF NOT EXISTS feature_observations (
    feature_observation_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meeting_session_id UUID NOT NULL REFERENCES meeting_sessions(meeting_session_id) ON DELETE CASCADE,
    feature_name VARCHAR(100) NOT NULL,
    feature_value REAL NOT NULL,
    window_type VARCHAR(20) NOT NULL CHECK (window_type IN ('30s', '90s', 'full_meeting')),
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confidence REAL NOT NULL,
    evidence_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_feature_obs_session ON feature_observations(meeting_session_id, feature_name, window_type);

-- Law registry entries stored in DB for version tracking (FR-030 through FR-036)
CREATE TABLE IF NOT EXISTS law_registry_entries (
    law_id VARCHAR(20) NOT NULL,
    version VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('draft', 'active', 'deprecated', 'disabled')),
    source_family VARCHAR(50) NOT NULL,
    law_name VARCHAR(200) NOT NULL,
    definition_json JSONB NOT NULL,
    PRIMARY KEY (law_id, version)
);

-- Law triggers (FR-037 through FR-043)
CREATE TABLE IF NOT EXISTS law_triggers (
    trigger_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meeting_session_id UUID NOT NULL REFERENCES meeting_sessions(meeting_session_id) ON DELETE CASCADE,
    law_id VARCHAR(20) NOT NULL,
    law_version VARCHAR(20) NOT NULL,
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    trigger_confidence REAL NOT NULL,
    evidence_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    feature_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    suppressed_reason VARCHAR(200)
);
CREATE INDEX IF NOT EXISTS idx_law_triggers_session ON law_triggers(meeting_session_id, triggered_at);

-- Prompt events (FR-044 through FR-063)
CREATE TABLE IF NOT EXISTS prompt_events (
    prompt_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meeting_session_id UUID NOT NULL REFERENCES meeting_sessions(meeting_session_id) ON DELETE CASCADE,
    law_id VARCHAR(20) NOT NULL,
    prompt_type VARCHAR(20) NOT NULL CHECK (prompt_type IN ('pause', 'acknowledge', 'ask', 'frame', 'close')),
    short_text VARCHAR(100) NOT NULL,
    rationale_text VARCHAR(100),
    example_phrase VARCHAR(200),
    shown_at TIMESTAMPTZ,
    expired_at TIMESTAMPTZ,
    display_state VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (display_state IN ('pending', 'shown', 'dismissed', 'expired', 'muted')),
    dismissed_at TIMESTAMPTZ,
    confidence REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_events_session ON prompt_events(meeting_session_id, shown_at);

-- Post-meeting reports (FR-064 through FR-069)
CREATE TABLE IF NOT EXISTS post_meeting_reports (
    report_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meeting_session_id UUID UNIQUE NOT NULL REFERENCES meeting_sessions(meeting_session_id) ON DELETE CASCADE,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    summary_json JSONB NOT NULL,
    insights_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    strengths_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    growth_areas_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    timeline_json JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- Deletion audit (FR-077 through FR-078)
CREATE TABLE IF NOT EXISTS deletion_audits (
    deletion_audit_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    scope VARCHAR(20) NOT NULL CHECK (scope IN ('meeting', 'all_user_data')),
    meeting_session_id UUID,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'in_progress', 'completed', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_deletion_audits_user ON deletion_audits(user_id);
