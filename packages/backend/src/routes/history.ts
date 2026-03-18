import { Router, Response } from 'express';
import { HistoryResponse } from '@gleameet/shared';
import { AuthenticatedRequest } from '../middleware/auth';

export const historyRouter = Router();

/**
 * GET /history
 * Fetch user meeting history (FR-070 through FR-073)
 */
historyRouter.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;

    // TODO: Query Postgres for user's meeting sessions with report availability
    const response: HistoryResponse = {
      meetings: [],
    };

    res.status(200).json(response);
  } catch (err) {
    console.error('[HISTORY] Fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch history', code: 'HISTORY_ERROR' });
  }
});
