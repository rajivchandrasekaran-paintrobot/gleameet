import React, { useState, useEffect, useCallback, useRef } from 'react';
import { NudgeCard } from './NudgeCard';
import { getGleameetSession } from '../services/auth';
import { startAudioCapture } from '../services/audio';
import {
  setSessionToken,
  startMeeting,
  pollPrompts,
  ackPrompt,
  endMeeting,
  getReport,
  getHistory,
} from '../services/api-client';

type Status = 'init' | 'authenticated' | 'active' | 'muted' | 'ending' | 'report' | 'error';
type View = 'main' | 'history' | 'report';

interface Nudge {
  prompt_id: string;
  short_text: string;
  rationale_text: string;
  example_phrase?: string;
}

interface ReportData {
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
}

interface MeetingEntry {
  meeting_session_id: string;
  meeting_label: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  report_available: boolean;
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export const CoachingPanel: React.FC = () => {
  const [status, setStatus] = useState<Status>('init');
  const [view, setView] = useState<View>('main');
  const [userId, setUserId] = useState<string | null>(null);
  const [meetingSessionId, setMeetingSessionId] = useState<string | null>(null);
  const [nudges, setNudges] = useState<Nudge[]>([]);
  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meetings, setMeetings] = useState<MeetingEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [reportTab, setReportTab] = useState<'summary' | 'transcript-nudges'>('summary');

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCleanupRef = useRef<(() => void) | null>(null);

