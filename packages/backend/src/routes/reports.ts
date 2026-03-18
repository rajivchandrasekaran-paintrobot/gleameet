import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { getReport } from '../db/queries';

export const reportsRouter = Router();

/**
 * GET /reports/:meeting_session_id
 * Fetch post-meeting report (FR-064 through FR-069)
 */
reportsRouter.get('/:meeting_session_id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { meeting_session_id } = req.params;

    const report = await getReport(meeting_session_id);
    if (!report) {
      res.status(404).json({ error: 'Report not found', code: 'NOT_FOUND' });
      return;
    }

    res.status(200).json(report);
  } catch (err) {
    console.error('[REPORTS] Fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch report', code: 'REPORT_ERROR' });
  }
});
