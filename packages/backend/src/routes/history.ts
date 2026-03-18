import { Router, Response } from 'express';
import { HistoryResponse } from '@gleameet/shared';
import { AuthenticatedRequest } from '../middleware/auth';
import { getUserMeetings } from '../db/queries';

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
      })),
    };

    res.status(200).json(response);
  } catch (err) {
    console.error('[HISTORY] Fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch history', code: 'HISTORY_ERROR' });
  }
});
