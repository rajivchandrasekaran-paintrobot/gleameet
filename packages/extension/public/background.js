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
async function apiRequest(method, path, body) {
  const apiBase = await getApiBase();
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: getHeaders(),
    body: body ? JSON.stringify(body) : void 0
  });
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
async function transcribeAudio(blob, stream, meetingSessionId) {
  const apiBase = await getApiBase();
  const formData = new FormData();
  formData.append("audio", blob, "chunk.webm");
  formData.append("stream", stream);
  formData.append("meeting_session_id", meetingSessionId);
  const headers = {};
  if (sessionToken) {
    headers["Authorization"] = `Bearer ${sessionToken}`;
  }
  const response = await fetch(`${apiBase}/audio/transcribe`, {
    method: "POST",
    headers,
    body: formData
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(error.error || `API error: ${response.status}`);
  }
  return response.json();
}
function setSessionToken(token) {
  sessionToken = token;
}
function getSessionToken() {
  return sessionToken;
}

// src/utils/event-factory.ts
function generateUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}
function createEvent(meetingSessionId, userId, eventType, payload, captureConfidence = null) {
  return {
    event_id: generateUUID(),
    meeting_session_id: meetingSessionId,
    user_id: userId,
    platform: "google_meet",
    event_type: eventType,
    event_time_utc: (/* @__PURE__ */ new Date()).toISOString(),
    source: "extension",
    capture_confidence: captureConfidence,
    payload
  };
}

