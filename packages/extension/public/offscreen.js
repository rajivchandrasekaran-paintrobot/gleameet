"use strict";
(() => {
  // src/offscreen.ts
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
    setInterval(() => {
      if (recorder.state === "recording") {
        recorder.stop();
        recorder.start();
      }
    }, 1e4);
  }
})();
