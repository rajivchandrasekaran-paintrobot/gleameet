// Page logic for the mic-capture spike. Lives in its own file (not inline)
// because the CSP is script-src 'self' + the Zoom SDK origins — inline
// scripts are blocked, and the Zoom Marketplace validator wants it that way.
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const feedEl = document.getElementById('feed');
const feedOutEl = document.getElementById('feed-out');
const progressEl = document.getElementById('progress');
const promptCardEl = document.getElementById('prompt-card');
const promptTextEl = document.getElementById('prompt-text');

const log = (label, data) => {
  const stamp = new Date().toISOString().slice(11, 19);
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  logEl.textContent += `\n[${stamp}] ${label}: ${body}`;
  logEl.scrollTop = logEl.scrollHeight;
  console.log(label, data);
};
const setStatus = (s) => { statusEl.textContent = s; };

let stream, recorder, restartTimer;
let totalChunks = 0, totalBytes = 0;
let audioCtx, analyser, rafId;

// --- Capture feed: tqdm-style collection bar + relayed analysis output.
// The relay is fire-and-forget (POST /chunk returns 204), so results are
// pulled back by polling GET /analysis on the local server.
const CHUNK_MS = 10000;
let chunkSeq = 0;        // 1-based; the chunk currently being collected
let chunkStartedAt = 0;
let micHot = false;      // fed by the level meter; shown as ●/○ in the bar
let progressTimer = null;
let pollTimer = null;
let lastSeenSeq = 0;
let awaitingReport = false;
let reportDeadline = 0;
let promptTimer = null;

function feedLine(text, cls) {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  feedOutEl.appendChild(div);
  while (feedOutEl.childElementCount > 40) feedOutEl.removeChild(feedOutEl.firstChild);
  feedOutEl.scrollTop = feedOutEl.scrollHeight;
}

function renderProgress() {
  if (!chunkStartedAt) return;
  const elapsed = Math.min(CHUNK_MS, Date.now() - chunkStartedAt);
  const width = 10;
  const filled = Math.round((elapsed / CHUNK_MS) * width);
  const bar = '█'.repeat(filled) + '─'.repeat(width - filled);
  progressEl.textContent =
    `chunk ${chunkSeq} |${bar}| ${(elapsed / 1000).toFixed(1)}/10s ${micHot ? '●' : '○'} rec`;
}

// --- Coaching prompt card (slide-up dock card from the restyle)
function showPrompt(text) {
  promptTextEl.textContent = text;
  promptCardEl.classList.remove('dismissing');
  promptCardEl.classList.add('visible');
  clearTimeout(promptTimer);
  promptTimer = setTimeout(dismissPrompt, 15000);
}
function dismissPrompt() {
  clearTimeout(promptTimer);
  promptCardEl.classList.add('dismissing');
  setTimeout(() => promptCardEl.classList.remove('visible', 'dismissing'), 250);
}
promptCardEl.addEventListener('click', dismissPrompt);

function stopFeed(finalText) {
  clearInterval(pollTimer);
  pollTimer = null;
  awaitingReport = false;
  progressEl.textContent = finalText || 'idle';
}

function renderReport(r) {
  const s = r.summary_json || {};
  feedLine('— POST-MEETING REPORT —', 'report-h');
  feedLine(
    `duration ${s.duration_seconds ?? '?'}s · prompts shown ${s.total_prompts_shown ?? 0}` +
    ` · laws: ${(s.laws_triggered || []).join(', ') || 'none'}`
  );
  const asText = (x) => (typeof x === 'string' ? x : x.text || x.title || JSON.stringify(x));
  (r.strengths_json || []).forEach((x) => feedLine(`+ ${asText(x)}`, 'good'));
  (r.growth_areas_json || []).forEach((x) => feedLine(`△ ${asText(x)}`, 'nudge'));
  if (r.summary_analysis) feedLine(r.summary_analysis, 'muted');
  log('report', r); // full JSON in the ⋯ menu log
  setStatus('report ready');
}

