import { PostMeetingReport, ReportInsight, TimelineEntry } from '@gleameet/shared';
import { MeetingState } from '../db/redis';
import { v4 as uuidv4 } from 'uuid';

/**
 * Generate a post-meeting report from the meeting state.
 * Implements FR-064 through FR-069.
 * In production, this would also query Postgres for full event history,
 * feature observations, and prompt records.
 */
export async function generateReport(
  meetingSessionId: string,
  state: MeetingState
): Promise<string> {
  const reportId = uuidv4();
  const durationSeconds = (Date.now() - new Date(state.started_at).getTime()) / 1000;

  // FR-066: Distinguish observed facts, model interpretations, and recommendations
  const insights: ReportInsight[] = [];

  // Observed facts
  insights.push({
    category: 'observed_fact',
    text: `You spoke for ${Math.round(state.speaking_time_total_ms / 1000)} seconds during the meeting.`,
    evidence_refs: [{ event_id: meetingSessionId, description: 'Aggregate speaking time' }],
    law_id: null,
  });

  if (state.turn_count > 0) {
    insights.push({
      category: 'observed_fact',
      text: `There were ${state.turn_count} turn changes during the meeting.`,
      evidence_refs: [{ event_id: meetingSessionId, description: 'Turn count' }],
      law_id: null,
    });
  }

  if (state.question_count > 0) {
    insights.push({
      category: 'observed_fact',
      text: `You asked ${state.question_count} questions during the meeting.`,
      evidence_refs: [{ event_id: meetingSessionId, description: 'Question count' }],
      law_id: null,
    });
  }

  if (state.interruption_count > 0) {
    insights.push({
      category: 'observed_fact',
      text: `${state.interruption_count} potential interruptions were detected.`,
      evidence_refs: [{ event_id: meetingSessionId, description: 'Interruption count' }],
      law_id: null,
    });
  }

  // Strengths and growth areas based on observed behavior
  const strengths: string[] = [];
  const growthAreas: string[] = [];

  if (state.question_count >= 3) {
    strengths.push('Active questioning throughout the meeting');
  }
  if (state.acknowledgment_count >= 2) {
    strengths.push('Good acknowledgment of others\' contributions');
  }
  if (state.summary_or_recap_count >= 1) {
    strengths.push('Used summaries to reinforce key points');
  }

  if (state.interruption_count >= 3) {
    growthAreas.push('Consider allowing others to finish before responding');
  }
  if (state.question_count === 0) {
    growthAreas.push('Try asking more clarifying questions');
  }
  if (state.acknowledgment_count === 0) {
    growthAreas.push('Acknowledge others\' points before offering your perspective');
  }

  // Recommended actions (FR-065)
  const recommendedActions: string[] = [];
  if (growthAreas.length > 0) {
    recommendedActions.push(`Focus on: ${growthAreas[0]}`);
  }
  recommendedActions.push('Review your prompt history to see which behavioral patterns recur');

  const report: PostMeetingReport = {
    report_id: reportId,
    meeting_session_id: meetingSessionId,
    generated_at: new Date().toISOString(),
    summary_json: {
      meeting_label: null,
      duration_seconds: Math.round(durationSeconds),
      total_prompts_shown: state.prompts_shown_count,
      laws_triggered: [], // TODO: populate from trigger history
      recommended_actions: recommendedActions,
    },
    insights_json: insights,
    strengths_json: strengths,
    growth_areas_json: growthAreas,
    timeline_json: [], // TODO: build from event/prompt history
  };

  // TODO: Persist report to Postgres post_meeting_reports table
  console.log(`[REPORT] Generated report ${reportId} for session ${meetingSessionId}`);

  return reportId;
}
