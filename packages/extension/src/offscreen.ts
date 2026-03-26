// Offscreen document for audio capture (MV3 compatible)
// Handles mic capture in a separate context so it does NOT
// interfere with the meeting tab's audio routing.

let micRecorder: MediaRecorder | null = null;
let micInterval: ReturnType<typeof setInterval> | null = null;
let tabRecorder: MediaRecorder | null = null;
let tabInterval: ReturnType<typeof setInterval> | null = null;
let tabAudioCtx: AudioContext | null = null;

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type === "START_MIC_CAPTURE") {
    const { meetingSessionId, sessionToken, apiBase } = message;

    // Capture mic from offscreen context — does NOT conflict with meeting tab audio
    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,   // Don't interfere with meeting's echo cancellation
        noiseSuppression: false,
        autoGainControl: false,
      }
    }).then(stream => {
      const { recorder, interval } = startRecording(stream, "mic", meetingSessionId, sessionToken, apiBase);
      micRecorder = recorder;
      micInterval = interval;
      console.log("[GleaMeet Offscreen] Mic capture started");
    }).catch(err => {
      console.warn("[GleaMeet Offscreen] Mic capture failed:", err.message);
    });
  }

  if (message.type === "START_TAB_CAPTURE") {
    const { meetingSessionId, sessionToken, apiBase, streamId } = message;

    (navigator.mediaDevices.getUserMedia as any)({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        }
      } as any,
      video: false,
    }).then((tabStream: MediaStream) => {
      // Create audio context for non-destructive split
      const audioCtx = new AudioContext();
      tabAudioCtx = audioCtx;
      const source = audioCtx.createMediaStreamSource(tabStream);

      // Route 1: to speakers (keep original audio playing)
      source.connect(audioCtx.destination);

      // Route 2: to recorder (our copy for Whisper)
      const dest = audioCtx.createMediaStreamDestination();
      source.connect(dest);

      // Record from the destination node (not the original stream)
      const { recorder, interval } = startRecording(dest.stream, "tab", meetingSessionId, sessionToken, apiBase);
      tabRecorder = recorder;
      tabInterval = interval;

      console.log("[GleaMeet Offscreen] Tab audio split: speakers + recorder both active");
    }).catch((err: Error) => {
      console.warn("[GleaMeet Offscreen] Tab capture failed:", err.message);
    });
  }

  if (message.type === "STOP_MIC_CAPTURE") {
    if (micInterval) { clearInterval(micInterval); micInterval = null; }
    if (micRecorder) {
      if (micRecorder.state === "recording") {
        try { micRecorder.stop(); } catch (_) {}
      }
      micRecorder.stream.getTracks().forEach(t => t.stop());
      micRecorder = null;
    }
    console.log("[GleaMeet Offscreen] Mic capture stopped");
  }

  if (message.type === "STOP_TAB_CAPTURE") {
    if (tabInterval) { clearInterval(tabInterval); tabInterval = null; }
    if (tabRecorder) {
      if (tabRecorder.state === "recording") {
        try { tabRecorder.stop(); } catch (_) {}
      }
      tabRecorder.stream.getTracks().forEach(t => t.stop());
      tabRecorder = null;
    }
    if (tabAudioCtx) {
      tabAudioCtx.close().catch(() => {});
      tabAudioCtx = null;
    }
    console.log("[GleaMeet Offscreen] Tab capture stopped");
  }
});

function startRecording(stream: MediaStream, streamType: string, meetingSessionId: string, sessionToken: string, apiBase: string): { recorder: MediaRecorder; interval: ReturnType<typeof setInterval> } {
  const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
  let chunks: Blob[] = [];

  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: "audio/webm" });
    chunks = [];
    if (blob.size < 1000) return;

    const form = new FormData();
    form.append("audio", blob, "chunk.webm");
    form.append("stream", streamType);
    form.append("meeting_session_id", meetingSessionId);

    await fetch(`${apiBase}/audio/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionToken}` },
      body: form,
    }).catch(() => {});
  };

  recorder.start();
  const interval = setInterval(() => {
    if (recorder.state === "recording") { recorder.stop(); recorder.start(); }
  }, 10000);

  return { recorder, interval };
}
