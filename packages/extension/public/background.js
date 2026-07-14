// src/utils/api-client.ts
var DEFAULT_API_BASE = "https://gleameet.onrender.com";
async function getApiBase() {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage?.sync) {
      chrome.storage.sync.get({ backendUrl: DEFAULT_API_BASE }, (items) => {
        resolve(items.backendUrl || DEFAULT_API_BASE);
      });
    } else {
      resolve(DEFAULT_API_BASE);
    }
  });
}
var sessionToken = null;
function getHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (sessionToken) {
    headers["Authorization"] = `Bearer ${sessionToken}`;
  }
  return headers;
}
async function refreshSessionIfNeeded() {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.identity) {
      resolve();
      return;
    }
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (!token || chrome.runtime.lastError) {
        resolve();
        return;
      }
      createSession(token).then(() => resolve()).catch(() => resolve());
    });
  });
}
async function apiRequest(method, path, body, retry = true) {
  const apiBase = await getApiBase();
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: getHeaders(),
    body: body ? JSON.stringify(body) : void 0
  });
  if (response.status === 401 && retry) {
    await refreshSessionIfNeeded();
    return apiRequest(method, path, body, false);
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(error.error || `API error: ${response.status}`);
  }
  return response.json();
}
async function createSession(googleIdToken) {
  const result = await apiRequest("POST", "/auth/session", {
    google_id_token: googleIdToken
  });
  sessionToken = result.session_token;
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    chrome.storage.local.set({
      sessionToken: result.session_token,
      userId: result.user_id
    });
  }
  return result;
}
async function startMeeting(request) {
  return apiRequest("POST", "/meetings/start", request);
}
async function sendEventBatch(request) {
  return apiRequest("POST", "/events/batch", request);
}
async function pollPrompts(meetingSessionId) {
  return apiRequest("GET", `/prompts/poll?meeting_session_id=${meetingSessionId}`);
}
async function ackPrompt(request) {
  return apiRequest("POST", "/prompts/ack", request);
}
async function endMeeting(meetingSessionId) {
  return apiRequest("POST", "/meetings/end", {
    meeting_session_id: meetingSessionId
  });
}
function setSessionToken(token) {
  sessionToken = token;
}
function getSessionToken() {
  return sessionToken;
}

// src/utils/platform.ts
var MEETING_TAB_URL_PATTERNS = [
  "https://meet.google.com/*",
  "https://teams.microsoft.com/*",
  "https://teams.live.com/*",
  "https://zoom.us/wc/*",
  "https://app.zoom.us/wc/*"
];
function detectPlatformFromUrl(url) {
  if (url.includes("meet.google.com")) return "google_meet";
  if (url.includes("teams.microsoft.com") || url.includes("teams.live.com")) return "teams";
  if (url.includes("zoom.us") || url.includes("app.zoom.us")) return "zoom";
  return null;
}

