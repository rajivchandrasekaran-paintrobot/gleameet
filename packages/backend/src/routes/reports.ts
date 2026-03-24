import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { getReport, getMeetingTranscript, getPromptsForSession } from '../db/queries';
import { pool } from '../db/pool';
import { TranscriptWithNudgesEntry } from '@gleameet/shared';

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

    // Backfill transcript_with_nudges on-the-fly if missing (older reports)
    if (!report.transcript_with_nudges || report.transcript_with_nudges.length === 0) {
      try {
        const [savedTranscript, prompts] = await Promise.all([
          getMeetingTranscript(meeting_session_id),
          getPromptsForSession(meeting_session_id),
        ]);

        if (savedTranscript?.entries && savedTranscript.entries.length > 0) {
          const meetingStartMs = new Date(report.generated_at).getTime() - (report.summary_json.duration_seconds * 1000);

          const speechEntries: TranscriptWithNudgesEntry[] = savedTranscript.entries.map(e => ({
            type: 'speech' as const,
            speaker: e.speaker,
            text: e.text,
            timestamp_ms: e.start_offset_ms,
          }));

          const nudgeEntries: TranscriptWithNudgesEntry[] = prompts
            .filter(p => p.shown_at)
            .map(p => ({
              type: (p.law_id === 'REINFORCE' ? 'reinforcement' : 'nudge') as 'nudge' | 'reinforcement',
              text: p.rationale_text ? `${p.short_text} — ${p.rationale_text}` : p.short_text,
              timestamp_ms: new Date(p.shown_at!).getTime() - meetingStartMs,
              nudge_law_id: p.law_id,
            }));

          const merged = [...speechEntries, ...nudgeEntries].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
          report.transcript_with_nudges = merged;

          // Persist so next fetch is fast
          pool.query(
            'UPDATE post_meeting_reports SET transcript_with_nudges = $1 WHERE meeting_session_id = $2',
            [JSON.stringify(merged), meeting_session_id]
          ).catch(() => {});
        }
      } catch (backfillErr) {
        console.warn('[REPORTS] Transcript backfill failed:', (backfillErr as Error).message);
      }
    }

    res.status(200).json(report);
  } catch (err) {
    console.error('[REPORTS] Fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch report', code: 'REPORT_ERROR' });
  }
});
