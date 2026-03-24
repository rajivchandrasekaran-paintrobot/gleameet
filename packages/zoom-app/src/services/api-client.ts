const API_BASE = 'https://gleameet.onrender.com';

let sessionToken: string | null = null;

function getHeaders(): HeadersInit {
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (sessionToken) {
    headers['Authorization'] = `Bearer ${sessionToken}`;
  }
  return headers;
}

async function apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: getHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `API error: ${response.status}`);
  }

  return response.json();
}

export async function createSession(oauthToken: string): Promise<{ session_token: string; user_id: string }> {
  const result = await apiRequest<{ session_token: string; user_id: string }>('POST', '/auth/session', {
    google_id_token: oauthToken,
  });
  sessionToken = result.session_token;
  return result;
}

export async function startMeeting(request: {
  user_id: string;
  platform: 'zoom';
  meeting_label?: string;
  consent: {
    consent_version: string;
    scope: {
      capture_audio_events: boolean;
      capture_transcript: boolean;
      capture_timing: boolean;
      live_coaching: boolean;
      post_meeting_report: boolean;
    };
  };
}): Promise<{ meeting_session_id: string }> {
  return apiRequest('POST', '/meetings/start', request);
}

export async function pollPrompts(meetingSessionId: string): Promise<{ prompts: Array<{
  prompt_id: string;
  law_id: string;
  prompt_type: string;
  short_text: string;
  rationale_text: string;
  example_phrase?: string;
  confidence: number;
}> }> {
  return apiRequest('GET', `/prompts/poll?meeting_session_id=${meetingSessionId}`);
}

export async function ackPrompt(request: {
  prompt_id: string;
  meeting_session_id: string;
  action: 'shown' | 'dismissed' | 'expired';
}): Promise<{ status: string }> {
  return apiRequest('POST', '/prompts/ack', request);
}

export async function endMeeting(meetingSessionId: string): Promise<{ report_id: string; status: string }> {
  return apiRequest('POST', '/meetings/end', { meeting_session_id: meetingSessionId });
}

export async function getReport(meetingSessionId: string): Promise<{
  report_id: string;
  meeting_session_id: string;
  summary_analysis: string;
  strengths_json: string[];
  growth_areas_json: string[];
  summary_json: { recommended_actions: Array<{ action: string; reason: string }> };
  transcript_with_nudges: Array<{
    type: 'speech' | 'nudge' | 'reinforcement';
    speaker?: 'user' | 'other';
    text: string;
    timestamp_ms: number;
  }>;
}> {
  return apiRequest('GET', `/reports/${meetingSessionId}`);
}

export async function getHistory(): Promise<{ meetings: Array<{
  meeting_session_id: string;
  meeting_label: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  transcript_available: boolean;
  report_available: boolean;
}> }> {
  return apiRequest('GET', '/history');
}

export async function transcribeAudio(blob: Blob, stream: 'mic' | 'tab', meetingSessionId: string): Promise<{ text: string; stream: string }> {
  const formData = new FormData();
  formData.append('audio', blob, 'chunk.webm');
  formData.append('stream', stream);
  formData.append('meeting_session_id', meetingSessionId);

  const headers: HeadersInit = {};
  if (sessionToken) {
    headers['Authorization'] = `Bearer ${sessionToken}`;
  }

  const response = await fetch(`${API_BASE}/audio/transcribe`, {
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

export function setSessionToken(token: string): void {
  sessionToken = token;
}

export function getSessionToken(): string | null {
  return sessionToken;
}