// src/background/service-worker.ts
var state = {
  meetingSessionId: null,
  userId: null,
  status: "off",
  eventBuffer: [],
  pollingInterval: null,
  batchInterval: null,
  audioRecorders: [],
  audioIntervals: []
};
chrome.storage.local.get(["sessionToken", "userId"], (data) => {
  if (data.sessionToken) {
    setSessionToken(data.sessionToken);
    state.userId = data.userId || null;
  }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err) => sendResponse({ error: err.message }));
  return true;
});
async function handleMessage(message) {
  switch (message.type) {
    case "MEETING_DETECTED":
      state.status = "ready";
      broadcastStatus();
      return { status: "ready" };
    case "START_COACHING":
      return handleStartCoaching(message);
    case "STOP_COACHING":
      return handleStopCoaching();
    case "MUTE_COACHING":
      state.status = "muted";
      broadcastStatus();
      return { status: "muted" };
    case "UNMUTE_COACHING":
      state.status = "active";
      broadcastStatus();
      return { status: "active" };
    case "INGEST_EVENT":
      if (state.status === "active" && message.event) {
        state.eventBuffer.push(message.event);
      }
      return { buffered: true };
    case "GET_STATUS":
      return {
        status: state.status,
        meetingSessionId: state.meetingSessionId,
        userId: state.userId,
        authenticated: !!getSessionToken()
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
    default:
      return { error: "Unknown message type" };
  }
}
async function handleAuthenticate(googleIdToken) {
  try {
    const result = await createSession(googleIdToken);
    state.userId = result.user_id;
    chrome.storage.local.set({
      sessionToken: result.session_token,
      userId: result.user_id
    });
    return { ok: true, userId: result.user_id };
  } catch (err) {
    return { error: err.message };
  }
}
function startAudioCapture(meetingSessionId) {
  chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
    if (!stream) {
      console.warn("[GleaMeet] Tab audio capture failed \u2014 no stream returned");
      return;
    }
    recordAndTranscribe(stream, "tab", meetingSessionId);
  });
  navigator.mediaDevices.getUserMedia({ audio: true }).then((micStream) => {
    recordAndTranscribe(micStream, "mic", meetingSessionId);
  }).catch((e) => {
    console.warn("[GleaMeet] Mic capture failed:", e);
  });
}
function recordAndTranscribe(stream, streamType, meetingSessionId) {
  const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
  let chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: "audio/webm" });
    chunks = [];
    if (blob.size < 1e3) return;
    try {
      const { text } = await transcribeAudio(blob, streamType, meetingSessionId);
      if (text?.trim() && state.userId) {
        const speaker = streamType === "mic" ? "user" : "other";
        const event = createEvent(
          meetingSessionId,
          state.userId,
          "transcript_segment",
          {
            text: text.trim(),
            speaker,
            start_offset_ms: Date.now(),
            end_offset_ms: Date.now()
          },
          0.9
        );
        if (state.status === "active") {
          state.eventBuffer.push(event);
        }
      }
    } catch (err) {
      console.error(`[GleaMeet] Whisper transcription failed (${streamType}):`, err);
    }
  };
  recorder.start();
  const interval = setInterval(() => {
    if (recorder.state === "recording") {
      recorder.stop();
      recorder.start();
    }
  }, 1e4);
  state.audioRecorders.push(recorder);
  state.audioIntervals.push(interval);
}
function stopAudioCapture() {
  for (const interval of state.audioIntervals) {
    clearInterval(interval);
  }
  for (const recorder of state.audioRecorders) {
    if (recorder.state === "recording") {
      try {
        recorder.stop();
      } catch (_) {
      }
    }
    recorder.stream.getTracks().forEach((t) => t.stop());
  }
  state.audioRecorders = [];
  state.audioIntervals = [];
}
async function handleStartCoaching(message) {
  try {
    if (!getSessionToken()) {
      return { error: "Not authenticated. Please sign in first." };
    }
    const request = {
      platform: "google_meet",
      meeting_label: message.meetingLabel || null,
      extension_version: chrome.runtime.getManifest().version,
      consent: message.consent
    };
    const response = await startMeeting(request);
    state.meetingSessionId = response.meeting_session_id;
    state.status = "active";
    state.eventBuffer = [];
    state.batchInterval = setInterval(flushEventBuffer, 3e3);
    state.pollingInterval = setInterval(pollForPrompts, 2e3);
    startAudioCapture(response.meeting_session_id);
    chrome.tabs.query({ url: "https://meet.google.com/*" }, (tabs) => {
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, {
            type: "COACHING_STARTED",
            meetingSessionId: response.meeting_session_id,
            userId: state.userId
          }).catch(() => {
          });
        }
      }
    });
    broadcastStatus();
    return { status: "active", meetingSessionId: response.meeting_session_id };
  } catch (err) {
    state.status = "error";
    broadcastStatus();
    return { error: err.message };
  }
}
async function handleStopCoaching() {
  try {
    if (state.meetingSessionId) {
      await flushEventBuffer();
      const result = await endMeeting(state.meetingSessionId);
      stopAudioCapture();
      if (state.batchInterval) clearInterval(state.batchInterval);
      if (state.pollingInterval) clearInterval(state.pollingInterval);
      chrome.tabs.query({ url: "https://meet.google.com/*" }, (tabs) => {
        for (const tab of tabs) {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, { type: "DISMISS_ALL_PROMPTS" }).catch(() => {
            });
          }
        }
      });
      state.meetingSessionId = null;
      state.status = "off";
      state.eventBuffer = [];
      state.batchInterval = null;
      state.pollingInterval = null;
      broadcastStatus();
      return { status: "off", reportId: result.report_id };
    }
    return { status: "off" };
  } catch (err) {
    state.status = "error";
    broadcastStatus();
    return { error: err.message };
  }
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
  if (!state.meetingSessionId || state.status !== "active") return;
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
function broadcastStatus() {
  chrome.runtime.sendMessage({
    type: "STATUS_UPDATE",
    status: state.status,
    meetingSessionId: state.meetingSessionId
  }).catch(() => {
  });
}
function broadcastPrompt(prompt) {
  chrome.tabs.query({ url: "https://meet.google.com/*" }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: "SHOW_PROMPT",
          prompt
        }).catch(() => {
        });
      }
    }
  });
}
