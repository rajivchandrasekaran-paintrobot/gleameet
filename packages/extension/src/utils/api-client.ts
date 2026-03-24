import type {
  AuthSessionRequest, AuthSessionResponse,
  MeetingStartRequest, MeetingStartResponse,
  EventsBatchRequest, EventsBatchResponse,
  PromptPollResponse,
  PromptAckRequest, PromptAckResponse,
  MeetingEndRequest, MeetingEndResponse,
  HistoryResponse, TranscriptResponse,
  ReportResponse,
} from '@gleameet/shared';

const DEFAULT_API_BASE = 'https://gleameet.onrender.com';

/** Resolve the backend URL from chrome.storage.sync (falls back to localhost) */
async function getApiBase(): Promise<string> {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
      chrome.storage.sync.get({ backendUrl: DEFAULT_API_BASE }, (items) => {
        resolve(items.backendUrl || DEFAULT_API_BASE);
      });
    } else {
      resolve(DEFAULT_API_BASE);
    }
  });
}

/** Stored session token for authenticated requests */
let sessionToken: string | null = null;

function getHeaders(): HeadersInit {
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (sessionToken) {
    headers['Authorization'] = `Bearer ${sessionToken}`;
  }
  return headers;
}

async function refreshSessionIfNeeded(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.identity) { resolve(); return; }
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (!token || chrome.runtime.lastError) { resolve(); return; }
      createSession(token).then(() => resolve()).catch(() => resolve());
    });
  });
}

async function apiRequest<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const apiBase = await getApiBase();
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: getHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  // Auto-reauth on 401 — session token expired or Redis restarted
  if (response.status === 401 && retry) {
    await refreshSessionIfNeeded();
    return apiRequest<T>(method, path, body, false);
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `API error: ${response.status}`);
  }

  return response.json();
}

/** POST /auth/session — Authenticate with Google ID token */
export async function createSession(googleIdToken: string): Promise<AuthSessionResponse> {
  const result = await apiRequest<AuthSessionResponse>('POST', '/auth/session', {
    google_id_token: googleIdToken,
  } as AuthSessionRequest);
  sessionToken = result.session_token;
  return result;
}

/** POST /meetings/start — Start a coached meeting session */
export async function startMeeting(request: MeetingStartRequest): Promise<MeetingStartResponse> {
  return apiRequest<MeetingStartResponse>('POST', '/meetings/start', request);
}

/** POST /events/batch — Send event batch to backend */
export async function sendEventBatch(request: EventsBatchRequest): Promise<EventsBatchResponse> {
  return apiRequest<EventsBatchResponse>('POST', '/events/batch', request);
}

/** GET /prompts/poll — Poll for pending prompts */
export async function pollPrompts(meetingSessionId: string): Promise<PromptPollResponse> {
  return apiRequest<PromptPollResponse>('GET', `/prompts/poll?meeting_session_id=${meetingSessionId}`);
}

/** POST /prompts/ack — Acknowledge a prompt action */
export async function ackPrompt(request: PromptAckRequest): Promise<PromptAckResponse> {
  return apiRequest<PromptAckResponse>('POST', '/prompts/ack', request);
}

/** POST /meetings/end — End a meeting session */
export async function endMeeting(meetingSessionId: string): Promise<MeetingEndResponse> {
  return apiRequest<MeetingEndResponse>('POST', '/meetings/end', {
    meeting_session_id: meetingSessionId,
  } as MeetingEndRequest);
}

/** GET /history — Fetch past meeting sessions */
export async function getHistory(): Promise<HistoryResponse> {
  return apiRequest<HistoryResponse>('GET', '/history');
}

/** GET /history/:meeting_session_id/transcript — Fetch meeting transcript */
export async function getTranscript(meetingSessionId: string): Promise<TranscriptResponse> {
  return apiRequest<TranscriptResponse>('GET', `/history/${meetingSessionId}/transcript`);
}

/** GET /reports/:meeting_session_id — Fetch post-meeting report */
export async function getReport(meetingSessionId: string): Promise<ReportResponse> {
  return apiRequest<ReportResponse>('GET', `/reports/${meetingSessionId}`);
}

/** DELETE /meetings/:meeting_session_id — Delete a meeting and all associated data */
export async function deleteMeeting(meetingSessionId: string): Promise<{ deletion_audit_id: string; status: string }> {
  return apiRequest('DELETE', `/meetings/${meetingSessionId}`);
}

/** POST /audio/transcribe — Send audio chunk for Whisper transcription */
export async function transcribeAudio(blob: Blob, stream: 'mic' | 'tab', meetingSessionId: string): Promise<{ text: string; stream: string }> {
  const apiBase = await getApiBase();
  const formData = new FormData();
  formData.append('audio', blob, 'chunk.webm');
  formData.append('stream', stream);
  formData.append('meeting_session_id', meetingSessionId);

  const headers: HeadersInit = {};
  if (sessionToken) {
    headers['Authorization'] = `Bearer ${sessionToken}`;
  }

  const response = await fetch(`${apiBase}/audio/transcribe`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `API error: ${response.status}`);
  }

  return response.json();
}

/** Set the session token (e.g., from storage) */
export function setSessionToken(token: string): void {
  sessionToken = token;
}

/** Get the current session token */
export function getSessionToken(): string | null {
  return sessionToken;
}
