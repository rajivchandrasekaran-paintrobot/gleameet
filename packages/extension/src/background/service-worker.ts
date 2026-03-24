/**
 * GleaMeet Background Service Worker
 * Handles API communication and session management for the extension.
 * Runs as a Manifest V3 service worker.
 */

import { setSessionToken, getSessionToken, sendEventBatch, pollPrompts, endMeeting, startMeeting, ackPrompt, createSession, transcribeAudio } from '../utils/api-client';
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
  audioRecorders: MediaRecorder[];
  audioIntervals: ReturnType<typeof setInterval>[];
}

const state: SessionState = {
  meetingSessionId: null,
  userId: null,
  status: 'off',
  eventBuffer: [],
  pollingInterval: null,
  batchInterval: null,
  audioRecorders: [],
  audioIntervals: [],
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

    default:
      return { error: 'Unknown message type' };
  }
}

/** Authenticate with backend using Google ID token */
async function handleAuthenticate(googleIdToken: string): Promise<any> {
  try {
    const result = await createSession(googleIdToken);
    state.userId = result.user_id;
    // Store token persistently
    chrome.storage.local.set({
      sessionToken: result.session_token,
      userId: result.user_id,
    });
    return { ok: true, userId: result.user_id };
  } catch (err: any) {
    return { error: err.message };
  }
}

// --- Audio Capture & Whisper Transcription ---

/** Start capturing tab audio and mic audio, transcribing via Whisper */
function startAudioCapture(meetingSessionId: string): void {
  // 1. Capture tab audio (both speakers)
  chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
    if (!stream) {
      console.warn('[GleaMeet] Tab audio capture failed — no stream returned');
      return;
    }
    recordAndTranscribe(stream, 'tab', meetingSessionId);
  });

  // 2. Capture mic separately for cleaner user voice
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((micStream) => {
      recordAndTranscribe(micStream, 'mic', meetingSessionId);
    })
    .catch((e) => {
      console.warn('[GleaMeet] Mic capture failed:', e);
    });
}

/** Record a MediaStream in 10-second chunks and send each to Whisper */
function recordAndTranscribe(stream: MediaStream, streamType: 'mic' | 'tab', meetingSessionId: string): void {
  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  let chunks: Blob[] = [];

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    chunks = [];

    if (blob.size < 1000) return; // Skip silent/tiny chunks

    try {
      const { text } = await transcribeAudio(blob, streamType, meetingSessionId);
      if (text?.trim() && state.userId) {
        const speaker = streamType === 'mic' ? 'user' : 'other';
        const event = createEvent(
          meetingSessionId,
          state.userId,
          'transcript_segment',
          {
            text: text.trim(),
            speaker,
            start_offset_ms: Date.now(),
            end_offset_ms: Date.now(),
          },
          0.9
        );
        // Buffer the event just like content script events
        if (state.status === 'active') {
          state.eventBuffer.push(event);
        }
      }
    } catch (err) {
      console.error(`[GleaMeet] Whisper transcription failed (${streamType}):`, err);
    }
  };

  // Record in 10-second chunks: stop triggers onstop (which sends), then restart
  recorder.start();
  const interval = setInterval(() => {
    if (recorder.state === 'recording') {
      recorder.stop();
      recorder.start();
    }
  }, 10000);

  state.audioRecorders.push(recorder);
  state.audioIntervals.push(interval);
}

/** Stop all audio recorders and clear intervals */
function stopAudioCapture(): void {
  for (const interval of state.audioIntervals) {
    clearInterval(interval);
  }
  for (const recorder of state.audioRecorders) {
    if (recorder.state === 'recording') {
      try { recorder.stop(); } catch (_) {}
    }
    // Stop all tracks on the underlying stream
    recorder.stream.getTracks().forEach(t => t.stop());
  }
  state.audioRecorders = [];
  state.audioIntervals = [];
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

    // Start Whisper-based audio capture
    startAudioCapture(response.meeting_session_id);

    // Notify content script that coaching has started
    chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
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

/** Stop coaching and end the session */
async function handleStopCoaching(): Promise<any> {
  try {
    if (state.meetingSessionId) {
      // Flush remaining events
      await flushEventBuffer();

      // End meeting
      const result = await endMeeting(state.meetingSessionId);

      // Stop audio capture
      stopAudioCapture();

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