async function pollAnalysis() {
  try {
    const res = await fetch(`/analysis?since=${lastSeenSeq}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.relay) {
      if (awaitingReport) {
        feedLine('relay off — no backend analysis (set RENDER_API_BASE)', 'muted');
        stopFeed('idle');
      }
      return;
    }
    for (const r of data.results) {
      lastSeenSeq = Math.max(lastSeenSeq, r.seq);
      if (r.error) feedLine(`✖ chunk ${r.seq}: ${r.error}`, 'err');
      else if (!r.text) feedLine(`· chunk ${r.seq}: (silence)`, 'muted');
      else feedLine(`✔ chunk ${r.seq}: “${r.text}”`);
      for (const p of r.prompts || []) {
        const text = p.short_text || p.text || JSON.stringify(p);
        feedLine(`★ ${text}`, 'nudge');
        showPrompt(text);
        log('coaching prompt', p);
      }
    }
    if (awaitingReport) {
      if (data.report_status === 'ready' && data.report) {
        renderReport(data.report);
        stopFeed('session complete');
      } else if (data.report_status === 'failed') {
        feedLine('✖ report generation failed — see server terminal', 'err');
        stopFeed('idle');
      } else if (Date.now() > reportDeadline) {
        feedLine('✖ timed out waiting for report', 'err');
        stopFeed('idle');
      }
    }
  } catch { /* local server briefly unreachable — keep polling */ }
}

// --- 1. Initialise the Zoom Apps SDK
// In the desktop client, zoomSdk is injected. In a regular browser the
// CDN script still defines it, but the embedded context will be missing
// — we degrade gracefully so the page is still usable for testing.
async function initZoomSdk() {
  if (typeof window.zoomSdk === 'undefined') {
    log('zoomSdk', 'not present (not running inside the Zoom desktop client)');
    return;
  }
  try {
    const cfg = await window.zoomSdk.config({
      popoutSize: { width: 320, height: 240 },
      capabilities: [
        'getMeetingContext',
        'getRunningContext',
        'getUserContext',
      ],
    });
    log('zoomSdk.config', cfg);
    log('meetingContext', await window.zoomSdk.getMeetingContext());
    log('runningContext', await window.zoomSdk.getRunningContext());
    log('userContext', await window.zoomSdk.getUserContext());
  } catch (err) {
    log('zoomSdk init error', err.message || String(err));
  }
}

// --- 2. Level meter: feeds the ●/○ live-mic indicator in the progress bar
function startMeter(stream) {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let hot = 0;
      for (let i = 0; i < buf.length; i += 8) {
        if (Math.abs(buf[i] - 128) > 6) hot++;
      }
      micHot = hot > 0;
      rafId = requestAnimationFrame(tick);
    };
    tick();
  } catch (err) {
    log('AudioContext error', err.message || String(err));
  }
}

// --- 3. Probe the mic
async function startProbe() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0];
    log('track.label', track.label);
    log('track.readyState', track.readyState);
    log('track.muted', track.muted);
    log('track.enabled', track.enabled);
    setStatus('recording');

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : '';
    const trackSettings = track.getSettings();
    const sampleRate = trackSettings.sampleRate;

    // Tell the server we are starting
    fetch('/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'start', mime, sampleRate }),
    }).catch((e) => log('event post failed', e.message));

    // Stop/restart every 10s (same pattern as the extension's offscreen.ts)
    // so each shipped blob is a COMPLETE WebM file — timeslice chunks after
    // the first lack the container header and Whisper cannot decode them.
    totalChunks = 0; totalBytes = 0;
    let pending = [];
    chunkSeq = 1;
    chunkStartedAt = Date.now();
    lastSeenSeq = 0;
    awaitingReport = false;
    feedOutEl.innerHTML = '';
    feedEl.hidden = false;
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) pending.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(pending, { type: mime || 'audio/webm' });
      const seq = chunkSeq;
      const startOffsetMs = chunkStartedAt;
      const endOffsetMs = Date.now();
      pending = [];
      chunkSeq += 1;
      chunkStartedAt = Date.now();
      if (blob.size < 1000) { log('chunk skipped (too small)', blob.size); return; }
      totalChunks += 1;
      totalBytes += blob.size;
      // Ship to the local server, which relays to the backend.
      // Fire-and-forget — the outcome comes back via the /analysis poll.
      fetch(`/chunk?start_offset_ms=${startOffsetMs}&end_offset_ms=${endOffsetMs}&seq=${seq}`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'application/octet-stream' },
        body: blob,
      }).catch((err) => log('chunk post failed', err.message));
      log('chunk shipped, bytes', blob.size);
    };
    recorder.onerror = (e) => log('MediaRecorder error', e.error?.message || String(e));
    recorder.start();
    restartTimer = setInterval(() => {
      if (recorder.state === 'recording') { recorder.stop(); recorder.start(); }
    }, 10000);

    progressTimer = setInterval(renderProgress, 200);
    pollTimer = setInterval(pollAnalysis, 1000);
    startMeter(stream);

    document.getElementById('stop').disabled = false;
    document.getElementById('probe').disabled = true;
  } catch (err) {
    // NotReadableError here is the device-conflict signal we want to test.
    log('getUserMedia error', `${err.name}: ${err.message}`);
    setStatus('error');
  }
}

function stopProbe() {
  cancelAnimationFrame(rafId);
  clearInterval(restartTimer);
  clearInterval(progressTimer);
  progressTimer = null;
  micHot = false;
  chunkStartedAt = 0;
  audioCtx?.close();
  recorder?.stop(); // final onstop still ships the last blob
  stream?.getTracks().forEach((t) => t.stop());
  log('stopped', `total chunks: ${totalChunks}, total bytes: ${totalBytes}`);
  // Keep polling until the report lands (endBackendSession waits for
  // in-flight transcriptions, then meetings/end + report fetch).
  awaitingReport = true;
  reportDeadline = Date.now() + 90000;
  progressEl.textContent = '⟳ analyzing final chunk & generating report…';
  // Small delay so the final chunk reaches the server before meetings/end
  setTimeout(() => fetch('/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'stop' }),
  }).catch(() => {}), 500);
  setStatus('idle');
  document.getElementById('stop').disabled = true;
  document.getElementById('probe').disabled = false;
}

document.getElementById('probe').onclick = startProbe;
document.getElementById('stop').onclick = stopProbe;

window.addEventListener('load', initZoomSdk);
