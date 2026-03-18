import { Router, Response } from 'express';
import { PromptPollResponse, PromptAckRequest, PromptAckResponse } from '@gleameet/shared';
import { AuthenticatedRequest } from '../middleware/auth';
import { updatePromptDisplayState } from '../db/queries';

export const promptsRouter = Router();

// In-memory prompt store (Redis-backed in production; in-process is fine for single-instance v1)
const pendingPrompts = new Map<string, any[]>();

/**
 * GET /prompts/poll
 * Fetch pending prompts for session if polling mode is used
 */
promptsRouter.get('/poll', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const meetingSessionId = req.query.meeting_session_id as string;
    if (!meetingSessionId) {
      res.status(400).json({ error: 'Missing meeting_session_id', code: 'INVALID_REQUEST' });
      return;
    }

    const prompts = pendingPrompts.get(meetingSessionId) || [];

    // Clear after poll (prompts are consumed once polled)
    pendingPrompts.delete(meetingSessionId);

    const response: PromptPollResponse = { prompts };
    res.status(200).json(response);
  } catch (err) {
    console.error('[PROMPTS] Poll error:', err);
    res.status(500).json({ error: 'Prompt poll failed', code: 'PROMPT_ERROR' });
  }
});

/**
 * POST /prompts/ack
 * Acknowledge prompt shown/dismissed/muted (FR-054)
 */
promptsRouter.post('/ack', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = req.body as PromptAckRequest;

    if (!body.prompt_id || !body.meeting_session_id || !body.action) {
      res.status(400).json({ error: 'Missing required fields', code: 'INVALID_REQUEST' });
      return;
    }

    // Update prompt display state in Postgres
    const dismissedAt = body.action === 'dismissed' ? (body.timestamp || new Date().toISOString()) : null;
    const displayState = body.action === 'muted' ? 'muted' : body.action;

    await updatePromptDisplayState(body.prompt_id, displayState, dismissedAt);

    console.log(`[PROMPTS] Ack: prompt=${body.prompt_id} action=${body.action}`);

    const response: PromptAckResponse = { ok: true };
    res.status(200).json(response);
  } catch (err) {
    console.error('[PROMPTS] Ack error:', err);
    res.status(500).json({ error: 'Prompt acknowledgment failed', code: 'PROMPT_ERROR' });
  }
});

/** Add a prompt to the pending queue (called by intervention engine) */
export function enqueuePendingPrompt(meetingSessionId: string, prompt: any): void {
  const existing = pendingPrompts.get(meetingSessionId) || [];
  existing.push(prompt);
  pendingPrompts.set(meetingSessionId, existing);
}
