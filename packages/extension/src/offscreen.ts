// Offscreen document for audio capture (MV3 compatible)
// Handles mic capture in a separate context so it does NOT
// interfere with the meeting tab's audio routing.

let micRecorder: MediaRecorder | null = null;
let micInterval: ReturnType<typeof setInterval> | null = null;
let micSessionId: string | null = null;
let tabRecorder: MediaRecorder | null = null;
let tabInterval: ReturnType<typeof setInterval> | null = null;
let tabAudioCtx: AudioContext | null = null;
let tabSessionId: string | null = null;
const expectedRecorderStops = new WeakSet<MediaRecorder>();

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type === "START_MIC_CAPTURE") {
    const { meetingSessionId, sessionToken, apiBase } = message;
    if (micRecorder && micSessionId === meetingSessionId && isRecorderHealthy(micRecorder)) {
      return;
    }
    stopMicCapture();

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
      micSessionId = meetingSessionId;
      console.log("[GleaMeet Offscreen] Mic capture started");
    }).catch(err => {
      console.warn("[GleaMeet Offscreen] Mic capture failed:", err.message);
    });
  }

  if (message.type === "START_TAB_CAPTURE") {
    const { meetingSessionId, sessionToken, apiBase, streamId } = message;
    if (tabRecorder && tabSessionId === meetingSessionId && isRecorderHealthy(tabRecorder)) {
      return;
    }
    stopTabCapture();

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
      tabSessionId = meetingSessionId;

      console.log("[GleaMeet Offscreen] Tab audio split: speakers + recorder both active");
    }).catch((err: Error) => {
      console.warn("[GleaMeet Offscreen] Tab capture failed:", err.message);
    });
  }

  if (message.type === "STOP_MIC_CAPTURE") {
    stopMicCapture();
    console.log("[GleaMeet Offscreen] Mic capture stopped");
  }

  if (message.type === "STOP_TAB_CAPTURE") {
    stopTabCapture();
    console.log("[GleaMeet Offscreen] Tab capture stopped");
  }
});

function isRecorderHealthy(recorder: MediaRecorder): boolean {
  return recorder.state === "recording" &&
    recorder.stream.active &&
    recorder.stream.getAudioTracks().some(track => track.readyState === "live");
}

function stopMicCapture(): void {
  if (micInterval) { clearInterval(micInterval); micInterval = null; }
  if (micRecorder) {
    expectedRecorderStops.add(micRecorder);
    if (micRecorder.state === "recording") {
      try { micRecorder.stop(); } catch (_) {}
    }
    micRecorder.stream.getTracks().forEach(t => t.stop());
    micRecorder = null;
  }
  micSessionId = null;
}

function stopTabCapture(): void {
  if (tabInterval) { clearInterval(tabInterval); tabInterval = null; }
  if (tabRecorder) {
    expectedRecorderStops.add(tabRecorder);
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
  tabSessionId = null;
}

function startRecording(stream: MediaStream, streamType: string, meetingSessionId: string, sessionToken: string, apiBase: string): { recorder: MediaRecorder; interval: ReturnType<typeof setInterval> } {
  const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
  let chunkStartedAt = Date.now();
  let stopReported = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let lastTranscriptTextAt = Date.now();
  let chunksSinceText = 0;
  let consecutiveUploadFailures = 0;
  let consecutiveEmptyTranscripts = 0;

  const reportUnexpectedStop = (reason: string): void => {
    if (stopReported || expectedRecorderStops.has(recorder)) return;
    stopReported = true;
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    chrome.runtime.sendMessage({
      type: "AUDIO_CAPTURE_STOPPED",
      stream: streamType,
      meetingSessionId,
      reason,
    }).catch(() => {});
    try {
      if (recorder.state === "recording") recorder.stop();
    } catch (_) {}
    stream.getTracks().forEach(track => {
      try { track.stop(); } catch (_) {}
    });
  };

  recorder.onerror = () => reportUnexpectedStop("recorder-error");
  recorder.onstop = () => reportUnexpectedStop("recorder-stopped");
  stream.getAudioTracks().forEach(track => {
    track.addEventListener("ended", () => reportUnexpectedStop("track-ended"));
    track.addEventListener("mute", () => {
      setTimeout(() => {
        if (track.muted && recorder.state === "recording") {
          reportUnexpectedStop("track-muted");
        }
      }, 30000);
    });
  });

  recorder.ondataavailable = async e => {
    if (!e.data || e.data.size < 1000) return;
    const blob = e.data;
    const chunkEndedAt = Date.now();
    const chunkStart = chunkStartedAt;
    chunkStartedAt = Date.now();

    const form = new FormData();
    form.append("audio", blob, "chunk.webm");
    form.append("stream", streamType);
    form.append("meeting_session_id", meetingSessionId);

    const response = await fetch(`${apiBase}/audio/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionToken}` },
      body: form,
    }).catch(() => null);

    if (!response?.ok) {
      consecutiveUploadFailures++;
      if (consecutiveUploadFailures >= 3) {
        reportUnexpectedStop("transcription-upload-failed");
      }
      return;
    }
    consecutiveUploadFailures = 0;

    const result = await response.json().catch(() => null);
    if (!result?.text) {
      consecutiveEmptyTranscripts++;
      chunksSinceText++;
      if (
        consecutiveEmptyTranscripts >= 6 &&
        chunksSinceText >= 6 &&
        Date.now() - lastTranscriptTextAt > 60000
      ) {
        reportUnexpectedStop("transcription-stalled");
      }
      return;
    }
    consecutiveEmptyTranscripts = 0;
    chunksSinceText = 0;
    lastTranscriptTextAt = Date.now();

    chrome.runtime.sendMessage({
      type: "AUDIO_TRANSCRIPT_RESULT",
      text: result.text,
      stream: streamType,
      startOffsetMs: chunkStart,
      endOffsetMs: chunkEndedAt,
      eventTimeMs: chunkEndedAt,
    }).catch(() => {});
  };

  recorder.start();
  interval = setInterval(() => {
    const liveAudioTrack = stream.getAudioTracks().some(track => track.readyState === "live");
    if (recorder.state !== "recording" || !stream.active || !liveAudioTrack) {
      reportUnexpectedStop("health-check-failed");
      return;
    }

    try {
      recorder.requestData();
    } catch (_) {
      reportUnexpectedStop("request-data-failed");
    }
  }, 10000);

  return { recorder, interval };
}
