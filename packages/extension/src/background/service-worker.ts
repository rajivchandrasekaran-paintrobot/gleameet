/**
 * GleaMeet Background Service Worker
 * Handles API communication and session management for the extension.
 * Runs as a Manifest V3 service worker.
 */

import { setSessionToken, getSessionToken, sendEventBatch, pollPrompts, endMeeting, startMeeting, ackPrompt, createSession } from '../utils/api-client';
import { detectPlatformFromUrl, MEETING_TAB_URL_PATTERNS } from '../utils/platform';
import type { RawEvent, MeetingStartRequest, PromptEvent, PromptAckRequest, Platform } from '@gleameet/shared';

type CaptureMode = 'full_meeting' | 'user_voice_only';

/** Current meeting session state */
interface SessionState {
  meetingDetected: boolean;
  meetingSessionId: string | null;
  userId: string | null;
  platform: Platform | null;
  meetingTabId: number | null;
  status: 'off' | 'ready' | 'active' | 'muted' | 'error';
  eventBuffer: RawEvent[];
  pollingInterval: ReturnType<typeof setInterval> | null;
  batchInterval: ReturnType<typeof setInterval> | null;
  captureMode: CaptureMode;
  promptsMutedByUser: boolean;
  coachingPausedByUser: boolean;
}

interface TabMeetingContext {
  meetingDetected: boolean;
  platform: Platform | null;
  tabId?: number;
  status?: SessionState['status'];
  meetingSessionId?: string | null;
  userId?: string | null;
  captureMode?: CaptureMode;
  promptsMutedByUser?: boolean;
}

interface MeetingTabMessage {
  type: string;
  [key: string]: unknown;
}

interface PersistedActiveCoachingSession {
  meetingSessionId: string;
  userId: string | null;
  platform: Platform | null;
  meetingTabId: number | null;
  status: SessionState['status'];
  captureMode: CaptureMode;
  promptsMutedByUser: boolean;
  coachingPausedByUser: boolean;
  updatedAt: number;
}

const state: SessionState = {
  meetingDetected: false,
  meetingSessionId: null,
  userId: null,
  platform: null,
  meetingTabId: null,
  status: 'off',
  eventBuffer: [],
  pollingInterval: null,
  batchInterval: null,
  captureMode: 'full_meeting',
  promptsMutedByUser: false,
  coachingPausedByUser: false,
};

let meetingTabCleanupTimer: ReturnType<typeof setTimeout> | null = null;
let meetingCleanupInProgress: Promise<any> | null = null;

const authStateReady = new Promise<void>((resolve) => {
  // Restore auth token from chrome.storage on startup before status/auth checks run.
  chrome.storage.local.get(['sessionToken', 'userId', 'activeCoachingSession'], (data) => {
    if (data.sessionToken) {
      setSessionToken(data.sessionToken);
      state.userId = data.userId || null;
    }
    const persisted = data.activeCoachingSession as PersistedActiveCoachingSession | undefined;
    const persistedAgeMs = persisted?.updatedAt ? Date.now() - persisted.updatedAt : Infinity;
    if (persisted?.meetingSessionId && persistedAgeMs < 8 * 60 * 60 * 1000) {
      state.meetingSessionId = persisted.meetingSessionId;
      state.userId = persisted.userId ?? state.userId;
      state.platform = persisted.platform ?? state.platform;
      state.meetingTabId = persisted.meetingTabId ?? null;
      state.status = persisted.status === 'muted' && persisted.promptsMutedByUser ? 'muted' : persisted.coachingPausedByUser ? 'ready' : 'active';
      state.captureMode = persisted.captureMode === 'user_voice_only' ? 'user_voice_only' : 'full_meeting';
      state.promptsMutedByUser = persisted.promptsMutedByUser === true;
      state.coachingPausedByUser = persisted.coachingPausedByUser === true;
      state.meetingDetected = true;
      if (!state.coachingPausedByUser && !state.promptsMutedByUser) {
        startSessionIntervals();
      }
    }
    resolve();
  });
});

