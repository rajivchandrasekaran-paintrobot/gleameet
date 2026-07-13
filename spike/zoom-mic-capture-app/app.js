// Page logic for the mic-capture spike. Lives in its own file (not inline)
// because the CSP is script-src 'self' + the Zoom SDK origins — inline
// scripts are blocked, and the Zoom Marketplace validator wants it that way.
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
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

// --- 2. Start a level meter so we can visually confirm the mic is hot
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
      // RMS-ish level: count samples that deviate from the midpoint
      let hot = 0;
      for (let i = 0; i < buf.length; i += 8) {
        if (Math.abs(buf[i] - 128) > 6) hot++;
      }
      if (hot > 0) log('mic level', `${hot} active samples (speech likely)`);
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
    let chunkStartedAt = Date.now();
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) pending.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(pending, { type: mime || 'audio/webm' });
      const startOffsetMs = chunkStartedAt;
      const endOffsetMs = Date.now();
      pending = [];
      chunkStartedAt = Date.now();
      if (blob.size < 1000) { log('chunk skipped (too small)', blob.size); return; }
      totalChunks += 1;
      totalBytes += blob.size;
      // Ship to the local server, which relays to the backend.
      // Fire-and-forget — we do not wait for the response.
      fetch(`/chunk?start_offset_ms=${startOffsetMs}&end_offset_ms=${endOffsetMs}`, {
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
  audioCtx?.close();
  recorder?.stop(); // final onstop still ships the last blob
  stream?.getTracks().forEach((t) => t.stop());
  log('stopped', `total chunks: ${totalChunks}, total bytes: ${totalBytes}`);
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
