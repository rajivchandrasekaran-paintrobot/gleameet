import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { MeetingStartRequest, MeetingStartResponse, MeetingEndRequest, MeetingEndResponse, DeleteMeetingResponse } from '@gleameet/shared';
import { AuthenticatedRequest } from '../middleware/auth';
import { initMeetingState, getMeetingState, updateMeetingState } from '../db/redis';
import { loadActiveLaws } from '@gleameet/law-registry';
import { generateReport } from '../services/report-generator';
import { insertMeetingSession, endMeetingSession, insertConsentRecord, deleteMeetingData } from '../db/queries';
import { redis } from '../db/redis';

export const meetingsRouter = Router();

/**
 * POST /meetings/start
 * Create meeting session after consent (FR-005 through FR-011, FR-012 through FR-015)
 */
meetingsRouter.post('/start', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const body = req.body as MeetingStartRequest;

    if (!body.platform || !body.extension_version || !body.consent) {
      res.status(400).json({ error: 'Missing required fields', code: 'INVALID_REQUEST' });
      return;
    }

    const meetingSessionId = uuidv4();

    // Persist to Postgres
    await insertMeetingSession(
      meetingSessionId, userId, body.platform,
      body.extension_version, body.meeting_label || null
    );

    // Record consent
    await insertConsentRecord(
      meetingSessionId, userId,
      body.consent.consent_version, body.consent.scope
    );

    // Initialize meeting state in Redis
    await initMeetingState(meetingSessionId, userId);

    // Load active laws for the session
    const activeLaws = loadActiveLaws();

    const response: MeetingStartResponse = {
      meeting_session_id: meetingSessionId,
      session_config: {
        polling_interval_ms: 2000,
        batch_max_size: 50,
        batch_interval_ms: 3000,
      },
      active_laws: activeLaws.map(l => ({
        law_id: l.law_id,
        law_name: l.law_name,
        version: l.version,
      })),
      preferences: {
        coaching_intensity: 'standard',
        enabled_prompt_categories: ['pause', 'acknowledge', 'ask', 'frame', 'close'],
        retention: {
          raw_transcript_days: 7,
          derived_features_days: 30,
          prompts_days: 90,
          reports_days: 365,
        },
        global_cooldown_seconds: 60,
      },
    };

    console.log(`[MEETING] Started session ${meetingSessionId} for user ${userId}`);
    res.status(201).json(response);
  } catch (err) {
    console.error('[MEETING] Start error:', err);
    res.status(500).json({ error: 'Failed to start meeting', code: 'MEETING_ERROR' });
  }
});

/**
 * POST /meetings/end
 * Close session and trigger report generation (FR-011)
 */
meetingsRouter.post('/end', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { meeting_session_id } = req.body as MeetingEndRequest;

    if (!meeting_session_id) {
      res.status(400).json({ error: 'Missing meeting_session_id', code: 'INVALID_REQUEST' });
      return;
    }

    const state = await getMeetingState(meeting_session_id);
    if (!state) {
      res.status(404).json({ error: 'Meeting session not found', code: 'NOT_FOUND' });
      return;
    }

    // Update state to ended
    state.status = 'ended';
    await updateMeetingState(meeting_session_id, state);

    // Persist end time to Postgres
    await endMeetingSession(meeting_session_id);

    // Generate post-meeting report
    const reportId = await generateReport(meeting_session_id, state);

    const response: MeetingEndResponse = {
      report_id: reportId,
      report_available: true,
    };

    console.log(`[MEETING] Ended session ${meeting_session_id}`);
    res.status(200).json(response);
  } catch (err) {
    console.error('[MEETING] End error:', err);
    res.status(500).json({ error: 'Failed to end meeting', code: 'MEETING_ERROR' });
  }
});

/**
 * DELETE /meetings/:meeting_session_id
 * Delete a single meeting and all associated data (FR-077)
 */
meetingsRouter.delete('/:meeting_session_id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { meeting_session_id } = req.params;
    const userId = req.userId!;

    // Delete from Postgres (cascading delete handles related records)
    const deletionAuditId = await deleteMeetingData(meeting_session_id, userId);

    // Clean up Redis state
    const keys = await redis.keys(`gleameet:meeting:${meeting_session_id}:*`);
    if (keys.length > 0) {
      // Keys already have the prefix from the scan, strip it for del
      await redis.del(...keys.map(k => k.replace(/^gleameet:/, '')));
    }

    const response: DeleteMeetingResponse = {
      deletion_audit_id: deletionAuditId,
      status: 'completed',
    };

    console.log(`[MEETING] Deleted session ${meeting_session_id} for user ${userId}`);
    res.status(200).json(response);
  } catch (err) {
    console.error('[MEETING] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete meeting', code: 'DELETE_ERROR' });
  }
});