/** Listen for messages from content script and popup */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true; // Keep message channel open for async response
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== state.meetingTabId) return;
  cancelTrackedMeetingTabCleanup();
  void cleanupIfTrackedMeetingTabIsGone('tracked-tab-removed');
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== state.meetingTabId) return;

  const url = changeInfo.url || '';
  if (!url) return;
  if (isLikelyMeetingUrl(url)) return;

  scheduleTrackedMeetingTabCleanup('tracked-tab-left-meeting-url', 3000);
});

async function handleMessage(message: any, sender?: chrome.runtime.MessageSender): Promise<any> {
  await authStateReady;

  switch (message.type) {
    case 'MEETING_DETECTED':
      state.meetingDetected = true;
      state.platform = message.platform || state.platform;
      state.meetingTabId = sender?.tab?.id ?? state.meetingTabId;
      if (state.status === 'off') {
        state.status = 'ready';
      }
      broadcastStatus();
      return { status: 'ready' };

    case 'MEETING_ENDED':
      return handleMeetingEnded(message, sender);

    case 'START_COACHING':
      if (state.meetingSessionId) {
        cancelTrackedMeetingTabCleanup();
        // Resuming existing session — reuse session, just restart intervals
        await refreshMeetingContextFromTabs();
        state.meetingDetected = true;
        state.status = 'active';
        state.promptsMutedByUser = false;
        state.coachingPausedByUser = false;
        startSessionIntervals();
        broadcastStatus();
        // Notify content script
        await sendMessageToMeetingTabs({
          type: 'COACHING_STARTED',
          meetingSessionId: state.meetingSessionId,
          userId: state.userId,
          platform: state.platform,
          captureMode: state.captureMode,
          forceRestartCapture: true,
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
      state.promptsMutedByUser = true;
      state.coachingPausedByUser = false;
      broadcastStatus();
      return { status: 'muted' };

    case 'UNMUTE_COACHING':
      state.status = 'active';
      state.promptsMutedByUser = false;
      state.coachingPausedByUser = false;
      startSessionIntervals();
      broadcastStatus();
      return { status: 'active' };

    case 'INGEST_EVENT':
      if (
        message.event &&
        state.meetingSessionId &&
        message.event.meeting_session_id === state.meetingSessionId &&
        state.status !== 'off' &&
        state.status !== 'error'
      ) {
        if (state.status !== 'active' && !state.coachingPausedByUser && !state.promptsMutedByUser) {
          state.status = 'active';
          startSessionIntervals();
          broadcastStatus();
        }
        state.eventBuffer.push(message.event);
      }
      return { buffered: true };

    case 'GET_STATUS':
      await refreshMeetingContextFromTabs();
      if (
        state.meetingSessionId &&
        state.meetingDetected &&
        !state.coachingPausedByUser &&
        !state.promptsMutedByUser &&
        state.status !== 'active'
      ) {
        state.status = 'active';
        state.meetingDetected = true;
        startSessionIntervals();
        broadcastStatus();
      }
      if (state.status === 'muted' && !state.promptsMutedByUser && state.meetingSessionId) {
        state.status = 'active';
        state.meetingDetected = true;
        startSessionIntervals();
        broadcastStatus();
      }
      return {
        status: state.status,
        meetingDetected: state.meetingDetected,
        meetingSessionId: state.meetingSessionId,
        userId: state.userId,
        platform: state.platform,
        authenticated: !!getSessionToken(),
        captureMode: state.captureMode,
        promptsMutedByUser: state.promptsMutedByUser,
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
      handleStartAudioCapture(message.meetingSessionId, message.captureMode);
      return { ok: true };

    case 'STOP_AUDIO_CAPTURE':
      // Forward stop to offscreen document
      chrome.runtime.sendMessage({ type: 'STOP_MIC_CAPTURE' }).catch(() => {});
      chrome.runtime.sendMessage({ type: 'STOP_TAB_CAPTURE' }).catch(() => {});
      return { ok: true };

    case 'AUDIO_TRANSCRIPT_RESULT':
      broadcastAudioTranscript(message);
      return { ok: true };

    case 'COACHING_ACTIVE':
      return handleCoachingActive(message, sender);

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
    await refreshMeetingContextFromTabs();
    broadcastStatus();
    console.log('[GleaMeet] Auth success, userId:', result.user_id);
    return {
      ok: true,
      userId: result.user_id,
      status: state.status,
      meetingDetected: state.meetingDetected,
      meetingSessionId: state.meetingSessionId,
      platform: state.platform,
    };
  } catch (err: any) {
    console.error('[GleaMeet] Auth failed:', err.message);
    return { error: err.message };
  }
}

/** Start a coaching session */
async function handleStartCoaching(message: any): Promise<any> {
  try {
    cancelTrackedMeetingTabCleanup();

    // Ensure we're authenticated
    if (!getSessionToken()) {
      return { error: 'Not authenticated. Please sign in first.' };
    }

    const platform = await resolveActiveMeetingPlatform(message.platform);
    if (!platform) {
      return { error: 'No supported web meeting tab detected.' };
    }

    const captureMode: CaptureMode = message.captureMode === 'user_voice_only' ? 'user_voice_only' : 'full_meeting';
    const request: MeetingStartRequest = {
      platform,
      meeting_label: message.meetingLabel || null,
      extension_version: chrome.runtime.getManifest().version,
      consent: message.consent,
    };
    request.consent.scope.capture_mode = captureMode;
    request.consent.scope.capture_other_participants = captureMode !== 'user_voice_only';

    const response = await startMeeting(request);
    const meetingTab = await getPreferredMeetingTabAsync();
    state.meetingSessionId = response.meeting_session_id;
    state.platform = platform;
    state.meetingTabId = meetingTab?.id ?? state.meetingTabId;
    state.meetingDetected = true;
    state.status = 'active';
    state.eventBuffer = [];
    state.captureMode = captureMode;

    state.promptsMutedByUser = false;
    state.coachingPausedByUser = false;
    startSessionIntervals();

    // Notify content script that coaching has started (audio capture runs there)
    await sendMessageToMeetingTabs({
      type: 'COACHING_STARTED',
      meetingSessionId: response.meeting_session_id,
      userId: state.userId,
      platform,
      captureMode,
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
    cancelTrackedMeetingTabCleanup();

    // Flush remaining events
    if (state.eventBuffer.length > 0) await flushEventBuffer().catch(() => {});

    // Stop intervals but keep session alive
    if (state.batchInterval) { clearInterval(state.batchInterval); state.batchInterval = null; }
    if (state.pollingInterval) { clearInterval(state.pollingInterval); state.pollingInterval = null; }

    state.status = 'ready'; // ready = session exists but coaching paused
    state.coachingPausedByUser = true;
    await sendMessageToMeetingTabs({
      type: 'COACHING_PAUSED',
      meetingSessionId: state.meetingSessionId,
    }).catch(() => {});
    broadcastStatus();

    console.log('[GleaMeet] Coaching paused, session preserved:', state.meetingSessionId);
    return { status: 'ready' };
  } catch (err: any) {
    console.error('[GleaMeet] Pause coaching failed:', err);
    return { error: err.message };
  }
}

/** Stop coaching and end the current coaching session */
async function handleStopCoaching(): Promise<any> {
  try {
    cancelTrackedMeetingTabCleanup();

    if (state.meetingSessionId) {
      // Flush remaining events
      await flushEventBuffer();

      // End meeting
      const result = await endMeeting(state.meetingSessionId);

      // Clear intervals
      if (state.batchInterval) clearInterval(state.batchInterval);
      if (state.pollingInterval) clearInterval(state.pollingInterval);

      chrome.runtime.sendMessage({ type: 'STOP_MIC_CAPTURE' }).catch(() => {});
      chrome.runtime.sendMessage({ type: 'STOP_TAB_CAPTURE' }).catch(() => {});

      // Dismiss all prompts on content scripts
      await sendMessageToMeetingTabs({ type: 'DISMISS_ALL_PROMPTS' });

      state.meetingSessionId = null;
      state.meetingTabId = null;
      state.status = state.meetingDetected ? 'ready' : 'off';
      state.eventBuffer = [];
      state.captureMode = 'full_meeting';
      state.promptsMutedByUser = false;
      state.coachingPausedByUser = false;
      state.batchInterval = null;
      state.pollingInterval = null;
      if (!state.meetingDetected) {
        state.platform = null;
      }

      broadcastStatus();
      return { status: state.status, reportId: result.report_id };
    }

    state.status = state.meetingDetected ? 'ready' : 'off';
    state.coachingPausedByUser = false;
    if (!state.meetingDetected) {
      state.platform = null;
    }
    broadcastStatus();
    return { status: state.status };
  } catch (err: any) {
    state.status = 'error';
    broadcastStatus();
    return { error: err.message };
  }
}

/** Handle the actual meeting tab leaving the call */
async function handleMeetingEnded(message: any = {}, sender?: chrome.runtime.MessageSender): Promise<any> {
  try {
    cancelTrackedMeetingTabCleanup();

    const senderUrl = sender?.tab?.url || '';
    const senderTabStillLooksLikeMeeting = !!senderUrl && isLikelyMeetingUrl(senderUrl);
    const liveUserControlledSession =
      !!state.meetingSessionId &&
      !state.coachingPausedByUser &&
      (state.status === 'active' || state.status === 'muted');

    if (liveUserControlledSession && senderTabStillLooksLikeMeeting && message.visibleEndSignal !== true) {
      state.meetingDetected = true;
      state.platform = state.platform ?? detectPlatformFromUrl(senderUrl);
      state.meetingTabId = sender?.tab?.id ?? state.meetingTabId;
      state.status = state.promptsMutedByUser ? 'muted' : 'active';
      startSessionIntervals();
      broadcastStatus();
      return { status: state.status, ignored: true, reason: 'transient-negative-on-meeting-url' };
    }

    const context = await getPreferredMeetingContext();
    const stillInActiveMeeting =
      !!context?.meetingDetected &&
      (state.status === 'active' || state.status === 'muted' || !!state.meetingSessionId);

    if (stillInActiveMeeting) {
      state.meetingDetected = true;
      state.platform = context.platform ?? state.platform;
      if (state.status === 'off') {
        state.status = context.status === 'active' || context.status === 'muted' ? context.status : 'ready';
      }
      broadcastStatus();
      return { status: state.status, ignored: true };
    }

    return cleanupActiveMeetingSession('meeting-ended');
  } catch (err: any) {
    state.status = 'error';
    broadcastStatus();
    return { error: err.message };
  }
}

/** Trust the meeting tab when it is actively rendering coaching UI. */
async function handleCoachingActive(message: any, sender?: chrome.runtime.MessageSender): Promise<any> {
  cancelTrackedMeetingTabCleanup();
  state.meetingDetected = true;
  state.meetingTabId = sender?.tab?.id ?? state.meetingTabId;
  state.platform = message.platform ?? state.platform;
  state.userId = message.userId ?? state.userId;
  state.captureMode = message.captureMode === 'user_voice_only' ? 'user_voice_only' : state.captureMode;
  if (message.meetingSessionId) {
    state.meetingSessionId = message.meetingSessionId;
  }
  if (state.meetingSessionId && !state.coachingPausedByUser && !state.promptsMutedByUser) {
    state.status = 'active';
    startSessionIntervals();
  } else if (state.status === 'off') {
    state.status = 'ready';
  }
  broadcastStatus();
  return {
    status: state.status,
    meetingDetected: state.meetingDetected,
    meetingSessionId: state.meetingSessionId,
  };
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
  if (!state.meetingSessionId || state.promptsMutedByUser || state.coachingPausedByUser) return;

  if (state.status !== 'active') {
    const context = await getPreferredMeetingContext();
    if (!context?.meetingDetected) return;

    state.meetingDetected = true;
    state.platform = context.platform ?? state.platform;
    state.status = 'active';
    broadcastStatus();
  }

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

/** Start audio capture via offscreen document */
function handleStartAudioCapture(meetingSessionId: string, captureMode: CaptureMode = state.captureMode): void {
  const token = getSessionToken();
  const apiBase = 'https://gleameet.onrender.com';

  ensureOffscreenDocument().then(() => {
    chrome.runtime.sendMessage({
      type: 'START_MIC_CAPTURE',
      meetingSessionId,
      sessionToken: token,
      apiBase,
    }).catch(() => {});

    if (captureMode === 'user_voice_only') {
      console.log('[GleaMeet] User-voice-only mode: skipping tab audio capture');
      return;
    }

    getPreferredMeetingTab((tab) => {
      if (!tab?.id) return;

      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          console.warn('[GleaMeet] Tab capture unavailable:', chrome.runtime.lastError?.message || 'missing stream id');
          return;
        }

        chrome.runtime.sendMessage({
          type: 'START_TAB_CAPTURE',
          meetingSessionId,
          sessionToken: token,
          apiBase,
          streamId,
        }).catch(() => {});
      });
    });
  });
}

/** Broadcast session status to all extension tabs */
function broadcastStatus(statusReason?: string): void {
  persistActiveCoachingSession();
  chrome.runtime.sendMessage({
    type: 'STATUS_UPDATE',
    status: state.status,
    meetingDetected: state.meetingDetected,
    meetingSessionId: state.meetingSessionId,
    platform: state.platform,
    captureMode: state.captureMode,
    promptsMutedByUser: state.promptsMutedByUser,
    statusReason,
  }).catch(() => {}); // Ignore if no listeners
}

function persistActiveCoachingSession(): void {
  if (!state.meetingSessionId) {
    chrome.storage.local.remove('activeCoachingSession');
    return;
  }

  const snapshot: PersistedActiveCoachingSession = {
    meetingSessionId: state.meetingSessionId,
    userId: state.userId,
    platform: state.platform,
    meetingTabId: state.meetingTabId,
    status: state.status,
    captureMode: state.captureMode,
    promptsMutedByUser: state.promptsMutedByUser,
    coachingPausedByUser: state.coachingPausedByUser,
    updatedAt: Date.now(),
  };
  chrome.storage.local.set({ activeCoachingSession: snapshot });
}

function cancelTrackedMeetingTabCleanup(): void {
  if (!meetingTabCleanupTimer) return;
  clearTimeout(meetingTabCleanupTimer);
  meetingTabCleanupTimer = null;
}

function scheduleTrackedMeetingTabCleanup(reason: string, delayMs: number): void {
  if (!state.meetingSessionId && state.status === 'off') return;

  cancelTrackedMeetingTabCleanup();
  meetingTabCleanupTimer = setTimeout(() => {
    meetingTabCleanupTimer = null;
    void cleanupIfTrackedMeetingTabIsGone(reason);
  }, delayMs);
}

async function cleanupIfTrackedMeetingTabIsGone(reason: string): Promise<void> {
  await authStateReady;

  if (reason === 'tracked-tab-removed') {
    await cleanupActiveMeetingSession(reason);
    return;
  }

  const context = await getPreferredMeetingContext();
  if (context?.meetingDetected) {
    state.meetingDetected = true;
    state.platform = context.platform ?? state.platform;
    state.meetingTabId = context.tabId ?? state.meetingTabId;
    if (state.meetingSessionId && !state.coachingPausedByUser && !state.promptsMutedByUser) {
      state.status = 'active';
      startSessionIntervals();
    } else if (state.status === 'off') {
      state.status = 'ready';
    }
    broadcastStatus();
    return;
  }

  await cleanupActiveMeetingSession(reason);
}

async function cleanupActiveMeetingSession(reason: string): Promise<any> {
  if (meetingCleanupInProgress) return meetingCleanupInProgress;

  meetingCleanupInProgress = (async () => {
    const sessionId = state.meetingSessionId;

    if (sessionId) {
      await flushEventBuffer().catch(() => {});
      await endMeeting(sessionId).catch((err) => {
        console.error(`[GleaMeet] End meeting cleanup failed (${reason}):`, err);
      });
    }

    await sendMessageToMeetingTabs({ type: 'DISMISS_ALL_PROMPTS' }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'STOP_MIC_CAPTURE' }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'STOP_TAB_CAPTURE' }).catch(() => {});

    if (state.batchInterval) { clearInterval(state.batchInterval); state.batchInterval = null; }
    if (state.pollingInterval) { clearInterval(state.pollingInterval); state.pollingInterval = null; }

    state.meetingDetected = false;
    state.meetingSessionId = null;
    state.meetingTabId = null;
    state.platform = null;
    state.status = 'off';
    state.eventBuffer = [];
    state.captureMode = 'full_meeting';
    state.promptsMutedByUser = false;
    state.coachingPausedByUser = false;

    chrome.storage.local.remove('activeCoachingSession');
    broadcastStatus(reason);
    return { status: 'off' };
  })();

  try {
    return await meetingCleanupInProgress;
  } finally {
    meetingCleanupInProgress = null;
  }
}

/** Broadcast a prompt to content scripts on supported meeting tabs */
function broadcastPrompt(prompt: PromptEvent): void {
  void sendMessageToMeetingTabs({
    type: 'SHOW_PROMPT',
    prompt,
    meetingSessionId: state.meetingSessionId,
    userId: state.userId,
    platform: state.platform,
    captureMode: state.captureMode,
  });
}

function broadcastAudioTranscript(message: {
  text?: string;
  stream?: 'mic' | 'tab';
  startOffsetMs?: number;
  endOffsetMs?: number;
  eventTimeMs?: number;
}): void {
  if (!message.text || !message.stream) return;

  void sendMessageToMeetingTabs({
    type: 'AUDIO_TRANSCRIPT_RESULT',
    text: message.text,
    stream: message.stream,
    startOffsetMs: message.startOffsetMs,
    endOffsetMs: message.endOffsetMs,
    eventTimeMs: message.eventTimeMs,
  });
}

function startSessionIntervals(): void {
  if (state.batchInterval) clearInterval(state.batchInterval);
  if (state.pollingInterval) clearInterval(state.pollingInterval);

  // Start event batching every 3 seconds (per SRS)
  state.batchInterval = setInterval(flushEventBuffer, 3000);

  // Start prompt polling every 2 seconds (per SRS)
  state.pollingInterval = setInterval(pollForPrompts, 2000);
  void pollForPrompts();
}

function getPreferredMeetingTab(callback: (tab: chrome.tabs.Tab | undefined) => void): void {
  getPreferredMeetingTabAsync().then(callback);
}

async function getPreferredMeetingTabAsync(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await queryMeetingTabs();
  return tabs.find(tab => tab.id === state.meetingTabId) ?? tabs.find(tab => tab.active) ?? tabs[0];
}

async function refreshMeetingContextFromTabs(): Promise<void> {
  const context = await getPreferredMeetingContext();

  if (context?.meetingDetected) {
    state.meetingDetected = true;
    state.platform = context.platform ?? state.platform;
    state.meetingTabId = context.tabId ?? state.meetingTabId;
    if (context.meetingSessionId && !state.meetingSessionId) {
      state.meetingSessionId = context.meetingSessionId;
      state.userId = context.userId ?? state.userId;
      state.captureMode = context.captureMode === 'user_voice_only' ? 'user_voice_only' : state.captureMode;
      state.status = context.status === 'muted' && context.promptsMutedByUser ? 'muted' : 'active';
      state.promptsMutedByUser = context.status === 'muted' && context.promptsMutedByUser === true;
      state.coachingPausedByUser = false;
      startSessionIntervals();
    } else if (state.meetingSessionId && state.status === 'off') {
      state.status = context.status === 'active' || context.status === 'muted' ? context.status : 'ready';
    } else if (!state.meetingSessionId && state.status === 'off') {
      state.status = 'ready';
    }
    return;
  }

  if (!state.meetingSessionId) {
    state.meetingDetected = false;
    state.platform = null;
    if (state.status === 'ready' || state.status === 'off') {
      state.status = 'off';
    }
    return;
  }

  // Once the user starts coaching, weak/negative detector results must not
  // change the visible session state. Only explicit user actions, verified
  // meeting end signals, tab close, or navigation away may tear it down.
  state.meetingDetected = true;
  if (!state.coachingPausedByUser) {
    state.status = state.promptsMutedByUser ? 'muted' : 'active';
  }
}

async function getPreferredMeetingContext(): Promise<TabMeetingContext | null> {
  const tabs = await queryMeetingTabs();

  const orderedTabs = [
    ...tabs.filter(tab => tab.active),
    ...tabs.filter(tab => !tab.active),
  ];

  for (const tab of orderedTabs) {
    if (!tab.id) continue;

    const likelyMeetingUrl = isLikelyMeetingUrl(tab.url || '');
    const response = await ensureMeetingTabReady(tab);
    if (response?.meetingDetected) {
      return {
        meetingDetected: true,
        platform: response.platform ?? detectPlatformFromUrl(tab.url || ''),
        tabId: tab.id,
        status: response.status,
        meetingSessionId: response.meetingSessionId,
        userId: response.userId,
        captureMode: response.captureMode,
        promptsMutedByUser: response.promptsMutedByUser,
      };
    }
    const pageProbe = await probeMeetingPage(tab);
    if (pageProbe?.meetingDetected) {
      return {
        meetingDetected: true,
        platform: pageProbe.platform ?? response?.platform ?? detectPlatformFromUrl(tab.url || ''),
        tabId: tab.id,
        status: response?.status ?? (state.meetingSessionId && !state.coachingPausedByUser
          ? (state.promptsMutedByUser ? 'muted' : 'active')
          : 'ready'),
        meetingSessionId: response?.meetingSessionId ?? state.meetingSessionId,
        userId: response?.userId ?? state.userId,
        captureMode: response?.captureMode ?? state.captureMode,
        promptsMutedByUser: response?.promptsMutedByUser ?? state.promptsMutedByUser,
      };
    }
    if (likelyMeetingUrl && (!response || tab.active || tab.id === state.meetingTabId || !!state.meetingSessionId)) {
      return {
        meetingDetected: true,
        platform: detectPlatformFromUrl(tab.url || ''),
        tabId: tab.id,
        status: state.meetingSessionId && !state.coachingPausedByUser
          ? (state.promptsMutedByUser ? 'muted' : 'active')
          : 'ready',
        meetingSessionId: state.meetingSessionId,
        userId: state.userId,
        captureMode: state.captureMode,
        promptsMutedByUser: state.promptsMutedByUser,
      };
    }
  }

  const preferredTab = orderedTabs[0];
  if (!preferredTab?.url) return null;

  return {
    meetingDetected: isLikelyMeetingUrl(preferredTab.url),
    platform: detectPlatformFromUrl(preferredTab.url),
    tabId: preferredTab.id,
  };
}

function isLikelyMeetingUrl(url: string): boolean {
  const platform = detectPlatformFromUrl(url);
  if (!platform) return false;

  const decodedUrl = decodeURIComponent(url);
  let path = decodedUrl;
  try {
    path = new URL(url).pathname;
  } catch (_err) {
    // Keep decodedUrl fallback for malformed transient navigation URLs.
  }

  if (platform === 'google_meet') {
    return /meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/i.test(decodedUrl);
  }

  if (platform === 'zoom') {
    return /\/wc\/\d+(?:\/(?:join|start|meeting))?(?:\/|$)/i.test(path);
  }

  if (platform === 'teams') {
    return decodedUrl.includes('/meet/') ||
      decodedUrl.includes('/callingv2') ||
      decodedUrl.includes('/light-meetings/launch') ||
      decodedUrl.includes('/l/meetup-join') ||
      decodedUrl.includes('type=meet') ||
      decodedUrl.includes('lightExperience=true');
  }

  return false;
}

async function queryMeetingTabs(): Promise<chrome.tabs.Tab[]> {
  const [tabs, activeTab, allTabs] = await Promise.all([
    new Promise<chrome.tabs.Tab[]>((resolve) => {
      chrome.tabs.query({ url: [...MEETING_TAB_URL_PATTERNS] }, resolve);
    }),
    queryActiveTab(),
    queryAllTabs(),
  ]);

  const meetingTabs = [...tabs];
  if (activeTab?.id && isLikelyMeetingUrl(activeTab.url || '') && !meetingTabs.some(tab => tab.id === activeTab.id)) {
    meetingTabs.unshift(activeTab);
  }
  for (const tab of allTabs) {
    if (tab.id && isLikelyMeetingUrl(tab.url || '') && !meetingTabs.some(existing => existing.id === tab.id)) {
      meetingTabs.push(tab);
    }
  }

  if (!state.meetingTabId || meetingTabs.some(tab => tab.id === state.meetingTabId)) {
    return meetingTabs;
  }

  const rememberedTab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
    chrome.tabs.get(state.meetingTabId as number, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve(null);
        return;
      }
      resolve(tab);
    });
  });

  return rememberedTab ? [rememberedTab, ...meetingTabs] : meetingTabs;
}

