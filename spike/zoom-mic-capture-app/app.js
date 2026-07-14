// Page logic for the mic-capture spike. Lives in its own file (not inline)
// because the CSP is script-src 'self' + the Zoom SDK origins — inline
// scripts are blocked, and the Zoom Marketplace validator wants it that way.
const logEl = document.getElementById('log');
const progressEl = document.getElementById('progress');
const promptCardEl = document.getElementById('prompt-card');
const promptTextEl = document.getElementById('prompt-text');
const promptMeaningEl = document.getElementById('prompt-meaning');
const promptLawEl = document.getElementById('prompt-law');
const promptTypeEl = document.getElementById('prompt-type');
const promptTimeEl = document.getElementById('prompt-time');

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
let relayWarned = false; // log the relay-off notice only once

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

// --- Coaching prompt card: shows exactly ONE prompt at a time —
// short_text in bold, rationale_text in smaller type below. It never
// auto-dismisses; when the next prompt arrives the card blurs/fades out
// (.fading, 700ms — matches the CSS transition), swaps text, fades back in.
let swapTimer = null;
function showPrompt(p) {
  const main = p.short_text || p.text || JSON.stringify(p);
  const meaning = p.rationale_text || '';
  const apply = () => {
    promptCardEl.classList.remove('placeholder');
    promptLawEl.textContent = p.law_id || '';
    promptTypeEl.textContent = p.prompt_type || '';
    promptTimeEl.textContent = new Date(p.shown_at || Date.now()).toLocaleTimeString();
    promptTextEl.textContent = main;
    promptMeaningEl.textContent = meaning;
    promptCardEl.classList.remove('fading');
  };
  clearTimeout(swapTimer);
  if (promptCardEl.classList.contains('placeholder')) {
    apply(); // first prompt: no old content to fade out
    return;
  }
  promptCardEl.classList.add('fading');
  swapTimer = setTimeout(apply, 700);
}

// Render whatever the relay has produced, whenever it arrives. The recorder
// loop never stops, so there is deliberately NO timeout/restart here — a slow
// Whisper turnaround just means the prompt lands a poll or two later.
// (An earlier watchdog re-sent /event start on timeout, which wiped the
// server's pending results before the UI ever saw them.)
async function pollAnalysis() {
  try {
    const res = await fetch(`/analysis?since=${lastSeenSeq}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.relay) {
      if (!relayWarned) {
        relayWarned = true;
        log('relay', 'off — no backend analysis (set RENDER_API_BASE)');
      }
      return;
    }
    for (const r of data.results) {
      lastSeenSeq = Math.max(lastSeenSeq, r.seq);
      // Silence/errors go to the ⋯ menu log only — the card keeps showing
      // the last real prompt rather than churning with noise.
      if (r.error) {
        log(`chunk ${r.seq} error`, r.error);
      } else if (!r.text) {
        log(`chunk ${r.seq}`, '(silence)');
      } else if ((r.prompts || []).length) {
        // Top prompt for this chunk takes over the card; extras go to the log.
        showPrompt(r.prompts[0]);
        r.prompts.forEach((p) => log('coaching prompt', p));
      } else {
        log(`chunk ${r.seq}`, `transcribed, no prompt: "${r.text}"`);
      }
    }
  } catch (err) {
    // Local server briefly unreachable — keep polling. console only so the
    // ⋯ log isn't spammed once a second.
    console.debug('poll', err);
  }
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
    if (chunkSeq === 0) chunkSeq = 1;
    chunkStartedAt = Date.now();
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

window.addEventListener('load', async () => {
  await initZoomSdk();
  // Auto-start the 30-second collection loop; it runs until the page closes
  setStatus('recording');
  startProbe();
});
