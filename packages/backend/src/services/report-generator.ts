import { PostMeetingReport, ReportInsight, TimelineEntry, RecommendedAction } from '@gleameet/shared';
import { MeetingState } from '../db/redis';
import { getLawTriggersForSession, getPromptsForSession, insertReport } from '../db/queries';
import { loadLawById } from '@gleameet/law-registry';
import { v4 as uuidv4 } from 'uuid';
import { buildLLMClient, LLM_MODEL } from './llm-client';

/**
 * Generate a post-meeting report from the meeting state.
 * Implements FR-064 through FR-069.
 * Uses LLM for interpretive content (strengths, growth areas, recommendations) with rule-based fallback.
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

  // --- Observed facts (always rule-based) ---
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

  // --- Law trigger data (used by both LLM and fallback) ---
  const lawTriggerCounts = new Map<string, number>();
  for (const t of triggers) {
    lawTriggerCounts.set(t.law_id, (lawTriggerCounts.get(t.law_id) || 0) + 1);
  }

  const lawTriggerData: { law_id: string; law_name: string; count: number; meeting_relevance: string }[] = [];
  for (const [lawId, count] of lawTriggerCounts) {
    const law = loadLawById(lawId);
    if (!law) continue;
    lawTriggerData.push({
      law_id: lawId,
      law_name: law.law_name,
      count,
      meeting_relevance: law.meeting_relevance,
    });
  }

  // --- Attempt LLM-generated interpretive content ---
  let strengths: string[];
  let growthAreas: string[];
  let recommendedActions: RecommendedAction[];
  let modelInterpretationInsights: ReportInsight[];

  try {
    const llmResult = await generateInterpretiveContentViaLLM(state, durationSeconds, lawTriggerData);
    strengths = llmResult.strengths;
    growthAreas = llmResult.growth_areas;
    recommendedActions = llmResult.recommended_actions;
    modelInterpretationInsights = llmResult.insights.map(i => ({
      category: 'model_interpretation' as const,
      text: i.text,
      evidence_refs: [],
      law_id: i.law_id || null,
    }));
    console.log('[REPORT] LLM-generated interpretive content for session', meetingSessionId);
  } catch (err) {
    console.error('[REPORT] LLM generation failed, using rule-based fallback:', (err as Error).message);
    const fallback = generateInterpretiveContentFallback(state, triggers, lawTriggerCounts);
    strengths = fallback.strengths;
    growthAreas = fallback.growthAreas;
    recommendedActions = fallback.recommendedActions;
    modelInterpretationInsights = fallback.modelInterpretationInsights;
  }

  // Add model_interpretation insights
  insights.push(...modelInterpretationInsights);

  // --- Build timeline (always rule-based) ---
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

// --- LLM-based interpretive content generation ---

interface LLMInterpretiveResult {
  strengths: string[];
  growth_areas: string[];
  recommended_actions: { action: string; reason: string }[];
  insights: { text: string; law_id: string | null }[];
}

async function generateInterpretiveContentViaLLM(
  state: MeetingState,
  durationSeconds: number,
  lawTriggerData: { law_id: string; law_name: string; count: number; meeting_relevance: string }[],
): Promise<LLMInterpretiveResult> {
  const client = buildLLMClient();

  const lawSummary = lawTriggerData.length > 0
    ? lawTriggerData.map(l => `- ${l.law_name} (${l.law_id}): triggered ${l.count} time(s). Relevance: ${l.meeting_relevance}`).join('\n')
    : 'No behavioral laws were triggered during this meeting.';

  const totalMs = state.speaking_time_total_ms + state.other_speaking_time_total_ms;
  const sharePercent = totalMs > 0 ? Math.round((state.speaking_time_total_ms / totalMs) * 100) : 0;

  const prompt = `You are a meeting coach AI. Analyze the following meeting behavioral data and generate personalized feedback.

## Meeting Data
- Duration: ${Math.round(durationSeconds)} seconds
- User speaking time: ${Math.round(state.speaking_time_total_ms / 1000)}s (${sharePercent}% share)
- Turn changes: ${state.turn_count}
- Questions asked: ${state.question_count} (${state.clarifying_question_count} clarifying)
- Interruptions detected: ${state.interruption_count}
- Acknowledgments of others: ${state.acknowledgment_count}
- Summaries/recaps: ${state.summary_or_recap_count}
- Hedging language ratio: ${state.transcript_segment_count > 0 ? (state.hedging_hits / state.transcript_segment_count).toFixed(2) : '0'}
- Certainty language ratio: ${state.transcript_segment_count > 0 ? (state.certainty_hits / state.transcript_segment_count).toFixed(2) : '0'}
- Owner assignment present: ${state.owner_assignment_present}
- Deadline present: ${state.deadline_present}
- Evidence referenced: ${state.evidence_reference_present}
- Shared goal language: ${state.shared_goal_language_present}

## Behavioral Laws Triggered
${lawSummary}

## Instructions
Based on the data above, return a JSON object with:
- "strengths": array of up to 3 strings — what the user did well
- "growth_areas": array of up to 3 strings — areas for improvement
- "recommended_actions": array of up to 5 objects, each with:
  - "action": a clear, specific action the user should take (e.g. "Pause for 2 seconds before responding to let others finish")
  - "reason": a brief explanation of WHY this recommendation was made, citing the specific behavioral data that triggered it (e.g. "You interrupted 4 times in the last 10 minutes" or "Your hedging ratio was 0.35, above the recommended 0.30")
- "insights": array of objects with "text" (string) and "law_id" (string or null) — interpretive insights about behavioral patterns observed, referencing law_ids where relevant

Be specific, actionable, and encouraging. Each recommendation MUST cite the exact data values that motivated it. Do not invent data not provided.

Return ONLY valid JSON, no markdown formatting or extra text.`;

  const response = await client.chat.completions.create({
    model: LLM_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 1024,
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) {
    throw new Error('LLM returned empty response');
  }

  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  const parsed = JSON.parse(cleaned) as LLMInterpretiveResult;

  // Validate structure
  if (!Array.isArray(parsed.strengths) || !Array.isArray(parsed.growth_areas) ||
      !Array.isArray(parsed.recommended_actions) || !Array.isArray(parsed.insights)) {
    throw new Error('LLM response missing required arrays');
  }

  return {
    strengths: parsed.strengths.slice(0, 3),
    growth_areas: parsed.growth_areas.slice(0, 3),
    recommended_actions: parsed.recommended_actions.slice(0, 5).map(r => ({
      action: String(r.action || r),
      reason: String(r.reason || ''),
    })),
    insights: parsed.insights.map(i => ({
      text: String(i.text),
      law_id: i.law_id ? String(i.law_id) : null,
    })),
  };
}

// --- Rule-based fallback (original logic) ---

function generateInterpretiveContentFallback(
  state: MeetingState,
  triggers: Awaited<ReturnType<typeof getLawTriggersForSession>>,
  lawTriggerCounts: Map<string, number>,
): {
  strengths: string[];
  growthAreas: string[];
  recommendedActions: RecommendedAction[];
  modelInterpretationInsights: ReportInsight[];
} {
  // Model interpretations from law triggers
  const modelInterpretationInsights: ReportInsight[] = [];
  for (const [lawId, count] of lawTriggerCounts) {
    const law = loadLawById(lawId);
    if (!law) continue;
    modelInterpretationInsights.push({
      category: 'model_interpretation',
      text: `${law.law_name} was triggered ${count} time${count > 1 ? 's' : ''}: ${law.meeting_relevance}`,
      evidence_refs: triggers
        .filter(t => t.law_id === lawId)
        .slice(0, 3)
        .map(t => ({ event_id: t.trigger_id, description: `Confidence: ${t.trigger_confidence.toFixed(2)}` })),
      law_id: lawId,
    });
  }

  // Strengths
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

  // Growth areas
  const growthAreas: string[] = [];
  const sortedLaws = Array.from(lawTriggerCounts.entries())
    .sort((a, b) => b[1] - a[1]);

  for (const [lawId, count] of sortedLaws.slice(0, 3)) {
    if (count < 2) continue;
    const law = loadLawById(lawId);
    if (!law) continue;
    growthAreas.push(`${law.law_name} triggered ${count} times — consider: ${law.prompt_templates_post[0] || law.meeting_relevance}`);
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

  // Recommended actions — each includes a specific action and the data that triggered it
  const recommendedActions: RecommendedAction[] = [];
  if (growthAreas.length > 0) {
    const topArea = growthAreas[0].split(' — ')[0];
    recommendedActions.push({
      action: `Focus on improving: ${topArea}`,
      reason: growthAreas[0],
    });
  }
  if (state.hedging_hits > state.transcript_segment_count * 0.3) {
    const ratio = (state.hedging_hits / state.transcript_segment_count).toFixed(2);
    recommendedActions.push({
      action: 'Practice using more decisive language to project confidence.',
      reason: `Your hedging language ratio was ${ratio} (${state.hedging_hits} of ${state.transcript_segment_count} segments), above the 0.30 threshold.`,
    });
  }
  if (state.certainty_hits > state.transcript_segment_count * 0.4) {
    const ratio = (state.certainty_hits / state.transcript_segment_count).toFixed(2);
    recommendedActions.push({
      action: 'Balance certainty with openness — leave room for others\' perspectives.',
      reason: `Your certainty language ratio was ${ratio} (${state.certainty_hits} of ${state.transcript_segment_count} segments), above the 0.40 threshold.`,
    });
  }
  if (state.interruption_count >= 3) {
    recommendedActions.push({
      action: 'Pause for 2 seconds after someone finishes speaking before responding.',
      reason: `${state.interruption_count} interruptions were detected during this meeting.`,
    });
  }
  if (!state.owner_assignment_present && !state.deadline_present) {
    recommendedActions.push({
      action: 'Close meetings with clear owner assignments and deadlines for action items.',
      reason: 'No owner assignments or deadlines were detected in this meeting.',
    });
  }
  recommendedActions.push({
    action: 'Review your prompt history to see which behavioral patterns recur.',
    reason: `${state.prompts_shown_count} coaching prompts were shown during this meeting.`,
  });

  return { strengths, growthAreas, recommendedActions, modelInterpretationInsights };
}
