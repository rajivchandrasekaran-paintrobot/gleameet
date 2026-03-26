/**
 * GleaMeet Background Service Worker
 * Handles API communication and session management for the extension.
 * Runs as a Manifest V3 service worker.
 */

import { setSessionToken, getSessionToken, sendEventBatch, pollPrompts, endMeeting, startMeeting, ackPrompt, createSession } from '../utils/api-client';
import { createEvent } from '../utils/event-factory';
import type { RawEvent, MeetingStartRequest, PromptEvent, PromptAckRequest } from '@gleameet/shared';

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

// Restore auth token from chrome.storage on startup
chrome.storage.local.get(['sessionToken', 'userId'], (data) => {
  if (data.sessionToken) {
    setSessionToken(data.sessionToken);
    state.userId = data.userId || null;
  }
});

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
      if (state.meetingSessionId) {
        // Resuming existing session — reuse session, just restart intervals
        state.status = 'active';
        state.batchInterval = setInterval(flushEventBuffer, 3000);
        state.pollingInterval = setInterval(pollForPrompts, 2000);
        broadcastStatus();
        // Notify content script
        chrome.tabs.query({ url: ['https://meet.google.com/*', 'https://teams.microsoft.com/*', 'https://teams.live.com/*', 'https://zoom.us/wc/*', 'https://app.zoom.us/wc/*'] }, (tabs) => {
          for (const tab of tabs) {
            if (tab.id) {
              chrome.tabs.sendMessage(tab.id, {
                type: 'COACHING_STARTED',
                meetingSessionId: state.meetingSessionId,
                userId: state.userId,
              }).catch(() => {});

            }
          }
        });
        return { status: 'active', meetingSessionId: state.meetingSessionId, resumed: true };
      }
      return handleStartCoaching(message);

    case 'STOP_COACHING':
      return handlePauseCoaching();

    case 'END_MEETING':
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
        userId: state.userId,
        authenticated: !!getSessionToken(),
      };

    case 'SET_AUTH_TOKEN':
      setSessionToken(message.token);
      state.userId = message.userId;
      // Persist to chrome.storage for service worker restarts
      chrome.storage.local.set({
        sessionToken: message.token,
        userId: message.userId,
      });
      // Persist backend URL if provided
      if (message.backendUrl) {
        chrome.storage.sync.set({ backendUrl: message.backendUrl });
      }
      return { ok: true };

    case 'GET_BACKEND_URL': {
      const data = await new Promise<any>((resolve) => {
        chrome.storage.sync.get({ backendUrl: '' }, resolve);
      });
      return { backendUrl: data.backendUrl || '' };
    }

    case 'AUTHENTICATE':
      return handleAuthenticate(message.googleIdToken);

    case 'ACK_PROMPT':
      return handleAckPrompt(message);

    case 'START_AUDIO_CAPTURE':
      handleStartAudioCapture(message.meetingSessionId);
      return { ok: true };

    case 'STOP_AUDIO_CAPTURE':
      // Forward stop to offscreen document
      chrome.runtime.sendMessage({ type: 'STOP_MIC_CAPTURE' }).catch(() => {});
      return { ok: true };

    default:
      return { error: 'Unknown message type' };
  }
}

/** Authenticate with backend using Google ID token */
async function handleAuthenticate(googleIdToken: string): Promise<any> {
  try {
    console.log('[GleaMeet] Authenticating with backend...');
    const result = await createSession(googleIdToken);
    state.userId = result.user_id;
    setSessionToken(result.session_token);
    // Store token persistently
    chrome.storage.local.set({
      sessionToken: result.session_token,
      userId: result.user_id,
    });
    console.log('[GleaMeet] Auth success, userId:', result.user_id);
    return { ok: true, userId: result.user_id };
  } catch (err: any) {
    console.error('[GleaMeet] Auth failed:', err.message);
    return { error: err.message };
  }
}

/** Start a coaching session */
async function handleStartCoaching(message: any): Promise<any> {
  try {
    // Ensure we're authenticated
    if (!getSessionToken()) {
      return { error: 'Not authenticated. Please sign in first.' };
    }

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

    // Start event batching every 3 seconds (per SRS)
    state.batchInterval = setInterval(flushEventBuffer, 3000);

    // Start prompt polling every 2 seconds (per SRS)
    state.pollingInterval = setInterval(pollForPrompts, 2000);

    // Notify content script that coaching has started (audio capture runs there)
    chrome.tabs.query({ url: ['https://meet.google.com/*', 'https://teams.microsoft.com/*', 'https://teams.live.com/*', 'https://zoom.us/wc/*', 'https://app.zoom.us/wc/*'] }, (tabs) => {
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'COACHING_STARTED',
            meetingSessionId: response.meeting_session_id,
            userId: state.userId,
          }).catch(() => {});


        }
      }
    });

    broadcastStatus();
    return { status: 'active', meetingSessionId: response.meeting_session_id };
  } catch (err: any) {
    state.status = 'error';
    broadcastStatus();
    return { error: err.message };
  }
}

/** Pause coaching but keep session alive for resuming */
async function handlePauseCoaching(): Promise<any> {
  try {
    // Flush remaining events
    if (state.eventBuffer.length > 0) await flushEventBuffer().catch(() => {});

    // Stop intervals but keep session alive
    if (state.batchInterval) { clearInterval(state.batchInterval); state.batchInterval = null; }
    if (state.pollingInterval) { clearInterval(state.pollingInterval); state.pollingInterval = null; }

    state.status = 'ready'; // ready = session exists but coaching paused
    broadcastStatus();

    console.log('[GleaMeet] Coaching paused, session preserved:', state.meetingSessionId);
    return { status: 'ready' };
  } catch (err: any) {
    console.error('[GleaMeet] Pause coaching failed:', err);
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

      // Dismiss all prompts on content scripts
      chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
        for (const tab of tabs) {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, { type: 'DISMISS_ALL_PROMPTS' }).catch(() => {});
          }
        }
      });

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

/** Flush buffered events to the backend every 3 seconds */
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
    // Re-buffer events on failure (ER-003: retry on next interval)
    state.eventBuffer.unshift(...events);
    console.error('[GleaMeet] Event batch failed:', err);
  }
}

/** Poll for pending prompts every 2 seconds */
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

/** Handle prompt acknowledgment from content script */
async function handleAckPrompt(message: any): Promise<any> {
  try {
    const request: PromptAckRequest = {
      prompt_id: message.promptId,
      meeting_session_id: message.meetingSessionId || state.meetingSessionId || '',
      action: message.action,
      timestamp: new Date().toISOString(),
    };
    await ackPrompt(request);
    return { ok: true };
  } catch (err: any) {
    console.error('[GleaMeet] Prompt ack failed:', err);
    return { error: err.message };
  }
}

/** Ensure offscreen document exists, then run callback */
function ensureOffscreenDocument(): Promise<void> {
  return (chrome.offscreen as any).createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Audio capture for meeting transcription',
  }).catch(() => {
    // Offscreen document already exists — that's fine
  });
}

/** Start mic-only audio capture via offscreen document */
function handleStartAudioCapture(meetingSessionId: string): void {
  const token = getSessionToken();
  const apiBase = 'https://gleameet.onrender.com';

  ensureOffscreenDocument().then(() => {
    chrome.runtime.sendMessage({
      type: 'START_MIC_CAPTURE',
      meetingSessionId,
      sessionToken: token,
      apiBase,
    }).catch(() => {});
  });
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
