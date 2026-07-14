import React, { useState, useEffect } from 'react';
import { getHistory, getTranscript, getReport, deleteMeeting, setSessionToken } from '../utils/api-client';
import { detectPlatformFromUrl, getPlatformDisplayName, MEETING_TAB_URL_PATTERNS } from '../utils/platform';
import type { Platform, PostMeetingReport, TranscriptWithNudgesEntry } from '@gleameet/shared';

type SessionStatus = 'off' | 'ready' | 'active' | 'muted' | 'error';
type View = 'main' | 'history' | 'transcript' | 'report';
type ReportTab = 'summary' | 'transcript-nudges';
type CaptureMode = 'full_meeting' | 'user_voice_only';

interface PopupState {
  status: SessionStatus;
  meetingDetected: boolean;
  meetingSessionId: string | null;
  authenticated: boolean;
  userId: string | null;
  platform: Platform | null;
}

interface TabMeetingContext {
  meetingDetected?: boolean;
  platform?: Platform | null;
  status?: SessionStatus;
  meetingSessionId?: string | null;
  userId?: string | null;
}

interface MeetingEntry {
  meeting_session_id: string;
  meeting_label: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  transcript_available: boolean;
  report_available: boolean;
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

function reconcilePopupState(prev: PopupState, update: Partial<PopupState>): PopupState {
  const meetingSessionId = update.meetingSessionId !== undefined ? update.meetingSessionId : prev.meetingSessionId;
  const meetingDetected = update.meetingDetected !== undefined ? update.meetingDetected : prev.meetingDetected;
  let status = update.status || prev.status;

  if (
    status === 'off' &&
    meetingSessionId &&
    meetingDetected
  ) {
    status = 'active';
  }

  return {
    ...prev,
    ...update,
    status,
    meetingDetected: !!meetingDetected,
    meetingSessionId: meetingSessionId || null,
  };
}

function queryMeetingTabContext(): Promise<Partial<PopupState> | null> {
  return new Promise((resolve) => {
    collectPopupMeetingTabs().then((tabs) => {
      const orderedTabs = [
        ...tabs.filter(tab => tab.active),
        ...tabs.filter(tab => !tab.active),
      ];

      const checkNext = (index: number) => {
        const tab = orderedTabs[index];
        if (!tab?.id) {
          resolve(null);
          return;
        }

        chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTENT_STATUS' }, (response: TabMeetingContext | undefined) => {
          if (!chrome.runtime.lastError && response?.meetingDetected) {
            const status = response.meetingSessionId && response.status === 'off'
              ? 'active'
              : response.status;
            const tabState: Partial<PopupState> = {
              status,
              meetingDetected: true,
              userId: response.userId || null,
              platform: response.platform ?? detectPlatformFromUrl(tab.url || ''),
            };
            if (response.meetingSessionId !== undefined) {
              tabState.meetingSessionId = response.meetingSessionId || null;
            }
            resolve(tabState);
            return;
          }

          const platform = detectPlatformFromUrl(tab.url || '');
          if (tab.url && platform) {
            resolve({
              status: 'ready',
              meetingDetected: true,
              platform,
            });
            return;
          }

          checkNext(index + 1);
        });
      };

      checkNext(0);
    });
  });
}

async function collectPopupMeetingTabs(): Promise<chrome.tabs.Tab[]> {
  const [meetingTabs, activeTab] = await Promise.all([
    new Promise<chrome.tabs.Tab[]>((resolve) => {
      chrome.tabs.query({ url: [...MEETING_TAB_URL_PATTERNS] }, resolve);
    }),
    new Promise<chrome.tabs.Tab | null>((resolve) => {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        resolve(tabs[0] ?? null);
      });
    }),
  ]);

  const tabs = [...meetingTabs];
  if (activeTab?.id && detectPlatformFromUrl(activeTab.url || '') && !tabs.some(tab => tab.id === activeTab.id)) {
    tabs.unshift(activeTab);
  }
  return tabs;
}

