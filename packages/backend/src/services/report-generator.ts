import { PostMeetingReport, ReportInsight, TimelineEntry } from '@gleameet/shared';
import { MeetingState } from '../db/redis';
import { getLawTriggersForSession, getPromptsForSession, insertReport } from '../db/queries';
import { loadLawById } from '@gleameet/law-registry';
import { v4 as uuidv4 } from 'uuid';

/**
 * Generate a post-meeting report from the meeting state.
 * Implements FR-064 through FR-069.
 * Uses rule-based templates (not LLM).
 */
export async function generateReport(
  meetingSessionId: string,
  state: MeetingState
): Promise<string> {
  const reportId = uuidv4();
  const durationSeconds = (Date.now() - new Date(state.started_at).getTime()) / 1000;

  // Fetch trigger and prompt history from Postgres
  const triggers = await getLawTriggersForSession(meetingSessionId).catch(() => []);
  const prompts = await getPromptsForSession(meetingSessionId).catch(() => []);

  // FR-066: Distinguish observed facts, model interpretations, and recommendations
  const insights: ReportInsight[] = [];

  // --- Observed facts ---
  insights.push({
    category: 'observed_fact',
    text: `You spoke for ${Math.round(state.speaking_time_total_ms / 1000)} seconds during the meeting.`,
    evidence_refs: [{ event_id: meetingSessionId, description: 'Aggregate speaking time' }],
    law_id: null,
  });

  const totalMs = state.speaking_time_total_ms + state.other_speaking_time_total_ms;
  if (totalMs > 0) {
    const sharePercent = Math.round((state.speaking_time_total_ms / totalMs) * 100);
    insights.push({
      category: 'observed_fact',
      text: `Your speaking share was approximately ${sharePercent}% of the conversation.`,
      evidence_refs: [{ event_id: meetingSessionId, description: 'Speaking share calculation' }],
      law_id: null,
    });
  }

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
      text: `You asked ${state.question_count} questions${state.clarifying_question_count > 0 ? ` (${state.clarifying_question_count} clarifying)` : ''}.`,
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

  if (state.acknowledgment_count > 0) {
    insights.push({
      category: 'observed_fact',
      text: `You acknowledged others' contributions ${state.acknowledgment_count} times.`,
      evidence_refs: [{ event_id: meetingSessionId, description: 'Acknowledgment count' }],
      law_id: null,
    });
  }

  if (state.summary_or_recap_count > 0) {
    insights.push({
      category: 'observed_fact',
      text: `You summarized or recapped ${state.summary_or_recap_count} times.`,
      evidence_refs: [{ event_id: meetingSessionId, description: 'Summary/recap count' }],
      law_id: null,
    });
  }

  // --- Model interpretations from law triggers ---
  const lawTriggerCounts = new Map<string, number>();
  for (const t of triggers) {
    lawTriggerCounts.set(t.law_id, (lawTriggerCounts.get(t.law_id) || 0) + 1);
  }

  for (const [lawId, count] of lawTriggerCounts) {
    const law = loadLawById(lawId);
    if (!law) continue;
    insights.push({
      category: 'model_interpretation',
      text: `${law.law_name} was triggered ${count} time${count > 1 ? 's' : ''}: ${law.meeting_relevance}`,
      evidence_refs: triggers
        .filter(t => t.law_id === lawId)
        .slice(0, 3)
        .map(t => ({ event_id: t.trigger_id, description: `Confidence: ${t.trigger_confidence.toFixed(2)}` })),
      law_id: lawId,
    });
  }

  // --- Strengths (top 3): laws NOT triggered repeatedly = user doing well ---
  const strengths: string[] = [];

  if (state.question_count >= 3) {
    strengths.push('Active questioning throughout the meeting — shows engagement and curiosity.');
  }
  if (state.acknowledgment_count >= 2) {
    strengths.push('Good acknowledgment of others\' contributions — builds trust and rapport.');
  }
  if (state.summary_or_recap_count >= 1) {
    strengths.push('Used summaries to reinforce key points — improves alignment and clarity.');
  }
  if (state.owner_assignment_present) {
    strengths.push('Assigned clear ownership for action items — drives accountability.');
  }
  if (state.deadline_present) {
    strengths.push('Set explicit deadlines — promotes follow-through.');
  }
  if (state.evidence_reference_present) {
    strengths.push('Referenced data or evidence — strengthens persuasive arguments.');
  }
  if (state.shared_goal_language_present) {
    strengths.push('Used shared goal language — fosters collaboration and unity.');
  }

  // If we have law data, add strength for laws with low trigger counts
  const allLawIds = Array.from(new Set(triggers.map(t => t.law_id)));
  if (triggers.length > 0) {
    const lowTriggerLaws = allLawIds
      .filter(id => (lawTriggerCounts.get(id) || 0) <= 1)
      .slice(0, 2);
    for (const lawId of lowTriggerLaws) {
      const law = loadLawById(lawId);
      if (law) {
        strengths.push(`Minimal ${law.law_name} triggers — good awareness of ${law.description.toLowerCase().slice(0, 60)}.`);
      }
    }
  }

  // --- Growth areas (top 3): laws triggered most often ---
  const growthAreas: string[] = [];

  const sortedLaws = Array.from(lawTriggerCounts.entries())
    .sort((a, b) => b[1] - a[1]);

  for (const [lawId, count] of sortedLaws.slice(0, 3)) {
    if (count < 2) continue;
    const law = loadLawById(lawId);
    if (!law && !law) continue;
    if (law) {
      growthAreas.push(`${law.law_name} triggered ${count} times — consider: ${law.prompt_templates_post[0] || law.meeting_relevance}`);
    }
  }

  if (state.interruption_count >= 3) {
    growthAreas.push('Consider allowing others to finish before responding — reduces perceived dominance.');
  }
  if (state.question_count === 0) {
    growthAreas.push('Try asking more clarifying questions — deepens understanding and shows engagement.');
  }
  if (state.acknowledgment_count === 0) {
    growthAreas.push('Acknowledge others\' points before offering your perspective — builds psychological safety.');
  }

  // --- Recommended actions (FR-065) ---
  const recommendedActions: string[] = [];

  if (growthAreas.length > 0) {
    recommendedActions.push(`Focus on: ${growthAreas[0].split(' — ')[0]}`);
  }
  if (state.hedging_hits > state.transcript_segment_count * 0.3) {
    recommendedActions.push('Practice using more decisive language to project confidence.');
  }
  if (state.certainty_hits > state.transcript_segment_count * 0.4) {
    recommendedActions.push('Balance certainty with openness — leave room for others\' perspectives.');
  }
  if (!state.owner_assignment_present && !state.deadline_present) {
    recommendedActions.push('Close meetings with clear owner assignments and deadlines for action items.');
  }
  recommendedActions.push('Review your prompt history to see which behavioral patterns recur.');

  // --- Build timeline ---
  const timeline: TimelineEntry[] = [];
  const sessionStart = new Date(state.started_at).getTime();

  for (const trigger of triggers) {
    const time = new Date(trigger.triggered_at);
    timeline.push({
      time_utc: trigger.triggered_at,
      offset_seconds: Math.round((time.getTime() - sessionStart) / 1000),
      event_type: 'law_triggered',
      details: {
        law_id: trigger.law_id,
        confidence: trigger.trigger_confidence,
        law_name: loadLawById(trigger.law_id)?.law_name || trigger.law_id,
      },
    });
  }

  for (const prompt of prompts) {
    if (prompt.shown_at) {
      const time = new Date(prompt.shown_at);
      timeline.push({
        time_utc: prompt.shown_at,
        offset_seconds: Math.round((time.getTime() - sessionStart) / 1000),
        event_type: 'prompt_shown',
        details: {
          prompt_id: prompt.prompt_id,
          law_id: prompt.law_id,
          prompt_type: prompt.prompt_type,
          text: prompt.short_text,
          display_state: prompt.display_state,
        },
      });
    }
  }

  // Sort timeline by offset
  timeline.sort((a, b) => a.offset_seconds - b.offset_seconds);

  // --- Build and persist report ---
  const lawsTriggered = Array.from(lawTriggerCounts.keys());

  const report: PostMeetingReport = {
    report_id: reportId,
    meeting_session_id: meetingSessionId,
    generated_at: new Date().toISOString(),
    summary_json: {
      meeting_label: null,
      duration_seconds: Math.round(durationSeconds),
      total_prompts_shown: state.prompts_shown_count,
      laws_triggered: lawsTriggered,
      recommended_actions: recommendedActions.slice(0, 5),
    },
    insights_json: insights,
    strengths_json: strengths.slice(0, 3),
    growth_areas_json: growthAreas.slice(0, 3),
    timeline_json: timeline,
  };

  // Persist to Postgres
  await insertReport(report).catch(err => {
    console.error('[REPORT] Failed to persist report:', err.message);
  });

  console.log(`[REPORT] Generated report ${reportId} for session ${meetingSessionId}: ${strengths.length} strengths, ${growthAreas.length} growth areas, ${timeline.length} timeline entries`);

  return reportId;
}
