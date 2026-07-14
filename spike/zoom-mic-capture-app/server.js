const express = require('express');
const helmet = require('helmet');
const https = require('https');
const selfsigned = require('selfsigned');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const HTTPS_PORT = 3443;

// Trust the Zoom desktop app's embedded browser proxy
app.set('trust proxy', true);

// --- Zoom App CSP: must allow the SDK origin and the embedded browser context
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          'https://appssdk.zoom.us',
          'https://source.zoom.us',
        ],
        connectSrc: [
          "'self'",
          'https://appssdk.zoom.us',
          'https://source.zoom.us',
          'wss://*.zoom.us',
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:', 'mediastream:'],
        workerSrc: ["'self'", 'blob:'],
        childSrc: ["'self'", 'blob:'],
        frameAncestors: ['*'],
      },
    },
    // Embedded webview (Zoom) sends its own referrer; relax this for local dev
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    strictTransportSecurity: {
      maxAge: 31536000,
      includeSubDomains: true,
    },
  })
);

// OWASP headers required by the Zoom Marketplace URL validator.
// We set these explicitly so they are present on EVERY response, not only
// those Helmet chooses to attach them to.
app.use((_req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer-when-cross-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(self)');
  // Mirror the CSP here too in case the validator inspects it via a different path
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' https://appssdk.zoom.us https://source.zoom.us",
      "connect-src 'self' https://appssdk.zoom.us https://source.zoom.us wss://*.zoom.us",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob: mediastream:",
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
      "frame-ancestors *",
    ].join('; ')
  );
  next();
});

app.use(express.static(path.join(__dirname), { index: 'index.html' }));

// --- Audio capture ingestion
// Accept raw audio chunks (whatever MIME the browser hands us, usually
// 'audio/webm;codecs=opus' or 'audio/ogg' depending on browser).
app.use('/chunk', express.raw({ type: '*/*', limit: '5mb' }));

// --- Render backend relay (Path B → behavioral engine)
// The webview only ever talks to this local server; we forward server-to-server
// so the session token never enters the webview and CORS never applies.
const RENDER_API_BASE = (process.env.RENDER_API_BASE || '').replace(/\/$/, '');
const GOOGLE_ACCESS_TOKEN = process.env.GOOGLE_ACCESS_TOKEN || process.env.ACCESS_TOKEN || '';

// One in-flight backend session at a time (spike-sufficient)
const backend = {
  sessionToken: null,
  userId: null,
  meetingSessionId: null,
};

