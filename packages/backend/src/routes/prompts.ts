import { Router, Response } from 'express';
import { PromptPollResponse, PromptAckRequest, PromptAckResponse } from '@gleameet/shared';
import { AuthenticatedRequest } from '../middleware/auth';
import { updatePromptDisplayState } from '../db/queries';

export const promptsRouter = Router();

// In-memory prompt store (Redis-backed in production; in-process is fine for single-instance v1).
// Prompts are removed on frontend ack, not on poll, so a transient extension/content-script miss
// cannot permanently drop a live nudge that was generated and later appears in the report.
const PROMPT_DELIVERY_LEASE_MS = 8000;

interface PendingPromptRecord {
  prompt: any;
  leasedUntil: number;
}

const pendingPrompts = new Map<string, PendingPromptRecord[]>();

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

    const now = Date.now();
    const records = pendingPrompts.get(meetingSessionId) || [];
    const deliverable = records.filter(record => record.leasedUntil <= now);

    for (const record of deliverable) {
      record.leasedUntil = now + PROMPT_DELIVERY_LEASE_MS;
    }

    const response: PromptPollResponse = { prompts: deliverable.map(record => record.prompt) };
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
    removePendingPrompt(body.meeting_session_id, body.prompt_id);

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
  if (!existing.some(record => record.prompt?.prompt_id === prompt?.prompt_id)) {
    existing.push({ prompt, leasedUntil: 0 });
  }
  pendingPrompts.set(meetingSessionId, existing);
}

function removePendingPrompt(meetingSessionId: string, promptId: string): void {
  const existing = pendingPrompts.get(meetingSessionId);
  if (!existing) return;

  const remaining = existing.filter(record => record.prompt?.prompt_id !== promptId);
  if (remaining.length === 0) {
    pendingPrompts.delete(meetingSessionId);
  } else {
    pendingPrompts.set(meetingSessionId, remaining);
  }
}
