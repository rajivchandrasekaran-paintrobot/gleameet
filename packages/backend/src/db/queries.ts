import { pool } from './pool';
import { v4 as uuidv4 } from 'uuid';
import type {
  MeetingSession, ConsentRecord, RawEvent, FeatureObservation,
  LawTrigger, PromptEvent, PostMeetingReport, DeletionAudit,
  TranscriptEntry, MeetingTranscript,
} from '@gleameet/shared';

// --- Users ---

export async function upsertUser(
  googleSubjectId: string,
  email: string,
  displayName: string
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (google_subject_id, email, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (google_subject_id) DO UPDATE SET email = $2, display_name = $3
     RETURNING user_id`,
    [googleSubjectId, email, displayName]
  );
  return result.rows[0].user_id;
}

export async function getUserByGoogleSubject(googleSubjectId: string) {
  const result = await pool.query(
    'SELECT * FROM users WHERE google_subject_id = $1 AND status = $2',
    [googleSubjectId, 'active']
  );
  return result.rows[0] || null;
}

export async function getUserById(userId: string) {
  const result = await pool.query(
    'SELECT * FROM users WHERE user_id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

// --- Meeting Sessions ---

export async function insertMeetingSession(
  meetingSessionId: string,
  userId: string,
  platform: string,
  extensionVersion: string,
  meetingLabel: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO meeting_sessions
     (meeting_session_id, user_id, platform, extension_version, meeting_label, status)
     VALUES ($1, $2, $3, $4, $5, 'active')`,
    [meetingSessionId, userId, platform, extensionVersion, meetingLabel]
  );
}

export async function endMeetingSession(meetingSessionId: string): Promise<void> {
  await pool.query(
    `UPDATE meeting_sessions
     SET ended_at = NOW(),
         duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::integer,
         status = 'ended'
     WHERE meeting_session_id = $1`,
    [meetingSessionId]
  );
}

export async function getMeetingSession(meetingSessionId: string): Promise<MeetingSession | null> {
  const result = await pool.query(
    'SELECT * FROM meeting_sessions WHERE meeting_session_id = $1',
    [meetingSessionId]
  );
  return result.rows[0] || null;
}

export async function getUserMeetings(userId: string, limit = 50, offset = 0) {
  const result = await pool.query(
    `SELECT ms.*,
            CASE WHEN pmr.report_id IS NOT NULL THEN true ELSE false END AS report_available,
            CASE WHEN mt.meeting_session_id IS NOT NULL THEN true ELSE false END AS transcript_available
     FROM meeting_sessions ms
     LEFT JOIN post_meeting_reports pmr ON ms.meeting_session_id = pmr.meeting_session_id
     LEFT JOIN meeting_transcripts mt ON ms.meeting_session_id = mt.meeting_session_id
     WHERE ms.user_id = $1
     ORDER BY ms.started_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return result.rows;
}

// --- Consent Records ---

export async function insertConsentRecord(
  meetingSessionId: string,
  userId: string,
  consentVersion: string,
  scopeJson: object
): Promise<string> {
  const id = uuidv4();
  await pool.query(
    `INSERT INTO consent_records
     (consent_record_id, meeting_session_id, user_id, consent_version, scope_json)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, meetingSessionId, userId, consentVersion, JSON.stringify(scopeJson)]
  );
  return id;
}

// --- Raw Events ---

export async function insertRawEvents(events: RawEvent[]): Promise<void> {
  if (events.length === 0) return;

  const values: any[] = [];
  const placeholders: string[] = [];

  events.forEach((e, i) => {
    const offset = i * 8;
    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`);
    values.push(
      e.event_id, e.meeting_session_id, e.user_id, e.platform,
      e.event_type, e.event_time_utc, e.source, JSON.stringify(e.payload)
    );
  });

  await pool.query(
    `INSERT INTO raw_events
     (event_id, meeting_session_id, user_id, platform, event_type, event_time_utc, source, payload_json)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (event_id) DO NOTHING`,
    values
  );
}

// --- Feature Observations ---

export async function insertFeatureObservations(observations: FeatureObservation[]): Promise<void> {
  if (observations.length === 0) return;

  const values: any[] = [];
  const placeholders: string[] = [];

  observations.forEach((o, i) => {
    const offset = i * 7;
    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`);
    values.push(
      o.feature_observation_id, o.meeting_session_id, o.feature_name,
      typeof o.feature_value === 'boolean' ? (o.feature_value ? 1.0 : 0.0) : o.feature_value,
      o.window_type, o.computed_at, JSON.stringify(o.evidence_refs_json)
    );
  });

  await pool.query(
    `INSERT INTO feature_observations
     (feature_observation_id, meeting_session_id, feature_name, feature_value, window_type, computed_at, evidence_refs_json)
     VALUES ${placeholders.join(', ')}`,
    values
  );
}