async function backendFetch(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (backend.sessionToken) headers.Authorization = `Bearer ${backend.sessionToken}`;
  const res = await fetch(`${RENDER_API_BASE}${pathname}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${pathname} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

// auth/session + meetings/start; called on each session start
async function bootstrapBackendSession() {
  if (!RENDER_API_BASE) {
    console.log('RELAY off (set RENDER_API_BASE to enable forwarding to the backend)');
    return;
  }
  if (!GOOGLE_ACCESS_TOKEN && !backend.sessionToken) {
    console.log('RELAY off (set GOOGLE_ACCESS_TOKEN — see README for the OAuth Playground steps)');
    return;
  }
  try {
    if (!backend.sessionToken) {
      const auth = await backendFetch('/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ google_id_token: GOOGLE_ACCESS_TOKEN }),
      });
      backend.sessionToken = auth.session_token;
      backend.userId = auth.user_id;
      console.log(`RELAY authenticated as user ${backend.userId}`);
    }
    // Same consent shape the extension popup sends (Popup.tsx:187)
    const started = await backendFetch('/meetings/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'zoom',
        meeting_label: 'zoom mic-in spike',
        extension_version: 'mic-spike-0.0.1',
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
      }),
    });
    backend.meetingSessionId = started.meeting_session_id;
    console.log(`RELAY meeting session ${backend.meetingSessionId}`);
  } catch (err) {
    console.error(`RELAY bootstrap failed: ${err.message}`);
    // A 401 here usually means the Google access token expired (~1h) — refresh it.
  }
}

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Rolling relay outcomes for the webview to poll via GET /analysis — the
// /chunk POST returns 204 immediately, so transcripts/prompts/report land
// here instead of in the response.
const analysis = {
  results: [],          // { seq, text, prompts, error?, at }
  reportStatus: 'none', // none | pending | ready | failed
  report: null,
};
function pushAnalysis(entry) {
  analysis.results.push({ at: Date.now(), ...entry });
  if (analysis.results.length > 200) analysis.results.shift();
}

// Blob → /audio/transcribe → transcript_segment → /events/batch → log prompts
let inflightRelays = 0;
async function relayChunk(buf, mime, startOffsetMs, endOffsetMs, seq) {
  // Capture the id: meetings/end nulls backend.meetingSessionId while we run
  const meetingSessionId = backend.meetingSessionId;
  if (!meetingSessionId) return;

  const form = new FormData();
  form.append('audio', new Blob([buf], { type: mime || 'audio/webm' }), 'chunk.webm');
  form.append('stream', 'mic');
  form.append('meeting_session_id', meetingSessionId);

  const { text } = await backendFetch('/audio/transcribe', { method: 'POST', body: form });
  if (!text) {
    console.log('RELAY transcript: (empty — silence or noise filtered)');
    pushAnalysis({ seq, text: '', prompts: [] });
    return;
  }
  console.log(`RELAY transcript: "${text}"`);

  const baseEvent = () => ({
    event_id: uuidv4(),
    meeting_session_id: meetingSessionId,
    user_id: backend.userId,
    platform: 'zoom',
    source: 'adapter',
    capture_confidence: null,
  });

  // The feature engine only accrues user speaking time from a
  // speech_started/speech_ended pair (their event_time_utc delta), so bracket
  // every voiced chunk with them. transcript_segment must come LAST in the
  // batch: it resets last_speech_start_ms and would zero the pair's duration.
  const events = [
    {
      ...baseEvent(),
      event_type: 'speech_started',
      event_time_utc: new Date(startOffsetMs).toISOString(),
      payload: { speaker: 'user', offset_ms: startOffsetMs },
    },
    {
      ...baseEvent(),
      event_type: 'speech_ended',
      event_time_utc: new Date(endOffsetMs).toISOString(),
      payload: { speaker: 'user', offset_ms: endOffsetMs },
    },
    {
      ...baseEvent(),
      event_type: 'transcript_segment',
      event_time_utc: new Date(endOffsetMs).toISOString(),
      payload: {
        text,
        speaker: 'user',
        start_offset_ms: startOffsetMs,
        end_offset_ms: endOffsetMs,
        attribution: {
          source: 'mic',
          candidate_speaker: 'user',
          final_speaker: 'user',
          passes_user_attribution: true,
          reason: 'self_declared',
        },
      },
    },
  ];

  const result = await backendFetch('/events/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meeting_session_id: meetingSessionId, events }),
  });
  for (const prompt of result.prompts || []) {
    console.log('*** COACHING PROMPT ***');
    console.log(JSON.stringify(prompt, null, 2));
  }
  if (result.errors && result.errors.length) {
    console.error('RELAY event errors:', JSON.stringify(result.errors));
  }
  pushAnalysis({ seq, text, prompts: result.prompts || [] });
}

async function endBackendSession() {
  if (!backend.meetingSessionId) return;
  const meetingSessionId = backend.meetingSessionId;
  backend.meetingSessionId = null; // no new chunks accepted from here on
  analysis.reportStatus = 'pending';
  // Let in-flight transcriptions land so the final segment makes the report
  const deadline = Date.now() + 15000;
  while (inflightRelays > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    const ended = await backendFetch('/meetings/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meeting_session_id: meetingSessionId }),
    });
    console.log(`RELAY meeting ended, report_id=${ended.report_id}`);
    // meetings/end generates the report synchronously — fetch it now so the
    // webview can render it from /analysis.
    analysis.report = await backendFetch(`/reports/${meetingSessionId}`);
    analysis.reportStatus = 'ready';
    console.log('RELAY report fetched — available to the webview via /analysis');
  } catch (err) {
    analysis.reportStatus = 'failed';
    console.error(`RELAY meetings/end or report fetch failed: ${err.message}`);
  }
}

// --- Session accounting (one in-process session; sufficient for a spike)
const session = {
  startedAt: null,
  chunks: 0,
  bytes: 0,
  lastChunkAt: null,
  lastSize: 0,
  mime: null,
};

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function bar(ratio) {
  const width = 30;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return '[' + '#'.repeat(filled) + '-'.repeat(width - filled) + ']';
}

app.post('/chunk', (req, res) => {
  const buf = req.body;
  if (!buf || !buf.length) {
    res.status(400).send('empty chunk');
    return;
  }
  if (!session.startedAt) session.startedAt = Date.now(); // chunk beat the start event
  session.chunks += 1;
  session.bytes += buf.length;
  session.lastChunkAt = new Date();
  session.lastSize = buf.length;

  const elapsed = ((Date.now() - session.startedAt) / 1000).toFixed(1);
  const avg = (session.bytes / session.chunks) | 0;
  // Use chunk size relative to the running average as a crude "is there
  // speech right now" meter (silence chunks compress to almost nothing).
  const energy = Math.min(1, session.lastSize / Math.max(2000, avg * 1.5));

  console.log(
    `chunk #${String(session.chunks).padStart(4, ' ')}  ` +
    `${fmtBytes(buf.length).padStart(8, ' ')}  ` +
    `total=${fmtBytes(session.bytes).padStart(8, ' ')}  ` +
    `t=${elapsed.padStart(6, ' ')}s  ` +
    `${bar(energy)}`
  );

  // Respond immediately so the recorder loop is never blocked; the relay
  // (Whisper + law engine) runs in the background and logs its own outcome.
  res.status(204).end();

  const startOffsetMs = Number(req.query.start_offset_ms) || Date.now() - 10000;
  const endOffsetMs = Number(req.query.end_offset_ms) || Date.now();
  const seq = Number(req.query.seq) || session.chunks;
  inflightRelays += 1;
  relayChunk(buf, req.headers['content-type'], startOffsetMs, endOffsetMs, seq)
    .catch((err) => {
      pushAnalysis({ seq, error: err.message });
      console.error(`RELAY chunk failed: ${err.message}`);
    })
    .finally(() => { inflightRelays -= 1; });
});

