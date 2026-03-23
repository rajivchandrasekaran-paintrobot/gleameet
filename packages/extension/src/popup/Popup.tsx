import React, { useState, useEffect } from 'react';
import { getHistory, getTranscript, setSessionToken } from '../utils/api-client';

type SessionStatus = 'off' | 'ready' | 'active' | 'muted' | 'error';
type View = 'main' | 'history' | 'transcript';

interface PopupState {
  status: SessionStatus;
  meetingSessionId: string | null;
  authenticated: boolean;
  userId: string | null;
}

interface MeetingEntry {
  meeting_session_id: string;
  meeting_label: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  transcript_available: boolean;
}

interface TranscriptEntry {
  speaker: 'user' | 'other';
  text: string;
  start_offset_ms: number;
}

interface TranscriptData {
  meeting_session_id: string;
  entries: TranscriptEntry[];
  saved_at: string;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export const Popup: React.FC = () => {
  const [state, setState] = useState<PopupState>({
    status: 'off',
    meetingSessionId: null,
    authenticated: false,
    userId: null,
  });
  const [view, setView] = useState<View>('main');
  const [meetings, setMeetings] = useState<MeetingEntry[]>([]);
  const [transcript, setTranscript] = useState<TranscriptData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Load session token from storage into api-client (popup has its own memory, separate from service worker)
    chrome.storage.local.get(['sessionToken'], (items) => {
      if (items.sessionToken) setSessionToken(items.sessionToken);
    });

    // Get current status from background
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
      if (response) {
        const isAuthenticated = response.authenticated || false;
        setState(prev => ({
          ...prev,
          status: response.status || 'off',
          meetingSessionId: response.meetingSessionId || null,
          authenticated: isAuthenticated,
          userId: response.userId || null,
        }));

        // If not yet authenticated, try silently — works if Chrome profile already has consent
        if (!isAuthenticated) {
          chrome.identity.getAuthToken({ interactive: false }, (token) => {
            if (!chrome.runtime.lastError && token) {
              chrome.runtime.sendMessage({ type: 'AUTHENTICATE', googleIdToken: token }, (res) => {
                if (res?.ok) {
                  setState(prev => ({ ...prev, authenticated: true, userId: res.userId }));
                }
              });
            }
            // If it fails silently, user will see the Sign In button as fallback
          });
        }
      }
    });

    // Listen for status updates
    const listener = (message: any) => {
      if (message.type === 'STATUS_UPDATE') {
        setState(prev => ({
          ...prev,
          status: message.status,
          meetingSessionId: message.meetingSessionId,
        }));
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const handleSignIn = () => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError || !token) {
        console.error("[GleaMeet] OAuth error:", chrome.runtime.lastError?.message);
        setState(prev => ({ ...prev, status: "error" }));
        return;
      }
      chrome.runtime.sendMessage({
        type: "AUTHENTICATE",
        googleIdToken: token,
      }, (response) => {
        if (response?.ok) {
          setState(prev => ({ ...prev, authenticated: true, userId: response.userId }));
        } else {
          setState(prev => ({ ...prev, status: "error" }));
        }
      });
    });
  };

  const handleStartCoaching = () => {
    chrome.runtime.sendMessage({
      type: 'START_COACHING',
      consent: {
        consent_version: '1.0',
        scope: {
          capture_audio_events: true,
          capture_transcript: true,
          capture_timing: true,
          live_coaching: true,
          post_meeting_report: true,
        },
      },
    });
  };

  const handleStopCoaching = () => {
    chrome.runtime.sendMessage({ type: 'STOP_COACHING' });
  };

  const handleMute = () => {
    chrome.runtime.sendMessage({ type: 'MUTE_COACHING' });
  };

  const handleUnmute = () => {
    chrome.runtime.sendMessage({ type: 'UNMUTE_COACHING' });
  };

  const handleShowHistory = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getHistory();
      setMeetings(data.meetings);
      setView('history');
    } catch (e: any) {
      setError(e.message || 'Failed to load history');
    } finally {
      setLoading(false);
    }
  };

  const handleShowTranscript = async (meetingSessionId: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await getTranscript(meetingSessionId);
      setTranscript(data);
      setView('transcript');
    } catch (e: any) {
      setError(e.message || 'Failed to load transcript');
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadTranscript = () => {
    if (!transcript) return;
    const lines = [
      'Gleameet Meeting Transcript',
      `Meeting: ${transcript.meeting_session_id}`,
      `Saved: ${transcript.saved_at}`,
      '',
    ];
    for (const entry of transcript.entries) {
      const ts = formatTimestamp(entry.start_offset_ms);
      const speaker = entry.speaker === 'user' ? 'You' : 'Other';
      lines.push(`[${ts}] ${speaker}: ${entry.text}`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${transcript.meeting_session_id.slice(0, 8)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const statusLabels: Record<SessionStatus, string> = {
    off: 'Not in a meeting',
    ready: 'Meeting detected',
    active: 'Coaching active',
    muted: 'Coaching muted',
    error: 'Error',
  };

  // Transcript view
  if (view === 'transcript' && transcript) {
    return (
      <div className="popup-container">
        <div className="popup-header">
          <button className="btn btn-secondary btn-sm" onClick={() => setView('history')}>
            ← Back
          </button>
          <h1>Transcript</h1>
        </div>
        <div className="transcript-actions">
          <button className="btn btn-primary btn-sm" onClick={handleDownloadTranscript}>
            ⬇ Download
          </button>
        </div>
        <div className="transcript-list">
          {transcript.entries.length === 0 && (
            <p className="empty-message">No transcript entries.</p>
          )}
          {transcript.entries.map((entry, i) => (
            <div key={i} className="transcript-entry">
              <div className="transcript-meta">
                <span className={`transcript-speaker speaker-${entry.speaker}`}>
                  {entry.speaker === 'user' ? 'You' : 'Other'}
                </span>
                <span className="transcript-time">{formatTimestamp(entry.start_offset_ms)}</span>
              </div>
              <div className="transcript-text">{entry.text}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // History view
  if (view === 'history') {
    return (
      <div className="popup-container">
        <div className="popup-header">
          <button className="btn btn-secondary btn-sm" onClick={() => setView('main')}>
            ← Back
          </button>
          <h1>Past Meetings</h1>
        </div>
        {error && <p className="error-message">{error}</p>}
        <div className="history-list">
          {meetings.length === 0 && (
            <p className="empty-message">No past meetings yet.</p>
          )}
          {meetings.map((m) => (
            <div key={m.meeting_session_id} className="history-entry">
              <div className="history-info">
                <div className="history-label">
                  {m.meeting_label || m.meeting_session_id.slice(0, 8)}
                </div>
                <div className="history-meta">
                  {formatDate(m.started_at)}
                  {m.duration_seconds != null && ` · ${formatDuration(m.duration_seconds)}`}
                </div>
              </div>
              {m.transcript_available && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleShowTranscript(m.meeting_session_id)}
                >
                  📄 Transcript
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Main view
  return (
    <div className="popup-container">
      <div className="popup-header">
        <h1>GleaMeet</h1>
      </div>

      {/* Status indicator (FR-008) */}
      <div className="meeting-info">
        <div className={`status-badge status-${state.status}`}>
          <span className="dot" />
          {statusLabels[state.status]}
        </div>
        {state.meetingSessionId && (
          <div style={{ fontSize: '11px', color: '#999', marginTop: '4px' }}>
            Session: {state.meetingSessionId.slice(0, 8)}...
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="controls">
        {!state.authenticated ? (
          <button className="btn btn-primary" onClick={handleSignIn}>
            Sign In
          </button>
        ) : (
          <>
            {state.status === 'ready' && (
              <button className="btn btn-primary" onClick={handleStartCoaching}>
                Enable Coaching
              </button>
            )}

            {state.status === 'active' && (
              <>
                <button className="btn btn-secondary" onClick={handleMute}>
                  Mute Prompts
                </button>
                <button className="btn btn-danger" onClick={handleStopCoaching}>
                  Stop Coaching
                </button>
              </>
            )}

            {state.status === 'muted' && (
              <>
                <button className="btn btn-primary" onClick={handleUnmute}>
                  Resume Prompts
                </button>
                <button className="btn btn-danger" onClick={handleStopCoaching}>
                  Stop Coaching
                </button>
              </>
            )}

            {state.status === 'off' && (
              <p style={{ fontSize: '13px', color: '#6b6b80', textAlign: 'center' }}>
                Join a Google Meet call to start coaching
              </p>
            )}

            {state.status === 'error' && (
              <p style={{ fontSize: '13px', color: '#cc0000', textAlign: 'center' }}>
                Connection error. Please try again.
              </p>
            )}
          </>
        )}
      </div>

      {/* History link */}
      {state.authenticated && (
        <div style={{ textAlign: 'center', marginTop: '12px' }}>
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); handleShowHistory(); }}
            style={{ fontSize: '12px', color: '#0066cc', textDecoration: 'none', cursor: 'pointer' }}
          >
            {loading ? 'Loading...' : '📋 Past Meetings'}
          </a>
        </div>
      )}

      {error && <p className="error-message">{error}</p>}

      {/* Privacy note (FR-063) */}
      <div className="privacy-note">
        Coaching is visible only to you
      </div>

      <div style={{ textAlign: 'center', marginTop: '8px' }}>
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); }}
          style={{ fontSize: '12px', color: '#6366f1', textDecoration: 'none', cursor: 'pointer' }}
        >
          ⚙ Settings
        </a>
      </div>
    </div>
  );
};