export const Popup: React.FC = () => {
  const extensionVersion = chrome.runtime.getManifest().version;
  const [state, setState] = useState<PopupState>({
    status: 'off',
    meetingDetected: false,
    meetingSessionId: null,
    authenticated: false,
    userId: null,
    platform: null,
  });
  const [view, setView] = useState<View>('main');
  const [meetings, setMeetings] = useState<MeetingEntry[]>([]);
  const [transcript, setTranscript] = useState<TranscriptData | null>(null);
  const [report, setReport] = useState<PostMeetingReport | null>(null);
  const [reportTab, setReportTab] = useState<ReportTab>('summary');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [captureMode, setCaptureMode] = useState<CaptureMode>('full_meeting');

  useEffect(() => {
    let statusPoll: ReturnType<typeof setInterval> | null = null;

    const refreshStatus = () => {
      chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
        if (!response) return;

        const isAuthenticated = response.authenticated || false;
        setState(prev => reconcilePopupState(prev, {
          status: response.status || 'off',
          meetingDetected: response.meetingDetected ?? false,
          meetingSessionId: response.meetingSessionId || null,
          authenticated: isAuthenticated,
          userId: response.userId || prev.userId,
          platform: response.platform || null,
        }));

        void queryMeetingTabContext().then((tabState) => {
          if (!tabState) return;
          setState(prev => reconcilePopupState(prev, tabState));
        });

        if (!isAuthenticated) {
          chrome.identity.getAuthToken({ interactive: false }, (token) => {
            if (!chrome.runtime.lastError && token) {
              chrome.runtime.sendMessage({ type: 'AUTHENTICATE', googleIdToken: token }, (res) => {
                if (res?.ok) {
                  setState(prev => reconcilePopupState(prev, {
                    authenticated: true,
                    userId: res.userId || prev.userId,
                    status: res.status || prev.status,
                    meetingDetected: res.meetingDetected ?? prev.meetingDetected,
                    meetingSessionId: res.meetingSessionId || prev.meetingSessionId,
                    platform: res.platform || prev.platform,
                  }));
                }
              });
            }
          });
        }
      });
    };

    // Load session token from storage into api-client (popup has its own memory, separate from service worker)
    chrome.storage.local.get(['sessionToken', 'userId'], (items) => {
      if (items.sessionToken) {
        setSessionToken(items.sessionToken);
        setState(prev => ({
          ...prev,
          authenticated: true,
          userId: items.userId || prev.userId,
        }));
      }
    });
    chrome.storage.sync.get({ captureMode: 'full_meeting' }, (items) => {
      if (items.captureMode === 'user_voice_only' || items.captureMode === 'full_meeting') {
        setCaptureMode(items.captureMode);
      }
    });

    refreshStatus();
    statusPoll = setInterval(refreshStatus, 2000);

    // Listen for status updates
    const listener = (message: any) => {
      if (message.type === 'STATUS_UPDATE') {
        setState(prev => reconcilePopupState(prev, {
          status: message.status,
          meetingDetected: message.meetingDetected ?? prev.meetingDetected,
          meetingSessionId: message.meetingSessionId,
          platform: message.platform || null,
        }));
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      if (statusPoll) clearInterval(statusPoll);
    };
  }, []);

  const handleSignIn = () => {
    // First remove any cached token to force fresh consent with correct scopes
    chrome.identity.getAuthToken({ interactive: false }, (cachedToken) => {
      const doAuth = () => {
        chrome.identity.getAuthToken({ interactive: true }, (token) => {
          if (chrome.runtime.lastError || !token) {
            console.error("[GleaMeet] OAuth error:", chrome.runtime.lastError?.message);
            setError(chrome.runtime.lastError?.message || 'OAuth failed');
            setState(prev => ({ ...prev, status: "error" }));
            return;
          }
          chrome.runtime.sendMessage({
            type: "AUTHENTICATE",
            googleIdToken: token,
          }, (response) => {
            if (response?.ok) {
              setState(prev => reconcilePopupState(prev, {
                authenticated: true,
                userId: response.userId,
                status: response.status || prev.status,
                meetingDetected: response.meetingDetected ?? prev.meetingDetected,
                meetingSessionId: response.meetingSessionId || prev.meetingSessionId,
                platform: response.platform || prev.platform,
              }));
            } else {
              console.error('[GleaMeet] Auth response error:', response?.error);
              setError(response?.error || 'Sign in failed');
              setState(prev => ({ ...prev, status: "error" }));
            }
          });
        });
      };

      if (cachedToken) {
        // Remove cached token so we get a fresh one with current scopes
        chrome.identity.removeCachedAuthToken({ token: cachedToken }, doAuth);
      } else {
        doAuth();
      }
    });
  };

  const handleCaptureModeChange = (mode: CaptureMode) => {
    setCaptureMode(mode);
    chrome.storage.sync.set({ captureMode: mode });
  };

  const handleStartCoaching = () => {
    const captureOtherParticipants = captureMode !== 'user_voice_only';
    chrome.runtime.sendMessage({
      type: 'START_COACHING',
      captureMode,
      consent: {
        consent_version: '1.0',
        scope: {
          capture_audio_events: true,
          capture_transcript: true,
          capture_timing: true,
          live_coaching: true,
          post_meeting_report: true,
          capture_mode: captureMode,
          capture_other_participants: captureOtherParticipants,
        },
      },
    });
  };

  const handleStopCoaching = () => {
    chrome.runtime.sendMessage({ type: 'STOP_COACHING' });
  };

  const handleEndMeeting = () => {
    chrome.runtime.sendMessage({ type: 'END_MEETING' });
  };

  const handleMute = () => {
    chrome.runtime.sendMessage({ type: 'MUTE_COACHING' });
  };

  const handleUnmute = () => {
    chrome.runtime.sendMessage({ type: 'UNMUTE_COACHING' });
  };

  const ensureToken = (): Promise<void> => new Promise((resolve, reject) => {
    chrome.storage.local.get(['sessionToken', 'userId'], (items) => {
      if (items.sessionToken) {
        setSessionToken(items.sessionToken);
        setState(prev => ({
          ...prev,
          authenticated: true,
          userId: items.userId || prev.userId,
        }));
        resolve();
        return;
      }

      chrome.identity.getAuthToken({ interactive: false }, (token) => {
        if (chrome.runtime.lastError || !token) {
          reject(new Error('Sign in required'));
          return;
        }

        chrome.runtime.sendMessage({ type: 'AUTHENTICATE', googleIdToken: token }, (response) => {
          if (response?.ok) {
            setState(prev => reconcilePopupState(prev, {
              authenticated: true,
              userId: response.userId || prev.userId,
              status: response.status || prev.status,
              meetingDetected: response.meetingDetected ?? prev.meetingDetected,
              meetingSessionId: response.meetingSessionId || prev.meetingSessionId,
              platform: response.platform || prev.platform,
            }));
            resolve();
            return;
          }

          reject(new Error(response?.error || 'Sign in required'));
        });
      });
    });
  });

  const handleShowHistory = async () => {
    setLoading(true);
    setError(null);
    try {
      await ensureToken();
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
      await ensureToken();
      const data = await getTranscript(meetingSessionId);
      setTranscript(data);
      setView('transcript');
    } catch (e: any) {
      setError(e.message || 'Failed to load transcript');
    } finally {
      setLoading(false);
    }
  };

  const handleShowReport = async (meetingSessionId: string) => {
    setLoading(true);
    setError(null);
    try {
      await ensureToken();
      const data = await getReport(meetingSessionId);
      setReport(data);
      setReportTab('summary');
      setView('report');
    } catch (e: any) {
      setError(e.message || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteMeeting = async (meetingSessionId: string) => {
    setError(null);
    try {
      await ensureToken();
      await deleteMeeting(meetingSessionId);
      setMeetings(prev => prev.filter(m => m.meeting_session_id !== meetingSessionId));
      setDeletingId(null);
    } catch (e: any) {
      setError(e.message || 'Failed to delete meeting');
      setDeletingId(null);
    }
  };

  const handleDownloadReport = () => {
    if (!report) return;
    const lines: string[] = [];

    lines.push('=== MEETING ANALYSIS ===');
    if (report.summary_analysis) {
      lines.push(report.summary_analysis);
    }
    lines.push('');

    lines.push('=== STRENGTHS ===');
    for (const s of report.strengths_json) {
      lines.push(`- ${s}`);
    }
    lines.push('');

    lines.push('=== GROWTH AREAS ===');
    for (const g of report.growth_areas_json) {
      lines.push(`- ${g}`);
    }
    lines.push('');

    lines.push('=== RECOMMENDED ACTIONS ===');
    report.summary_json.recommended_actions.forEach((ra, i) => {
      lines.push(`${i + 1}. ${ra.action} — Why: ${ra.reason}`);
    });
    lines.push('');

    lines.push('=== TRANSCRIPT WITH COACHING ===');
    if (report.transcript_with_nudges) {
      for (const entry of report.transcript_with_nudges) {
        const ts = formatTimestamp(entry.timestamp_ms);
        if (entry.type === 'speech') {
          const speaker = entry.speaker === 'user' ? 'You' : 'Other';
          lines.push(`[${ts}] ${speaker}: ${entry.text}`);
        } else if (entry.type === 'nudge') {
          lines.push(`[COACH NUDGE] ${entry.text}`);
        } else {
          lines.push(`[COACH REINFORCEMENT] ${entry.text}`);
        }
      }
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `report-${report.meeting_session_id.slice(0, 8)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
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
    ready: state.meetingSessionId ? 'Coaching paused' : (state.meetingDetected ? 'Meeting detected' : 'Ready'),
    active: 'Coaching active',
    muted: 'Coaching muted',
    error: 'Error',
  };
  const platformLabel = getPlatformDisplayName(state.platform);

  // Report view
  if (view === 'report' && report) {
    return (
      <div className="popup-container">
        <div className="popup-header">
          <button className="btn btn-secondary btn-sm" onClick={() => setView('history')}>
            ← Back
          </button>
          <h1>Report</h1>
          <button className="btn btn-primary btn-sm" onClick={handleDownloadReport} style={{ marginLeft: 'auto' }}>
            ⬇ Download
          </button>
        </div>
        <div className="report-tabs">
          <button
            className={`report-tab ${reportTab === 'summary' ? 'report-tab-active' : ''}`}
            onClick={() => setReportTab('summary')}
          >
            Summary
          </button>
          <button
            className={`report-tab ${reportTab === 'transcript-nudges' ? 'report-tab-active' : ''}`}
            onClick={() => setReportTab('transcript-nudges')}
          >
            Transcript + Nudges
          </button>
        </div>

        {reportTab === 'summary' && (
          <div className="report-section">
            {report.summary_analysis && (
              <div className="report-block">
                <p className="report-narrative">{report.summary_analysis}</p>
              </div>
            )}
            {report.strengths_json.length > 0 && (
              <div className="report-block">
                <h3 className="report-block-title">Strengths</h3>
                <ul className="report-list">
                  {report.strengths_json.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
            {report.growth_areas_json.length > 0 && (
              <div className="report-block">
                <h3 className="report-block-title">Growth Areas</h3>
                <ul className="report-list">
                  {report.growth_areas_json.map((g, i) => <li key={i}>{g}</li>)}
                </ul>
              </div>
            )}
            {report.summary_json.recommended_actions.length > 0 && (
              <div className="report-block">
                <h3 className="report-block-title">Recommended Actions</h3>
                <ul className="report-list">
                  {report.summary_json.recommended_actions.map((ra, i) => (
                    <li key={i}>
                      <strong>{ra.action}</strong>
                      <span className="report-action-reason"> — {ra.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {reportTab === 'transcript-nudges' && (
          <div className="report-transcript-list">
            {(!report.transcript_with_nudges || report.transcript_with_nudges.length === 0) && (
              <p className="empty-message">No annotated transcript available.</p>
            )}
            {report.transcript_with_nudges?.map((entry, i) => {
              if (entry.type === 'speech') {
                return (
                  <div key={i} className="transcript-entry">
                    <div className="transcript-meta">
                      <span className={`transcript-speaker speaker-${entry.speaker}`}>
                        {entry.speaker === 'user' ? 'You' : 'Other'}
                      </span>
                      <span className="transcript-time">{formatTimestamp(entry.timestamp_ms)}</span>
                    </div>
                    <div className="transcript-text">{entry.text}</div>
                  </div>
                );
              }
              if (entry.type === 'nudge') {
                return (
                  <div key={i} className="transcript-entry coach-nudge">
                    <div className="transcript-meta">
                      <span className="transcript-speaker speaker-coach">💡 Coach</span>
                      <span className="transcript-time">{formatTimestamp(entry.timestamp_ms)}</span>
                    </div>
                    <div className="transcript-text">{entry.text}</div>
                  </div>
                );
              }
              return (
                <div key={i} className="transcript-entry coach-reinforcement">
                  <div className="transcript-meta">
                    <span className="transcript-speaker speaker-coach">✅ Coach</span>
                    <span className="transcript-time">{formatTimestamp(entry.timestamp_ms)}</span>
                  </div>
                  <div className="transcript-text">{entry.text}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

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
              <div className="history-buttons">
                {m.transcript_available && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleShowTranscript(m.meeting_session_id)}
                  >
                    📄 Transcript
                  </button>
                )}
                {m.report_available && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleShowReport(m.meeting_session_id)}
                  >
                    📊 Report
                  </button>
                )}
                {deletingId === m.meeting_session_id ? (
                  <span className="delete-confirm">
                    <span style={{ fontSize: '11px', color: '#cc0000' }}>Delete? Cannot be undone.</span>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => handleDeleteMeeting(m.meeting_session_id)}
                      style={{ fontSize: '10px', padding: '2px 6px' }}
                    >
                      Confirm
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setDeletingId(null)}
                      style={{ fontSize: '10px', padding: '2px 6px' }}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    className="btn btn-secondary btn-sm btn-delete"
                    onClick={() => setDeletingId(m.meeting_session_id)}
                    title="Delete meeting"
                    style={{ opacity: 0.5, fontSize: '12px', padding: '2px 6px' }}
                  >
                    🗑️
                  </button>
                )}
              </div>
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
        <span className="popup-version">v{extensionVersion}</span>
      </div>

      {/* Status indicator (FR-008) */}
      <div className="meeting-info">
        <div className={`status-badge status-${state.status}`}>
          <span className="dot" />
          {statusLabels[state.status]}
        </div>
        {state.platform && (
          <div style={{ fontSize: '11px', color: '#777', marginTop: '4px' }}>
            Platform: {platformLabel}
          </div>
        )}
        {state.meetingSessionId && (
          <div style={{ fontSize: '11px', color: '#999', marginTop: '4px' }}>
            Session: {state.meetingSessionId.slice(0, 8)}...
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="controls">
        {state.status !== 'active' && state.status !== 'muted' && !state.meetingSessionId && (
          <div className="capture-mode">
            <label className="capture-mode-option">
              <input
                type="checkbox"
                checked={captureMode === 'user_voice_only'}
                onChange={(e) => handleCaptureModeChange(e.target.checked ? 'user_voice_only' : 'full_meeting')}
              />
              <span>
                <strong>Use only my voice</strong>
                <small>No tab audio or meeting captions from others</small>
              </span>
            </label>
          </div>
        )}

        {!state.authenticated ? (
          <button className="btn btn-primary" onClick={handleSignIn}>
            Sign In
          </button>
        ) : (
          <>
            {state.status === 'ready' && state.meetingSessionId && (
              <>
                <button className="btn btn-primary" onClick={handleStartCoaching}>
                  Resume Coaching
                </button>
                <button className="btn btn-danger" onClick={handleEndMeeting}>
                  End Meeting
                </button>
              </>
            )}

            {state.status === 'ready' && !state.meetingSessionId && (
              <button className="btn btn-primary" onClick={handleStartCoaching}>
                Start Coaching
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
                Join a supported Google Meet, Teams, or Zoom web meeting to start coaching
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