app.post('/event', express.json(), (req, res) => {
  const { type, mime, sampleRate } = req.body || {};
  if (type === 'start') {
    session.startedAt = Date.now();
    session.chunks = 0;
    session.bytes = 0;
    session.mime = mime;
    analysis.results = [];
    analysis.reportStatus = 'none';
    analysis.report = null;
    console.log('---');
    console.log(`SESSION START  mime=${mime}  sampleRate=${sampleRate || '?'}Hz`);
    console.log('---');
    bootstrapBackendSession();
  } else if (type === 'stop') {
    const dur = session.startedAt ? ((Date.now() - session.startedAt) / 1000).toFixed(2) : '?';
    console.log('---');
    console.log(`SESSION STOP   chunks=${session.chunks}  bytes=${fmtBytes(session.bytes)}  duration=${dur}s`);
    console.log('---');
    endBackendSession();
  } else {
    res.status(400).json({ ok: false, error: 'unknown event type' });
    return;
  }
  res.json({ ok: true });
});

// Webview polling endpoint: per-chunk analysis outcomes + the post-meeting
// report, so the page can show them without ever holding the session token.
app.get('/analysis', (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json({
    relay: Boolean(RENDER_API_BASE),
    results: analysis.results.filter((r) => r.seq > since),
    report_status: analysis.reportStatus,
    report: analysis.reportStatus === 'ready' ? analysis.report : null,
  });
});

app.get('/stats', (_req, res) => {
  res.json({
    startedAt: session.startedAt,
    chunks: session.chunks,
    bytes: session.bytes,
    lastChunkAt: session.lastChunkAt,
    lastSize: session.lastSize,
    mime: session.mime,
  });
});

// --- HTTPS: Zoom desktop requires HTTPS even for local development
const certDir = path.join(__dirname, '.certs');
if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });

const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');

let sslOptions;
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  sslOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
  console.log('Using existing self-signed cert from .certs/');
} else {
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  const pems = selfsigned.generate(attrs, {
    algorithm: 'sha256',
    days: 365,
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  sslOptions = { key: pems.private, cert: pems.cert };
  console.log('Generated new self-signed cert in .certs/');
}

https.createServer(sslOptions, app).listen(HTTPS_PORT, () => {
  console.log(`Mic-capture spike (HTTPS) listening on https://localhost:${HTTPS_PORT}`);
  console.log('Open https://localhost:3443 in a browser, or load it as a Zoom App.');
  console.log(
    RENDER_API_BASE
      ? `RELAY target: ${RENDER_API_BASE}${GOOGLE_ACCESS_TOKEN ? '' : '  (GOOGLE_ACCESS_TOKEN missing!)'}`
      : 'RELAY disabled — local logging only (set RENDER_API_BASE + GOOGLE_ACCESS_TOKEN to forward)'
  );
});

// Also listen on plain HTTP for convenience
app.listen(PORT, () => {
  console.log(`(HTTP, non-Zoom)         listening on http://localhost:${PORT}`);
});