// --- Law Triggers ---

export async function insertLawTrigger(trigger: LawTrigger): Promise<void> {
  await pool.query(
    `INSERT INTO law_triggers
     (trigger_id, meeting_session_id, law_id, law_version, triggered_at,
      trigger_confidence, evidence_refs_json, feature_snapshot_json, suppressed_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      trigger.trigger_id, trigger.meeting_session_id, trigger.law_id,
      trigger.law_version, trigger.triggered_at, trigger.trigger_confidence,
      JSON.stringify(trigger.evidence_refs_json), JSON.stringify(trigger.feature_snapshot_json),
      trigger.suppressed_reason,
    ]
  );
}

export async function getLawTriggersForSession(meetingSessionId: string): Promise<LawTrigger[]> {
  const result = await pool.query(
    'SELECT * FROM law_triggers WHERE meeting_session_id = $1 ORDER BY triggered_at',
    [meetingSessionId]
  );
  return result.rows.map(r => ({
    ...r,
    evidence_refs_json: r.evidence_refs_json,
    feature_snapshot_json: r.feature_snapshot_json,
  }));
}

// --- Prompt Events ---

export async function insertPromptEvent(prompt: PromptEvent): Promise<void> {
  await pool.query(
    `INSERT INTO prompt_events
     (prompt_id, meeting_session_id, law_id, prompt_type, short_text,
      rationale_text, example_phrase, shown_at, expired_at, display_state, dismissed_at, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      prompt.prompt_id, prompt.meeting_session_id, prompt.law_id,
      prompt.prompt_type, prompt.short_text, prompt.rationale_text,
      prompt.example_phrase, prompt.shown_at, prompt.expired_at,
      prompt.display_state, prompt.dismissed_at, prompt.confidence,
    ]
  );
}

export async function updatePromptDisplayState(
  promptId: string,
  displayState: string,
  dismissedAt: string | null
): Promise<void> {
  await pool.query(
    `UPDATE prompt_events SET display_state = $2, dismissed_at = $3, shown_at = COALESCE(shown_at, NOW())
     WHERE prompt_id = $1`,
    [promptId, displayState, dismissedAt]
  );
}

export async function getPromptsForSession(meetingSessionId: string): Promise<PromptEvent[]> {
  const result = await pool.query(
    'SELECT * FROM prompt_events WHERE meeting_session_id = $1 ORDER BY shown_at',
    [meetingSessionId]
  );
  return result.rows;
}

// --- Post-Meeting Reports ---

