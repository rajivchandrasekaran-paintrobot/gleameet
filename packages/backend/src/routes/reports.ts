import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { PostMeetingReport } from '@gleameet/shared';

export const reportsRouter = Router();

/**
 * GET /reports/:meeting_session_id
 * Fetch post-meeting report (FR-064 through FR-069)
 */
reportsRouter.get('/:meeting_session_id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { meeting_session_id } = req.params;

    // TODO: Fetch from Postgres post_meeting_reports table
    // For scaffold, return a placeholder indicating report generation
    const report: PostMeetingReport = {
      report_id: `report-${meeting_session_id}`,
      meeting_session_id,
      generated_at: new Date().toISOString(),
      summary_json: {
        meeting_label: null,
        duration_seconds: 0,
        total_prompts_shown: 0,
        laws_triggered: [],
        recommended_actions: [],
      },
      insights_json: [],
      strengths_json: [],
      growth_areas_json: [],
      timeline_json: [],
    };

    res.status(200).json(report);
  } catch (err) {
    console.error('[REPORTS] Fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch report', code: 'REPORT_ERROR' });
  }
});
