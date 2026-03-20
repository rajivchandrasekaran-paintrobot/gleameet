import { Router, Response } from 'express';
import { EventsBatchRequest, EventsBatchResponse } from '@gleameet/shared';
import { validateRawEvent } from '@gleameet/shared';
import { AuthenticatedRequest } from '../middleware/auth';
import { getMeetingState, updateMeetingState } from '../db/redis';
import { processEvents } from '../features/feature-engine';
import { evaluateLaws } from '../law-engine/law-evaluator';
import { rankAndSelectPrompt } from '../intervention/intervention-engine';
import { insertRawEvents, insertLawTrigger, insertPromptEvent } from '../db/queries';
import { enqueuePendingPrompt } from './prompts';

export const eventsRouter = Router();

/**
 * POST /events/batch
 * Ingest event batch, run feature extraction, law evaluation, and intervention (FR-016 through FR-022)
 */
eventsRouter.post('/batch', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const body = req.body as EventsBatchRequest;

    if (!body.meeting_session_id || !Array.isArray(body.events)) {
      res.status(400).json({ error: 'Missing meeting_session_id or events array', code: 'INVALID_REQUEST' });
      return;
    }

    const state = await getMeetingState(body.meeting_session_id);
    if (!state) {
      res.status(404).json({ error: 'Meeting session not found or expired', code: 'NOT_FOUND' });
      return;
    }

    if (state.status !== 'active') {
      res.status(400).json({ error: `Session is ${state.status}, not accepting events`, code: 'SESSION_INACTIVE' });
      return;
    }

    // Validate events
    const accepted: string[] = [];
    const errors: Array<{ event_id: string; error: string }> = [];

    for (const event of body.events) {
      const validation = validateRawEvent(event);
      if (validation.valid) {
        accepted.push(event.event_id);
      } else {
        errors.push({ event_id: event.event_id || 'unknown', error: validation.errors.join('; ') });
      }
    }

    const validEvents = body.events.filter(e => accepted.includes(e.event_id));

    // Update event count in state
    state.events_ingested += validEvents.length;

    // Persist valid events to Postgres
    insertRawEvents(validEvents).catch(err => {
      console.error('[EVENTS] Failed to persist events:', err.message);
    });

    // Step 1: Feature extraction
    const features = await processEvents(validEvents, state);

    // Step 2: Law evaluation
    const triggers = await evaluateLaws(body.meeting_session_id, features, state);

    // Persist triggers
    for (const trigger of triggers) {
      state.law_trigger_ids.push(trigger.trigger_id);
      insertLawTrigger(trigger).catch(err => {
        console.error('[EVENTS] Failed to persist trigger:', err.message);
      });
    }

    // Step 3: Intervention ranking (returns at most one prompt per FR-045)
    const prompt = await rankAndSelectPrompt(body.meeting_session_id, triggers, state);

    if (prompt) {
      state.prompt_ids.push(prompt.prompt_id);
      // Enqueue for polling
      enqueuePendingPrompt(body.meeting_session_id, prompt);
      // Persist prompt event
      insertPromptEvent(prompt).catch(err => {
        console.error('[EVENTS] Failed to persist prompt:', err.message);
      });
    }

    await updateMeetingState(body.meeting_session_id, state);

    const eventTypes = body.events.map((e: any) => e.event_type).join(', ');
    console.log(`[EVENTS] Processed batch: ${accepted.length} accepted, ${errors.length} errors, ${triggers.length} triggers, prompt=${!!prompt} | types: ${eventTypes}`);

    const response: EventsBatchResponse = {
      accepted_count: accepted.length,
      errors,
      prompts: prompt ? [prompt] : [],
    };

    res.status(200).json(response);
  } catch (err) {
    console.error('[EVENTS] Batch processing error:', err);
    res.status(500).json({ error: 'Event batch processing failed', code: 'PROCESSING_ERROR' });
  }
});
