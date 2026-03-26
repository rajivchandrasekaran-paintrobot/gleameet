"use strict";
(() => {
  // src/offscreen.ts
  var micRecorder = null;
  var micInterval = null;
  chrome.runtime.onMessage.addListener(async (message) => {
    if (message.type === "START_TAB_CAPTURE") {
      const { meetingSessionId, sessionToken, apiBase } = message;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: message.streamId
          }
        }
      });
      startRecording(stream, "tab", meetingSessionId, sessionToken, apiBase);
    }
    if (message.type === "START_MIC_CAPTURE") {
      const { meetingSessionId, sessionToken, apiBase } = message;
      navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          // Don't interfere with meeting's echo cancellation
          noiseSuppression: false,
          autoGainControl: false
        }
      }).then((stream) => {
        const { recorder, interval } = startRecording(stream, "mic", meetingSessionId, sessionToken, apiBase);
        micRecorder = recorder;
        micInterval = interval;
        console.log("[GleaMeet Offscreen] Mic capture started");
      }).catch((err) => {
        console.warn("[GleaMeet Offscreen] Mic capture failed:", err.message);
      });
    }
    if (message.type === "STOP_MIC_CAPTURE") {
      if (micInterval) {
        clearInterval(micInterval);
        micInterval = null;
      }
      if (micRecorder) {
        if (micRecorder.state === "recording") {
          try {
            micRecorder.stop();
          } catch (_) {
          }
        }
        micRecorder.stream.getTracks().forEach((t) => t.stop());
        micRecorder = null;
      }
      console.log("[GleaMeet Offscreen] Mic capture stopped");
    }
  });
  function startRecording(stream, streamType, meetingSessionId, sessionToken, apiBase) {
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    let chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: "audio/webm" });
      chunks = [];
      if (blob.size < 1e3) return;
      const form = new FormData();
      form.append("audio", blob, "chunk.webm");
      form.append("stream", streamType);
      form.append("meeting_session_id", meetingSessionId);
      await fetch(`${apiBase}/audio/transcribe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` },
        body: form
      }).catch(() => {
      });
    };
    recorder.start();
    const interval = setInterval(() => {
      if (recorder.state === "recording") {
        recorder.stop();
        recorder.start();
      }
    }, 1e4);
    return { recorder, interval };
  }
})();
