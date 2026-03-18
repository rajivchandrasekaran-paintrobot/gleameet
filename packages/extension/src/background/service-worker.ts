/**
 * GleaMeet Background Service Worker
 * Handles API communication and session management for the extension.
 * Runs as a Manifest V3 service worker.
 */

import { setSessionToken, sendEventBatch, pollPrompts, endMeeting, startMeeting } from '../utils/api-client';
import type { RawEvent, MeetingStartRequest, PromptEvent } from '@gleameet/shared';

/** Current meeting session state */
interface SessionState {
  meetingSessionId: string | null;
  userId: string | null;
  status: 'off' | 'ready' | 'active' | 'muted' | 'error';
  eventBuffer: RawEvent[];
  pollingInterval: ReturnType<typeof setInterval> | null;
  batchInterval: ReturnType<typeof setInterval> | null;
}

const state: SessionState = {
  meetingSessionId: null,
  userId: null,
  status: 'off',
  eventBuffer: [],
  pollingInterval: null,
  batchInterval: null,
};

/** Listen for messages from content script and popup */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true; // Keep message channel open for async response
});

async function handleMessage(message: any): Promise<any> {
  switch (message.type) {
    case 'MEETING_DETECTED':
      state.status = 'ready';
      broadcastStatus();
      return { status: 'ready' };

    case 'START_COACHING':
      return handleStartCoaching(message);

    case 'STOP_COACHING':
      return handleStopCoaching();

    case 'MUTE_COACHING':
      state.status = 'muted';
      broadcastStatus();
      return { status: 'muted' };

    case 'UNMUTE_COACHING':
      state.status = 'active';
      broadcastStatus();
      return { status: 'active' };

    case 'INGEST_EVENT':
      if (state.status === 'active' && message.event) {
        state.eventBuffer.push(message.event);
      }
      return { buffered: true };

    case 'GET_STATUS':
      return {
        status: state.status,
        meetingSessionId: state.meetingSessionId,
      };

    case 'SET_AUTH_TOKEN':
      setSessionToken(message.token);
      state.userId = message.userId;
      return { ok: true };

    default:
      return { error: 'Unknown message type' };
  }
}

/** Start a coaching session */
async function handleStartCoaching(message: any): Promise<any> {
  try {
    const request: MeetingStartRequest = {
      platform: 'google_meet',
      meeting_label: message.meetingLabel || null,
      extension_version: chrome.runtime.getManifest().version,
      consent: message.consent,
    };

    const response = await startMeeting(request);
    state.meetingSessionId = response.meeting_session_id;
    state.status = 'active';
    state.eventBuffer = [];

    // Start event batching (send events every 2 seconds)
    state.batchInterval = setInterval(flushEventBuffer, response.session_config.batch_interval_ms);

    // Start prompt polling (poll every 1 second)
    state.pollingInterval = setInterval(pollForPrompts, response.session_config.polling_interval_ms);

    broadcastStatus();
    return { status: 'active', meetingSessionId: response.meeting_session_id };
  } catch (err: any) {
    state.status = 'error';
    broadcastStatus();
    return { error: err.message };
  }
}

/** Stop coaching and end the session */
async function handleStopCoaching(): Promise<any> {
  try {
    if (state.meetingSessionId) {
      // Flush remaining events
      await flushEventBuffer();

      // End meeting
      const result = await endMeeting(state.meetingSessionId);

      // Clear intervals
      if (state.batchInterval) clearInterval(state.batchInterval);
      if (state.pollingInterval) clearInterval(state.pollingInterval);

      state.meetingSessionId = null;
      state.status = 'off';
      state.eventBuffer = [];
      state.batchInterval = null;
      state.pollingInterval = null;

      broadcastStatus();
      return { status: 'off', reportId: result.report_id };
    }
    return { status: 'off' };
  } catch (err: any) {
    state.status = 'error';
    broadcastStatus();
    return { error: err.message };
  }
}

/** Flush buffered events to the backend */
async function flushEventBuffer(): Promise<void> {
  if (state.eventBuffer.length === 0 || !state.meetingSessionId) return;

  const events = [...state.eventBuffer];
  state.eventBuffer = [];

  try {
    const result = await sendEventBatch({
      meeting_session_id: state.meetingSessionId,
      events,
    });

    // If the batch response includes prompts, forward to content script
    if (result.prompts && result.prompts.length > 0) {
      for (const prompt of result.prompts) {
        broadcastPrompt(prompt);
      }
    }
  } catch (err) {
    // Re-buffer events on failure (ER-003)
    state.eventBuffer.unshift(...events);
    console.error('[GleaMeet] Event batch failed:', err);
  }
}

/** Poll for pending prompts */
async function pollForPrompts(): Promise<void> {
  if (!state.meetingSessionId || state.status !== 'active') return;

  try {
    const result = await pollPrompts(state.meetingSessionId);
    for (const prompt of result.prompts) {
      broadcastPrompt(prompt);
    }
  } catch (err) {
    console.error('[GleaMeet] Prompt poll failed:', err);
  }
}

/** Broadcast session status to all extension tabs */
function broadcastStatus(): void {
  chrome.runtime.sendMessage({
    type: 'STATUS_UPDATE',
    status: state.status,
    meetingSessionId: state.meetingSessionId,
  }).catch(() => {}); // Ignore if no listeners
}

/** Broadcast a prompt to the content script on the active Meet tab */
function broadcastPrompt(prompt: PromptEvent): void {
  chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'SHOW_PROMPT',
          prompt,
        }).catch(() => {});
      }
    }
  });
}