export async function insertReport(report: PostMeetingReport): Promise<void> {
  await pool.query(
    `INSERT INTO post_meeting_reports
     (report_id, meeting_session_id, generated_at, summary_json, insights_json,
      strengths_json, growth_areas_json, timeline_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      report.report_id, report.meeting_session_id, report.generated_at,
      JSON.stringify(report.summary_json), JSON.stringify(report.insights_json),
      JSON.stringify(report.strengths_json), JSON.stringify(report.growth_areas_json),
      JSON.stringify(report.timeline_json),
    ]
  );
}

export async function getReport(meetingSessionId: string): Promise<PostMeetingReport | null> {
  const result = await pool.query(
    'SELECT * FROM post_meeting_reports WHERE meeting_session_id = $1',
    [meetingSessionId]
  );
  return result.rows[0] || null;
}

// --- Deletion ---

export async function deleteMeetingData(meetingSessionId: string, userId: string): Promise<string> {
  const client = await pool.connect();
  const auditId = uuidv4();
  try {
    await client.query('BEGIN');

    // Cascading delete handles raw_events, feature_observations, law_triggers,
    // prompt_events, consent_records, post_meeting_reports
    await client.query(
      'DELETE FROM meeting_sessions WHERE meeting_session_id = $1 AND user_id = $2',
      [meetingSessionId, userId]
    );

    // Create audit record
    await client.query(
      `INSERT INTO deletion_audits
       (deletion_audit_id, user_id, scope, meeting_session_id, completed_at, status)
       VALUES ($1, $2, 'meeting', $3, NOW(), 'completed')`,
      [auditId, userId, meetingSessionId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return auditId;
}

export async function deleteAllUserData(userId: string): Promise<string> {
  const client = await pool.connect();
  const auditId = uuidv4();
  try {
    await client.query('BEGIN');

    // Cascading delete from users table removes all meeting_sessions and their children
    await client.query(
      "UPDATE users SET status = 'deleted' WHERE user_id = $1",
      [userId]
    );

    // Delete all meetings (cascade handles children)
    await client.query(
      'DELETE FROM meeting_sessions WHERE user_id = $1',
      [userId]
    );

    // Create audit record
    await client.query(
      `INSERT INTO deletion_audits
       (deletion_audit_id, user_id, scope, completed_at, status)
       VALUES ($1, $2, 'all_user_data', NOW(), 'completed')`,
      [auditId, userId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return auditId;
}

// --- Meeting Transcripts ---

/** Fetch transcript_segment events for a session, ordered by time. */
export async function getTranscriptSegmentsForSession(
  meetingSessionId: string
): Promise<TranscriptEntry[]> {
  const result = await pool.query(
    `SELECT payload_json, event_time_utc
     FROM raw_events
     WHERE meeting_session_id = $1 AND event_type = 'transcript_segment'
     ORDER BY event_time_utc ASC`,
    [meetingSessionId]
  );
  return result.rows.map(r => ({
    speaker: r.payload_json.speaker || 'user',
    text: r.payload_json.text || '',
    start_offset_ms: r.payload_json.start_offset_ms || 0,
    end_offset_ms: r.payload_json.end_offset_ms || 0,
    event_time_utc: r.event_time_utc,
  }));
}

/** Save aggregated transcript for a meeting session. */
export async function insertMeetingTranscript(
  meetingSessionId: string,
  entries: TranscriptEntry[]
): Promise<void> {
  await pool.query(
    `INSERT INTO meeting_transcripts (meeting_session_id, transcript_json, saved_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (meeting_session_id) DO UPDATE SET transcript_json = $2, saved_at = NOW()`,
    [meetingSessionId, JSON.stringify(entries)]
  );
}

/** Retrieve saved transcript for a meeting session. */
export async function getMeetingTranscript(
  meetingSessionId: string
): Promise<MeetingTranscript | null> {
  const result = await pool.query(
    'SELECT * FROM meeting_transcripts WHERE meeting_session_id = $1',
    [meetingSessionId]
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    meeting_session_id: row.meeting_session_id,
    entries: row.transcript_json,
    saved_at: row.saved_at,
  };
}

// --- Retention Cleanup ---

export async function cleanupExpiredData(retentionDays: {
  raw_transcript: number;
  derived_features: number;
  prompts: number;
  reports: number;
}): Promise<{ raw_events: number; features: number; prompts: number; reports: number }> {
  const now = new Date();

  const rawCutoff = new Date(now.getTime() - retentionDays.raw_transcript * 86400000).toISOString();
  const featureCutoff = new Date(now.getTime() - retentionDays.derived_features * 86400000).toISOString();
  const promptCutoff = new Date(now.getTime() - retentionDays.prompts * 86400000).toISOString();
  const reportCutoff = new Date(now.getTime() - retentionDays.reports * 86400000).toISOString();

  const r1 = await pool.query(
    'DELETE FROM raw_events WHERE event_time_utc < $1', [rawCutoff]
  );
  const r2 = await pool.query(
    'DELETE FROM feature_observations WHERE computed_at < $1', [featureCutoff]
  );
  const r3 = await pool.query(
    'DELETE FROM prompt_events WHERE shown_at < $1', [promptCutoff]
  );
  const r4 = await pool.query(
    'DELETE FROM post_meeting_reports WHERE generated_at < $1', [reportCutoff]
  );

  return {
    raw_events: r1.rowCount || 0,
    features: r2.rowCount || 0,
    prompts: r3.rowCount || 0,
    reports: r4.rowCount || 0,
  };
}