async function queryActiveTab(): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      resolve(tabs[0] ?? null);
    });
  });
}

async function queryAllTabs(): Promise<chrome.tabs.Tab[]> {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      resolve(tabs ?? []);
    });
  });
}

async function sendMessageToMeetingTabs(message: MeetingTabMessage): Promise<void> {
  const tabs = await queryMeetingTabs();

  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) return;

      const context = await ensureMeetingTabReady(tab);
      const likelyMeetingUrl = isLikelyMeetingUrl(tab.url || '');
      const meetingDetected = !!context?.meetingDetected || likelyMeetingUrl;

      if (!context && !likelyMeetingUrl && message.type !== 'DISMISS_ALL_PROMPTS') {
        return;
      }

      if (!meetingDetected && message.type !== 'DISMISS_ALL_PROMPTS') {
        return;
      }

      if (
        tab.id &&
        state.status === 'active' &&
        state.meetingSessionId &&
        state.userId &&
        message.type !== 'COACHING_STARTED' &&
        context?.status !== 'active'
      ) {
        try {
          await chrome.tabs.sendMessage(tab.id, {
            type: 'COACHING_STARTED',
            meetingSessionId: state.meetingSessionId,
            userId: state.userId,
            platform: state.platform,
            captureMode: state.captureMode,
          });
        } catch (_syncErr) {
          // If the tab still isn't ready, the main message send below will no-op safely.
        }
      }

      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch (_err) {
        // Ignore tabs that navigated away or still aren't ready.
      }
    })
  );
}