// src/background/service-worker.ts
var state = {
  meetingDetected: false,
  meetingSessionId: null,
  userId: null,
  platform: null,
  meetingTabId: null,
  status: "off",
  eventBuffer: [],
  pollingInterval: null,
  batchInterval: null,
  captureMode: "full_meeting",
  promptsMutedByUser: false,
  coachingPausedByUser: false
};
var meetingTabCleanupTimer = null;
var meetingCleanupInProgress = null;
var authStateReady = new Promise((resolve) => {
  chrome.storage.local.get(["sessionToken", "userId", "activeCoachingSession"], (data) => {
    if (data.sessionToken) {
      setSessionToken(data.sessionToken);
      state.userId = data.userId || null;
    }
    const persisted = data.activeCoachingSession;
    const persistedAgeMs = persisted?.updatedAt ? Date.now() - persisted.updatedAt : Infinity;
    if (persisted?.meetingSessionId && persistedAgeMs < 8 * 60 * 60 * 1e3) {
      state.meetingSessionId = persisted.meetingSessionId;
      state.userId = persisted.userId ?? state.userId;
      state.platform = persisted.platform ?? state.platform;
      state.meetingTabId = persisted.meetingTabId ?? null;
      state.status = persisted.status === "muted" && persisted.promptsMutedByUser ? "muted" : persisted.coachingPausedByUser ? "ready" : "active";
      state.captureMode = persisted.captureMode === "user_voice_only" ? "user_voice_only" : "full_meeting";
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((err) => sendResponse({ error: err.message }));
  return true;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== state.meetingTabId) return;
  cancelTrackedMeetingTabCleanup();
  void cleanupIfTrackedMeetingTabIsGone("tracked-tab-removed");
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== state.meetingTabId) return;
  const url = changeInfo.url || "";
  if (!url) return;
  if (isLikelyMeetingUrl(url)) return;
  scheduleTrackedMeetingTabCleanup("tracked-tab-left-meeting-url", 3e3);
});
async function handleMessage(message, sender) {
  await authStateReady;
  switch (message.type) {
    case "MEETING_DETECTED":
      state.meetingDetected = true;
      state.platform = message.platform || state.platform;
      state.meetingTabId = sender?.tab?.id ?? state.meetingTabId;
      if (state.status === "off") {
        state.status = "ready";
      }
      broadcastStatus();
      return { status: "ready" };
    case "MEETING_ENDED":
      return handleMeetingEnded();
    case "START_COACHING":
      if (state.meetingSessionId) {
        cancelTrackedMeetingTabCleanup();
        await refreshMeetingContextFromTabs();
        state.meetingDetected = true;
        state.status = "active";
        state.promptsMutedByUser = false;
        state.coachingPausedByUser = false;
        startSessionIntervals();
        broadcastStatus();
        await sendMessageToMeetingTabs({
          type: "COACHING_STARTED",
          meetingSessionId: state.meetingSessionId,
          userId: state.userId,
          platform: state.platform,
          captureMode: state.captureMode
        });
        return { status: "active", meetingSessionId: state.meetingSessionId, resumed: true };
      }
      return handleStartCoaching(message);
    case "STOP_COACHING":
      return handlePauseCoaching();
    case "END_MEETING":
      return handleStopCoaching();
    case "MUTE_COACHING":
      state.status = "muted";
      state.promptsMutedByUser = true;
      state.coachingPausedByUser = false;
      broadcastStatus();
      return { status: "muted" };
    case "UNMUTE_COACHING":
      state.status = "active";
      state.promptsMutedByUser = false;
      state.coachingPausedByUser = false;
      startSessionIntervals();
      broadcastStatus();
      return { status: "active" };
    case "INGEST_EVENT":
      if (state.status === "active" && message.event) {
        state.eventBuffer.push(message.event);
      }
      return { buffered: true };
    case "GET_STATUS":
      await refreshMeetingContextFromTabs();
      if (state.meetingSessionId && state.meetingDetected && !state.coachingPausedByUser && !state.promptsMutedByUser && state.status !== "active") {
        state.status = "active";
        startSessionIntervals();
        broadcastStatus();
      }
      if (state.status === "muted" && !state.promptsMutedByUser && state.meetingSessionId) {
        state.status = "active";
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
        promptsMutedByUser: state.promptsMutedByUser
      };
    case "SET_AUTH_TOKEN":
      setSessionToken(message.token);
      state.userId = message.userId;
      chrome.storage.local.set({
        sessionToken: message.token,
        userId: message.userId
      });
      if (message.backendUrl) {
        chrome.storage.sync.set({ backendUrl: message.backendUrl });
      }
      return { ok: true };
    case "GET_BACKEND_URL": {
      const data = await new Promise((resolve) => {
        chrome.storage.sync.get({ backendUrl: "" }, resolve);
      });
      return { backendUrl: data.backendUrl || "" };
    }
    case "AUTHENTICATE":
      return handleAuthenticate(message.googleIdToken);
    case "ACK_PROMPT":
      return handleAckPrompt(message);
    case "START_AUDIO_CAPTURE":
      handleStartAudioCapture(message.meetingSessionId, message.captureMode);
      return { ok: true };
    case "STOP_AUDIO_CAPTURE":
      chrome.runtime.sendMessage({ type: "STOP_MIC_CAPTURE" }).catch(() => {
      });
      chrome.runtime.sendMessage({ type: "STOP_TAB_CAPTURE" }).catch(() => {
      });
      return { ok: true };
    case "AUDIO_TRANSCRIPT_RESULT":
      broadcastAudioTranscript(message);
      return { ok: true };
    case "COACHING_ACTIVE":
      return handleCoachingActive(message, sender);
    default:
      return { error: "Unknown message type" };
  }
}
async function handleAuthenticate(googleIdToken) {
  try {
    console.log("[GleaMeet] Authenticating with backend...");
    const result = await createSession(googleIdToken);
    state.userId = result.user_id;
    setSessionToken(result.session_token);
    chrome.storage.local.set({
      sessionToken: result.session_token,
      userId: result.user_id
    });
    await refreshMeetingContextFromTabs();
    broadcastStatus();
    console.log("[GleaMeet] Auth success, userId:", result.user_id);
    return {
      ok: true,
      userId: result.user_id,
      status: state.status,
      meetingDetected: state.meetingDetected,
      meetingSessionId: state.meetingSessionId,
      platform: state.platform
    };
  } catch (err) {
    console.error("[GleaMeet] Auth failed:", err.message);
    return { error: err.message };
  }
}
async function handleStartCoaching(message) {
  try {
    cancelTrackedMeetingTabCleanup();
    if (!getSessionToken()) {
      return { error: "Not authenticated. Please sign in first." };
    }
    const platform = await resolveActiveMeetingPlatform(message.platform);
    if (!platform) {
      return { error: "No supported web meeting tab detected." };
    }
    const captureMode = message.captureMode === "user_voice_only" ? "user_voice_only" : "full_meeting";
    const request = {
      platform,
      meeting_label: message.meetingLabel || null,
      extension_version: chrome.runtime.getManifest().version,
      consent: message.consent
    };
    request.consent.scope.capture_mode = captureMode;
    request.consent.scope.capture_other_participants = captureMode !== "user_voice_only";
    const response = await startMeeting(request);
    const meetingTab = await getPreferredMeetingTabAsync();
    state.meetingSessionId = response.meeting_session_id;
    state.platform = platform;
    state.meetingTabId = meetingTab?.id ?? state.meetingTabId;
    state.meetingDetected = true;
    state.status = "active";
    state.eventBuffer = [];
    state.captureMode = captureMode;
    state.promptsMutedByUser = false;
    state.coachingPausedByUser = false;
    startSessionIntervals();
    await sendMessageToMeetingTabs({
      type: "COACHING_STARTED",
      meetingSessionId: response.meeting_session_id,
      userId: state.userId,
      platform,
      captureMode
    });
    broadcastStatus();
    return { status: "active", meetingSessionId: response.meeting_session_id };
  } catch (err) {
    state.status = "error";
    broadcastStatus();
    return { error: err.message };
  }
}
async function handlePauseCoaching() {
  try {
    cancelTrackedMeetingTabCleanup();
    if (state.eventBuffer.length > 0) await flushEventBuffer().catch(() => {
    });
    if (state.batchInterval) {
      clearInterval(state.batchInterval);
      state.batchInterval = null;
    }
    if (state.pollingInterval) {
      clearInterval(state.pollingInterval);
      state.pollingInterval = null;
    }
    state.status = "ready";
    state.coachingPausedByUser = true;
    broadcastStatus();
    console.log("[GleaMeet] Coaching paused, session preserved:", state.meetingSessionId);
    return { status: "ready" };
  } catch (err) {
    console.error("[GleaMeet] Pause coaching failed:", err);
    return { error: err.message };
  }
}
async function handleStopCoaching() {
  try {
    cancelTrackedMeetingTabCleanup();
    if (state.meetingSessionId) {
      await flushEventBuffer();
      const result = await endMeeting(state.meetingSessionId);
      if (state.batchInterval) clearInterval(state.batchInterval);
      if (state.pollingInterval) clearInterval(state.pollingInterval);
      chrome.runtime.sendMessage({ type: "STOP_MIC_CAPTURE" }).catch(() => {
      });
      chrome.runtime.sendMessage({ type: "STOP_TAB_CAPTURE" }).catch(() => {
      });
      await sendMessageToMeetingTabs({ type: "DISMISS_ALL_PROMPTS" });
      state.meetingSessionId = null;
      state.meetingTabId = null;
      state.status = state.meetingDetected ? "ready" : "off";
      state.eventBuffer = [];
      state.captureMode = "full_meeting";
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
    state.status = state.meetingDetected ? "ready" : "off";
    state.coachingPausedByUser = false;
    if (!state.meetingDetected) {
      state.platform = null;
    }
    broadcastStatus();
    return { status: state.status };
  } catch (err) {
    state.status = "error";
    broadcastStatus();
    return { error: err.message };
  }
}
async function handleMeetingEnded() {
  try {
    cancelTrackedMeetingTabCleanup();
    const context = await getPreferredMeetingContext();
    const stillInActiveMeeting = !!context?.meetingDetected && (state.status === "active" || state.status === "muted" || !!state.meetingSessionId);
    if (stillInActiveMeeting) {
      state.meetingDetected = true;
      state.platform = context.platform ?? state.platform;
      if (state.status === "off") {
        state.status = context.status === "active" || context.status === "muted" ? context.status : "ready";
      }
      broadcastStatus();
      return { status: state.status, ignored: true };
    }
    return cleanupActiveMeetingSession("meeting-ended");
  } catch (err) {
    state.status = "error";
    broadcastStatus();
    return { error: err.message };
  }
}
async function handleCoachingActive(message, sender) {
  cancelTrackedMeetingTabCleanup();
  state.meetingDetected = true;
  state.meetingTabId = sender?.tab?.id ?? state.meetingTabId;
  state.platform = message.platform ?? state.platform;
  state.userId = message.userId ?? state.userId;
  state.captureMode = message.captureMode === "user_voice_only" ? "user_voice_only" : state.captureMode;
  if (message.meetingSessionId) {
    state.meetingSessionId = message.meetingSessionId;
  }
  if (state.meetingSessionId && !state.coachingPausedByUser && !state.promptsMutedByUser) {
    state.status = "active";
    startSessionIntervals();
  } else if (state.status === "off") {
    state.status = "ready";
  }
  broadcastStatus();
  return {
    status: state.status,
    meetingDetected: state.meetingDetected,
    meetingSessionId: state.meetingSessionId
  };
}
async function flushEventBuffer() {
  if (state.eventBuffer.length === 0 || !state.meetingSessionId) return;
  const events = [...state.eventBuffer];
  state.eventBuffer = [];
  try {
    const result = await sendEventBatch({
      meeting_session_id: state.meetingSessionId,
      events
    });
    if (result.prompts && result.prompts.length > 0) {
      for (const prompt of result.prompts) {
        broadcastPrompt(prompt);
      }
    }
  } catch (err) {
    state.eventBuffer.unshift(...events);
    console.error("[GleaMeet] Event batch failed:", err);
  }
}
async function pollForPrompts() {
  if (!state.meetingSessionId || state.promptsMutedByUser || state.coachingPausedByUser) return;
  if (state.status !== "active") {
    const context = await getPreferredMeetingContext();
    if (!context?.meetingDetected) return;
    state.meetingDetected = true;
    state.platform = context.platform ?? state.platform;
    state.status = "active";
    broadcastStatus();
  }
  try {
    const result = await pollPrompts(state.meetingSessionId);
    for (const prompt of result.prompts) {
      broadcastPrompt(prompt);
    }
  } catch (err) {
    console.error("[GleaMeet] Prompt poll failed:", err);
  }
}
async function handleAckPrompt(message) {
  try {
    const request = {
      prompt_id: message.promptId,
      meeting_session_id: message.meetingSessionId || state.meetingSessionId || "",
      action: message.action,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    await ackPrompt(request);
    return { ok: true };
  } catch (err) {
    console.error("[GleaMeet] Prompt ack failed:", err);
    return { error: err.message };
  }
}
function ensureOffscreenDocument() {
  return chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Audio capture for meeting transcription"
  }).catch(() => {
  });
}
function handleStartAudioCapture(meetingSessionId, captureMode = state.captureMode) {
  const token = getSessionToken();
  const apiBase = "https://gleameet.onrender.com";
  ensureOffscreenDocument().then(() => {
    chrome.runtime.sendMessage({
      type: "START_MIC_CAPTURE",
      meetingSessionId,
      sessionToken: token,
      apiBase
    }).catch(() => {
    });
    if (captureMode === "user_voice_only") {
      console.log("[GleaMeet] User-voice-only mode: skipping tab audio capture");
      return;
    }
    getPreferredMeetingTab((tab) => {
      if (!tab?.id) return;
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          console.warn("[GleaMeet] Tab capture unavailable:", chrome.runtime.lastError?.message || "missing stream id");
          return;
        }
        chrome.runtime.sendMessage({
          type: "START_TAB_CAPTURE",
          meetingSessionId,
          sessionToken: token,
          apiBase,
          streamId
        }).catch(() => {
        });
      });
    });
  });
}
function broadcastStatus() {
  persistActiveCoachingSession();
  chrome.runtime.sendMessage({
    type: "STATUS_UPDATE",
    status: state.status,
    meetingDetected: state.meetingDetected,
    meetingSessionId: state.meetingSessionId,
    platform: state.platform,
    captureMode: state.captureMode,
    promptsMutedByUser: state.promptsMutedByUser
  }).catch(() => {
  });
}
function persistActiveCoachingSession() {
  if (!state.meetingSessionId) {
    chrome.storage.local.remove("activeCoachingSession");
    return;
  }
  const snapshot = {
    meetingSessionId: state.meetingSessionId,
    userId: state.userId,
    platform: state.platform,
    meetingTabId: state.meetingTabId,
    status: state.status,
    captureMode: state.captureMode,
    promptsMutedByUser: state.promptsMutedByUser,
    coachingPausedByUser: state.coachingPausedByUser,
    updatedAt: Date.now()
  };
  chrome.storage.local.set({ activeCoachingSession: snapshot });
}
function cancelTrackedMeetingTabCleanup() {
  if (!meetingTabCleanupTimer) return;
  clearTimeout(meetingTabCleanupTimer);
  meetingTabCleanupTimer = null;
}
function scheduleTrackedMeetingTabCleanup(reason, delayMs) {
  if (!state.meetingSessionId && state.status === "off") return;
  cancelTrackedMeetingTabCleanup();
  meetingTabCleanupTimer = setTimeout(() => {
    meetingTabCleanupTimer = null;
    void cleanupIfTrackedMeetingTabIsGone(reason);
  }, delayMs);
}
async function cleanupIfTrackedMeetingTabIsGone(reason) {
  await authStateReady;
  if (reason === "tracked-tab-removed") {
    await cleanupActiveMeetingSession(reason);
    return;
  }
  const context = await getPreferredMeetingContext();
  if (context?.meetingDetected) {
    state.meetingDetected = true;
    state.platform = context.platform ?? state.platform;
    state.meetingTabId = context.tabId ?? state.meetingTabId;
    if (state.meetingSessionId && !state.coachingPausedByUser && !state.promptsMutedByUser) {
      state.status = "active";
      startSessionIntervals();
    } else if (state.status === "off") {
      state.status = "ready";
    }
    broadcastStatus();
    return;
  }
  await cleanupActiveMeetingSession(reason);
}
async function cleanupActiveMeetingSession(reason) {
  if (meetingCleanupInProgress) return meetingCleanupInProgress;
  meetingCleanupInProgress = (async () => {
    const sessionId = state.meetingSessionId;
    if (sessionId) {
      await flushEventBuffer().catch(() => {
      });
      await endMeeting(sessionId).catch((err) => {
        console.error(`[GleaMeet] End meeting cleanup failed (${reason}):`, err);
      });
    }
    await sendMessageToMeetingTabs({ type: "DISMISS_ALL_PROMPTS" }).catch(() => {
    });
    chrome.runtime.sendMessage({ type: "STOP_MIC_CAPTURE" }).catch(() => {
    });
    chrome.runtime.sendMessage({ type: "STOP_TAB_CAPTURE" }).catch(() => {
    });
    if (state.batchInterval) {
      clearInterval(state.batchInterval);
      state.batchInterval = null;
    }
    if (state.pollingInterval) {
      clearInterval(state.pollingInterval);
      state.pollingInterval = null;
    }
    state.meetingDetected = false;
    state.meetingSessionId = null;
    state.meetingTabId = null;
    state.platform = null;
    state.status = "off";
    state.eventBuffer = [];
    state.captureMode = "full_meeting";
    state.promptsMutedByUser = false;
    state.coachingPausedByUser = false;
    chrome.storage.local.remove("activeCoachingSession");
    broadcastStatus();
    return { status: "off" };
  })();
  try {
    return await meetingCleanupInProgress;
  } finally {
    meetingCleanupInProgress = null;
  }
}
function broadcastPrompt(prompt) {
  void sendMessageToMeetingTabs({
    type: "SHOW_PROMPT",
    prompt
  });
}
function broadcastAudioTranscript(message) {
  if (!message.text || !message.stream) return;
  void sendMessageToMeetingTabs({
    type: "AUDIO_TRANSCRIPT_RESULT",
    text: message.text,
    stream: message.stream,
    startOffsetMs: message.startOffsetMs,
    endOffsetMs: message.endOffsetMs,
    eventTimeMs: message.eventTimeMs
  });
}
function startSessionIntervals() {
  if (state.batchInterval) clearInterval(state.batchInterval);
  if (state.pollingInterval) clearInterval(state.pollingInterval);
  state.batchInterval = setInterval(flushEventBuffer, 3e3);
  state.pollingInterval = setInterval(pollForPrompts, 2e3);
  void pollForPrompts();
}
function getPreferredMeetingTab(callback) {
  getPreferredMeetingTabAsync().then(callback);
}
async function getPreferredMeetingTabAsync() {
  const tabs = await queryMeetingTabs();
  return tabs.find((tab) => tab.id === state.meetingTabId) ?? tabs.find((tab) => tab.active) ?? tabs[0];
}
async function refreshMeetingContextFromTabs() {
  const context = await getPreferredMeetingContext();
  if (context?.meetingDetected) {
    state.meetingDetected = true;
    state.platform = context.platform ?? state.platform;
    state.meetingTabId = context.tabId ?? state.meetingTabId;
    if (context.meetingSessionId && !state.meetingSessionId) {
      state.meetingSessionId = context.meetingSessionId;
      state.userId = context.userId ?? state.userId;
      state.captureMode = context.captureMode === "user_voice_only" ? "user_voice_only" : state.captureMode;
      state.status = context.status === "muted" && context.promptsMutedByUser ? "muted" : "active";
      state.promptsMutedByUser = context.status === "muted" && context.promptsMutedByUser === true;
      state.coachingPausedByUser = false;
      startSessionIntervals();
    } else if (state.meetingSessionId && state.status === "off") {
      state.status = context.status === "active" || context.status === "muted" ? context.status : "ready";
    } else if (!state.meetingSessionId && state.status === "off") {
      state.status = "ready";
    }
    return;
  }
  if (!state.meetingSessionId) {
    state.meetingDetected = false;
    state.platform = null;
    if (state.status === "ready" || state.status === "off") {
      state.status = "off";
    }
  }
}
async function getPreferredMeetingContext() {
  const tabs = await queryMeetingTabs();
  const orderedTabs = [
    ...tabs.filter((tab) => tab.active),
    ...tabs.filter((tab) => !tab.active)
  ];
  for (const tab of orderedTabs) {
    if (!tab.id) continue;
    const likelyMeetingUrl = isLikelyMeetingUrl(tab.url || "");
    const response = await ensureMeetingTabReady(tab);
    if (response?.meetingDetected) {
      return {
        meetingDetected: true,
        platform: response.platform ?? detectPlatformFromUrl(tab.url || ""),
        tabId: tab.id,
        status: response.status,
        meetingSessionId: response.meetingSessionId,
        userId: response.userId,
        captureMode: response.captureMode,
        promptsMutedByUser: response.promptsMutedByUser
      };
    }
    if (likelyMeetingUrl && (!response || tab.active)) {
      return {
        meetingDetected: true,
        platform: detectPlatformFromUrl(tab.url || ""),
        tabId: tab.id,
        status: "ready"
      };
    }
  }
  const preferredTab = orderedTabs[0];
  if (!preferredTab?.url) return null;
  return {
    meetingDetected: isLikelyMeetingUrl(preferredTab.url),
    platform: detectPlatformFromUrl(preferredTab.url),
    tabId: preferredTab.id
  };
}
function isLikelyMeetingUrl(url) {
  const platform = detectPlatformFromUrl(url);
  if (!platform) return false;
  const decodedUrl = decodeURIComponent(url);
  let path = decodedUrl;
  try {
    path = new URL(url).pathname;
  } catch (_err) {
  }
  if (platform === "google_meet") {
    return /meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/i.test(decodedUrl);
  }
  if (platform === "zoom") {
    return /\/wc\/\d+(?:\/(?:join|start|meeting))?(?:\/|$)/i.test(path);
  }
  if (platform === "teams") {
    return decodedUrl.includes("/meet/") || decodedUrl.includes("/callingv2") || decodedUrl.includes("/light-meetings/launch") || decodedUrl.includes("/l/meetup-join") || decodedUrl.includes("type=meet") || decodedUrl.includes("lightExperience=true");
  }
  return false;
}
async function queryMeetingTabs() {
  const [tabs, activeTab] = await Promise.all([
    new Promise((resolve) => {
      chrome.tabs.query({ url: [...MEETING_TAB_URL_PATTERNS] }, resolve);
    }),
    queryActiveTab()
  ]);
  const meetingTabs = [...tabs];
  if (activeTab?.id && isLikelyMeetingUrl(activeTab.url || "") && !meetingTabs.some((tab) => tab.id === activeTab.id)) {
    meetingTabs.unshift(activeTab);
  }
  if (!state.meetingTabId || meetingTabs.some((tab) => tab.id === state.meetingTabId)) {
    return meetingTabs;
  }
  const rememberedTab = await new Promise((resolve) => {
    chrome.tabs.get(state.meetingTabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve(null);
        return;
      }
      resolve(tab);
    });
  });
  return rememberedTab ? [rememberedTab, ...meetingTabs] : meetingTabs;
}
async function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      resolve(tabs[0] ?? null);
    });
  });
}
async function sendMessageToMeetingTabs(message) {
  const tabs = await queryMeetingTabs();
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) return;
      const context = await ensureMeetingTabReady(tab);
      const likelyMeetingUrl = isLikelyMeetingUrl(tab.url || "");
      const meetingDetected = !!context?.meetingDetected || likelyMeetingUrl;
      if (!context && !likelyMeetingUrl && message.type !== "DISMISS_ALL_PROMPTS") {
        return;
      }
      if (!meetingDetected && message.type !== "DISMISS_ALL_PROMPTS") {
        return;
      }
      if (tab.id && state.status === "active" && state.meetingSessionId && state.userId && message.type !== "COACHING_STARTED" && context?.status !== "active") {
        try {
          await chrome.tabs.sendMessage(tab.id, {
            type: "COACHING_STARTED",
            meetingSessionId: state.meetingSessionId,
            userId: state.userId,
            platform: state.platform,
            captureMode: state.captureMode
          });
        } catch (_syncErr) {
        }
      }
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch (_err) {
      }
    })
  );
}
async function ensureMeetingTabReady(tab) {
  if (!tab.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "GET_CONTENT_STATUS" });
  } catch (_err) {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["content.css"]
      });
    } catch (_cssErr) {
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
    } catch (_jsErr) {
      return null;
    }
    try {
      return await chrome.tabs.sendMessage(tab.id, { type: "GET_CONTENT_STATUS" });
    } catch (_retryErr) {
      return null;
    }
  }
}
async function resolveActiveMeetingPlatform(platformHint) {
  if (platformHint) return platformHint;
  if (state.platform) return state.platform;
  const tabs = await new Promise((resolve) => {
    chrome.tabs.query({ url: [...MEETING_TAB_URL_PATTERNS] }, resolve);
  });
  const preferredTab = tabs.find((tab) => tab.active) ?? tabs[0];
  return preferredTab?.url ? detectPlatformFromUrl(preferredTab.url) : null;
}
