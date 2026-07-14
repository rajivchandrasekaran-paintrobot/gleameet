// Page logic for the mic-capture spike. Lives in its own file (not inline)
// because the CSP is script-src 'self' + the Zoom SDK origins — inline
// scripts are blocked, and the Zoom Marketplace validator wants it that way.
const logEl = document.getElementById('log');
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
// #progress is the single status-strip line: idle / error / the live tqdm bar
const setStatus = (s) => { progressEl.textContent = s; };

let stream, recorder, restartTimer;
let totalChunks = 0, totalBytes = 0;
let audioCtx, analyser, rafId;

// --- Auto 30-second collection: each chunk is analyzed, result shown as "coaching blurb"
// The relay is fire-and-forget (POST /chunk returns 204), results polled via GET /analysis
const CHUNK_MS = 30000;  // 30 seconds per collection cycle
let chunkSeq = 0;        // 1-based; the chunk currently being collected
let chunkStartedAt = 0;
let micHot = false;      // fed by the level meter
let progressTimer = null;
let pollTimer = null;
let lastSeenSeq = 0;
let awaitingAnalysis = false;  // waiting for this chunk's analysis
let analysisDeadline = 0;
let promptTimer = null;
let autoRunning = false; // true once page has loaded and mic access granted

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
  const totalSec = (CHUNK_MS / 1000).toFixed(0);
  progressEl.textContent =
    `chunk ${chunkSeq} |${bar}| ${(elapsed / 1000).toFixed(1)}/${totalSec}s ${micHot ? '●' : '○'} rec`;
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
  awaitingAnalysis = false;
  progressEl.textContent = finalText || 'idle';
}

// Display a "coaching blurb": timestamp + top coaching prompt for this 30s chunk
function showCoachingBlurb(chunk, prompts) {
  if (!prompts || prompts.length === 0) {
    const ts = new Date().toLocaleTimeString();
    feedLine(`[${ts}] (no coaching insights this cycle)`, 'muted');
    return;
  }
  const ts = new Date().toLocaleTimeString();
  const topPrompt = prompts[0];
  const text = topPrompt.short_text || topPrompt.text || JSON.stringify(topPrompt);
  const summary = `[${ts}] ${text}`;
  feedLine(summary, 'coaching-blurb');
  log('coaching blurb', { ts, text, chunk });
}

async function pollAnalysis() {
  try {
    const res = await fetch(`/analysis?since=${lastSeenSeq}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.relay) {
      if (awaitingAnalysis) {
        feedLine('relay off — no backend analysis (set RENDER_API_BASE)', 'muted');
        stopFeed('idle');
        if (autoRunning) setTimeout(() => startProbe(), 1000);
      }
      return;
    }
    for (const r of data.results) {
      lastSeenSeq = Math.max(lastSeenSeq, r.seq);
      const ts = new Date().toLocaleTimeString();
      if (r.error) {
        feedLine(`[${ts}] ✖ ${r.error}`, 'err');
      } else if (!r.text) {
        feedLine(`[${ts}] · (silence)`, 'muted');
      } else {
        // Show coaching blurb for this chunk
        showCoachingBlurb(r.seq, r.prompts || []);
        // Also show prompts in the prompt card briefly
        for (const p of r.prompts || []) {
          const text = p.short_text || p.text || JSON.stringify(p);
          showPrompt(text);
          log('coaching prompt', p);
        }
      }
      if (r.seq >= chunkSeq) awaitingAnalysis = false;
    }
    // Auto-restart after chunk analysis arrives
    if (!awaitingAnalysis && autoRunning && !recorder) {
      stopFeed('');
      setTimeout(() => startProbe(), 500);
    }
    if (awaitingAnalysis && Date.now() > analysisDeadline) {
      feedLine('✖ timed out waiting for analysis', 'err');
      stopFeed('idle');
      if (autoRunning) setTimeout(() => startProbe(), 1000);
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

    // Collect for 30s then auto-restart. Each blob is a complete WebM file.
    totalChunks = 0; totalBytes = 0;
    let pending = [];
    if (chunkSeq === 0) {
      // First time only: clear feed
      chunkSeq = 1;
      feedOutEl.innerHTML = '';
    }
    chunkStartedAt = Date.now();
    awaitingAnalysis = false;
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
      chunkStartedAt = Date.now(); // starts the next cycle's tqdm bar
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
      awaitingAnalysis = true;
      analysisDeadline = Date.now() + 15000;
    };
    recorder.onerror = (e) => log('MediaRecorder error', e.error?.message || String(e));
    recorder.start();
    restartTimer = setInterval(() => {
      if (recorder.state === 'recording') { recorder.stop(); recorder.start(); }
    }, CHUNK_MS);

    progressTimer = setInterval(renderProgress, 200);
    if (!pollTimer) pollTimer = setInterval(pollAnalysis, 1000);
    startMeter(stream);
  } catch (err) {
    // NotReadableError here is the device-conflict signal we want to test.
    log('getUserMedia error', `${err.name}: ${err.message}`);
    setStatus('error');
  }
}

function stopProbe() {
  autoRunning = false;
  cancelAnimationFrame(rafId);
  clearInterval(restartTimer);
  clearInterval(progressTimer);
  progressTimer = null;
  clearInterval(pollTimer);
  pollTimer = null;
  micHot = false;
  chunkStartedAt = 0;
  audioCtx?.close();
  recorder?.stop();
  stream?.getTracks().forEach((t) => t.stop());
  log('stopped', `total chunks: ${totalChunks}, total bytes: ${totalBytes}`);
  setStatus('idle');
}

window.addEventListener('load', async () => {
  await initZoomSdk();
  // Auto-start 30-second collection loop
  autoRunning = true;
  setStatus('recording');
  startProbe();
});