  // Authenticate on mount
  useEffect(() => {
    getGleameetSession()
      .then(({ sessionToken, userId: uid }) => {
        setSessionToken(sessionToken);
        setUserId(uid);
        setStatus('authenticated');
      })
      .catch((err) => {
        console.error('[Gleameet] Auth failed:', err);
        setError('Authentication failed. Please try again.');
        setStatus('error');
      });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (audioCleanupRef.current) audioCleanupRef.current();
    };
  }, []);

  const handleStart = async () => {
    if (!userId) return;
    setError(null);
    try {
      const result = await startMeeting({
        user_id: userId,
        platform: 'teams',
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

      const sessionId = result.meeting_session_id;
      setMeetingSessionId(sessionId);
      setStatus('active');

      // Start audio capture
      audioCleanupRef.current = startAudioCapture(sessionId);

      // Start prompt polling (every 2s)
      pollIntervalRef.current = setInterval(async () => {
        try {
          const data = await pollPrompts(sessionId);
          if (data.prompts.length > 0) {
            setNudges(prev => {
              const existingIds = new Set(prev.map(n => n.prompt_id));
              const newNudges = data.prompts
                .filter(p => !existingIds.has(p.prompt_id))
                .map(p => ({
                  prompt_id: p.prompt_id,
                  short_text: p.short_text,
                  rationale_text: p.rationale_text,
                  example_phrase: p.example_phrase,
                }));
              return [...prev, ...newNudges];
            });

            // Ack prompts as shown
            for (const p of data.prompts) {
              ackPrompt({
                prompt_id: p.prompt_id,
                meeting_session_id: sessionId,
                action: 'shown',
              }).catch(() => {});
            }
          }
        } catch {
          // Poll errors are non-critical
        }
      }, 2000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to start coaching';
      setError(message);
    }
  };

  const handleStop = async () => {
    if (!meetingSessionId) return;

    // Stop polling and audio
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (audioCleanupRef.current) {
      audioCleanupRef.current();
      audioCleanupRef.current = null;
    }

    setStatus('ending');
    setNudges([]);

    try {
      await endMeeting(meetingSessionId);

      // Fetch report
      const reportData = await getReport(meetingSessionId);
      setReport(reportData);
      setStatus('report');
      setView('report');
      setReportTab('summary');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to end meeting';
      setError(message);
      setStatus('authenticated');
    }
  };

  const handleMute = () => setStatus('muted');
  const handleUnmute = () => setStatus('active');

  const handleDismissNudge = useCallback((promptId: string) => {
    setNudges(prev => prev.filter(n => n.prompt_id !== promptId));
    if (meetingSessionId) {
      ackPrompt({
        prompt_id: promptId,
        meeting_session_id: meetingSessionId,
        action: 'dismissed',
      }).catch(() => {});
    }
  }, [meetingSessionId]);

  const handleShowHistory = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getHistory();
      setMeetings(data.meetings);
      setView('history');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load history';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleShowReport = async (sessionId: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await getReport(sessionId);
      setReport(data);
      setReportTab('summary');
      setView('report');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load report';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  // Report view
  if (view === 'report' && report) {
    return (
      <div className="panel-container">
        <div className="panel-header">
          <button className="btn btn-secondary btn-sm" onClick={() => { setView('main'); setStatus('authenticated'); }}>
            &larr; Back
          </button>
          <h1>Report</h1>
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
                      <span className="report-action-reason"> &mdash; {ra.reason}</span>
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
                      <span className="transcript-speaker speaker-coach">Coach</span>
                      <span className="transcript-time">{formatTimestamp(entry.timestamp_ms)}</span>
                    </div>
                    <div className="transcript-text">{entry.text}</div>
                  </div>
                );
              }
              return (
                <div key={i} className="transcript-entry coach-reinforcement">
                  <div className="transcript-meta">
                    <span className="transcript-speaker speaker-coach">Coach</span>
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

  // History view
  if (view === 'history') {
    return (
      <div className="panel-container">
        <div className="panel-header">
          <button className="btn btn-secondary btn-sm" onClick={() => setView('main')}>
            &larr; Back
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
                {m.report_available && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleShowReport(m.meeting_session_id)}
                  >
                    Report
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
    <div className="panel-container">
      <div className="panel-header">
        <h1>Gleameet</h1>
        <span className="platform-badge">Teams</span>
      </div>

      {/* Status */}
      <div className="meeting-info">
        <div className={`status-badge status-${status === 'init' ? 'off' : status === 'authenticated' ? 'ready' : status === 'active' ? 'active' : status === 'muted' ? 'muted' : status === 'error' ? 'error' : 'off'}`}>
          <span className="dot" />
          {status === 'init' && 'Connecting...'}
          {status === 'authenticated' && 'Ready to coach'}
          {status === 'active' && 'Coaching active'}
          {status === 'muted' && 'Coaching muted'}
          {status === 'ending' && 'Generating report...'}
          {status === 'error' && 'Error'}
          {status === 'report' && 'Report ready'}
        </div>
      </div>

      {/* Nudge cards */}
      {status !== 'muted' && nudges.length > 0 && (
        <div className="nudge-stack">
          {nudges.map(n => (
            <NudgeCard
              key={n.prompt_id}
              promptId={n.prompt_id}
              shortText={n.short_text}
              rationaleText={n.rationale_text}
              examplePhrase={n.example_phrase}
              onDismiss={handleDismissNudge}
            />
          ))}
        </div>
      )}

      {/* Controls */}
      <div className="controls">
        {status === 'init' && (
          <p className="info-text">Authenticating with Teams...</p>
        )}

        {status === 'authenticated' && (
          <button className="btn btn-primary" onClick={handleStart}>
            Start Coaching
          </button>
        )}

        {status === 'active' && (
          <>
            <button className="btn btn-secondary" onClick={handleMute}>
              Mute Prompts
            </button>
            <button className="btn btn-danger" onClick={handleStop}>
              Stop Coaching
            </button>
          </>
        )}

        {status === 'muted' && (
          <>
            <button className="btn btn-primary" onClick={handleUnmute}>
              Resume Prompts
            </button>
            <button className="btn btn-danger" onClick={handleStop}>
              Stop Coaching
            </button>
          </>
        )}

        {status === 'ending' && (
          <p className="info-text">Generating report...</p>
        )}

        {status === 'error' && (
          <p className="error-message">{error || 'Connection error. Please try again.'}</p>
        )}
      </div>

      {/* History link */}
      {(status === 'authenticated' || status === 'report') && (
        <div className="footer-link">
          <a href="#" onClick={(e) => { e.preventDefault(); handleShowHistory(); }}>
            {loading ? 'Loading...' : 'Past Meetings'}
          </a>
        </div>
      )}

      {error && status !== 'error' && <p className="error-message">{error}</p>}

      <div className="privacy-note">
        Coaching is visible only to you
      </div>
    </div>
  );
};
