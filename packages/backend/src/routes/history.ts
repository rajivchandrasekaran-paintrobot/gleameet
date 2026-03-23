import { Router, Response } from 'express';
import { HistoryResponse, TranscriptResponse } from '@gleameet/shared';
import { AuthenticatedRequest } from '../middleware/auth';
import { getUserMeetings, getMeetingTranscript, getMeetingSession } from '../db/queries';

export const historyRouter = Router();

/**
 * GET /history
 * Fetch user meeting history (FR-070 through FR-073)
 */
historyRouter.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const meetings = await getUserMeetings(userId, limit, offset);

    const response: HistoryResponse = {
      meetings: meetings.map(m => ({
        meeting_session_id: m.meeting_session_id,
        user_id: m.user_id,
        platform: m.platform,
        meeting_label: m.meeting_label,
        started_at: m.started_at,
        ended_at: m.ended_at,
        duration_seconds: m.duration_seconds,
        extension_version: m.extension_version,
        status: m.status,
        report_available: m.report_available,
        transcript_available: m.transcript_available,
      })),
    };

    res.status(200).json(response);
  } catch (err) {
    console.error('[HISTORY] Fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch history', code: 'HISTORY_ERROR' });
  }
});

/**
 * GET /history/:meeting_session_id/transcript
 * Fetch saved transcript for a meeting
 */
historyRouter.get('/:meeting_session_id/transcript', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { meeting_session_id } = req.params;

    // Verify the meeting belongs to this user
    const session = await getMeetingSession(meeting_session_id);
    if (!session || session.user_id !== userId) {
      res.status(404).json({ error: 'Meeting not found', code: 'NOT_FOUND' });
      return;
    }

    const transcript = await getMeetingTranscript(meeting_session_id);
    if (!transcript) {
      res.status(404).json({ error: 'Transcript not found', code: 'NOT_FOUND' });
      return;
    }

    res.status(200).json(transcript as TranscriptResponse);
  } catch (err) {
    console.error('[HISTORY] Transcript fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch transcript', code: 'HISTORY_ERROR' });
  }
});