async function ensureMeetingTabReady(tab: chrome.tabs.Tab): Promise<TabMeetingContext | null> {
  if (!tab.id) return null;

  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTENT_STATUS' }) as TabMeetingContext | null;
  } catch (_err) {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content.css'],
      });
    } catch (_cssErr) {
      // Ignore duplicate CSS insertions or pages that reject CSS briefly during navigation.
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
    } catch (_jsErr) {
      return null;
    }

    try {
      return await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTENT_STATUS' }) as TabMeetingContext | null;
    } catch (_retryErr) {
      return null;
    }
  }
}

async function probeMeetingPage(tab: chrome.tabs.Tab): Promise<TabMeetingContext | null> {
  if (!tab.id) return null;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const url = window.location.href;
        const decodedUrl = decodeURIComponent(url);
        let path = decodedUrl;
        try {
          path = new URL(url).pathname;
        } catch (_err) {
          // Keep decodedUrl fallback.
        }

        const platform =
          url.includes('meet.google.com') ? 'google_meet' :
          (url.includes('teams.microsoft.com') || url.includes('teams.live.com')) ? 'teams' :
          (url.includes('zoom.us') || url.includes('app.zoom.us')) ? 'zoom' :
          null;

        if (!platform) {
          return { meetingDetected: false, platform: null };
        }

        if (platform === 'zoom') {
          const hasWebClientMeetingUrl = /\/wc\/\d+(?:\/(?:join|start|meeting))?(?:\/|$)/i.test(path);
          const visibleEndedScreen = Array.from(document.querySelectorAll('.zm-modal-body-title, .zm-modal-body-content, [role="dialog"]'))
            .some((el) => {
              const element = el as HTMLElement;
              const style = window.getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0' &&
                rect.width > 0 &&
                rect.height > 0 &&
                /ended|left|removed/i.test(element.textContent || '');
            });
          return { meetingDetected: hasWebClientMeetingUrl && !visibleEndedScreen, platform };
        }

        if (platform === 'google_meet') {
          return { meetingDetected: /meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/i.test(decodedUrl), platform };
        }

        return {
          meetingDetected: decodedUrl.includes('/meet/') ||
            decodedUrl.includes('/callingv2') ||
            decodedUrl.includes('/light-meetings/launch') ||
            decodedUrl.includes('/l/meetup-join') ||
            decodedUrl.includes('type=meet') ||
            decodedUrl.includes('lightExperience=true'),
          platform,
        };
      },
    });

    const result = results?.[0]?.result as TabMeetingContext | undefined;
    return result ?? null;
  } catch (_err) {
    return null;
  }
}

async function resolveActiveMeetingPlatform(platformHint?: Platform | null): Promise<Platform | null> {
  if (platformHint) return platformHint;
  const context = await getPreferredMeetingContext();
  if (context?.meetingDetected) {
    state.meetingDetected = true;
    state.platform = context.platform ?? state.platform;
    state.meetingTabId = context.tabId ?? state.meetingTabId;
    return state.platform;
  }

  return state.platform;
}
