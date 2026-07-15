import { Router, Response } from 'express';
import { PromptPollResponse, PromptAckRequest, PromptAckResponse } from '@gleameet/shared';
import { AuthenticatedRequest } from '../middleware/auth';
import { updatePromptDisplayState } from '../db/queries';

export const promptsRouter = Router();

// In-memory prompt store (Redis-backed in production; in-process is fine for single-instance v1).
// Prompts are removed on frontend ack, not on poll, so a transient extension/content-script miss
// cannot permanently drop a live nudge that was generated and later appears in the report.
const PROMPT_DELIVERY_LEASE_MS = 8000;
const PROMPT_SHOWN_RETRY_GRACE_MS = 20000;
const PROMPT_MAX_DELIVERY_ATTEMPTS = 4;

interface PendingPromptRecord {
  prompt: any;
  leasedUntil: number;
  deliveryAttempts: number;
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
    const stillPending = records.filter(record => {
      const expiresAt = record.prompt?.expired_at ? Date.parse(record.prompt.expired_at) : NaN;
      return Number.isNaN(expiresAt) || expiresAt > now;
    });
    if (stillPending.length !== records.length) {
      pendingPrompts.set(meetingSessionId, stillPending);
    }

    const deliverable = stillPending.filter(record => record.leasedUntil <= now);

    for (const record of deliverable) {
      record.leasedUntil = now + PROMPT_DELIVERY_LEASE_MS;
      record.deliveryAttempts += 1;
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
    if (body.action === 'shown') {
      markPromptShown(body.meeting_session_id, body.prompt_id);
    } else {
      removePendingPrompt(body.meeting_session_id, body.prompt_id);
    }

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
    // The prompt is also returned in the triggering /events/batch response.
    // Lease it briefly so the polling path retries only if direct delivery misses.
    existing.push({ prompt, leasedUntil: Date.now() + PROMPT_DELIVERY_LEASE_MS, deliveryAttempts: 1 });
  }
  pendingPrompts.set(meetingSessionId, existing);
}

function markPromptShown(meetingSessionId: string, promptId: string): void {
  const existing = pendingPrompts.get(meetingSessionId);
  if (!existing) return;

  const record = existing.find(item => item.prompt?.prompt_id === promptId);
  if (!record) return;

  if (record.deliveryAttempts >= PROMPT_MAX_DELIVERY_ATTEMPTS) {
    removePendingPrompt(meetingSessionId, promptId);
    return;
  }

  record.leasedUntil = Date.now() + PROMPT_SHOWN_RETRY_GRACE_MS;
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
