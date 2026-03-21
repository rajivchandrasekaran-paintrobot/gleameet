import React, { useState, useEffect } from 'react';

type SessionStatus = 'off' | 'ready' | 'active' | 'muted' | 'error';

interface PopupState {
  status: SessionStatus;
  meetingSessionId: string | null;
  authenticated: boolean;
  userId: string | null;
}

export const Popup: React.FC = () => {
  const [state, setState] = useState<PopupState>({
    status: 'off',
    meetingSessionId: null,
    authenticated: false,
    userId: null,
  });

  useEffect(() => {
    // Get current status from background
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
      if (response) {
        setState(prev => ({
          ...prev,
          status: response.status || 'off',
          meetingSessionId: response.meetingSessionId || null,
          authenticated: response.authenticated || false,
          userId: response.userId || null,
        }));
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
    // In production, this would trigger Google OAuth flow via chrome.identity.
    // For v1, use a mock token.
    chrome.runtime.sendMessage({
      type: 'AUTHENTICATE',
      googleIdToken: `mock-user-${Date.now()}`,
    }, (response) => {
      if (response?.ok) {
        setState(prev => ({ ...prev, authenticated: true, userId: response.userId }));
      }
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

  const statusLabels: Record<SessionStatus, string> = {
    off: 'Not in a meeting',
    ready: 'Meeting detected',
    active: 'Coaching active',
    muted: 'Coaching muted',
    error: 'Error',
  };

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
