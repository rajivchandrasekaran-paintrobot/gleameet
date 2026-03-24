import { transcribeAudio } from './api-client';

export function startAudioCapture(
  meetingSessionId: string,
): () => void {
  let cleanup: (() => void) | null = null;

  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    let chunks: Blob[] = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      chunks = [];
      if (blob.size < 1000) return;

      try {
        await transcribeAudio(blob, 'mic', meetingSessionId);
      } catch {
        // Silently ignore transcription errors — non-critical
      }
    };

    recorder.start();
    const interval = setInterval(() => {
      if (recorder.state === 'recording') {
        recorder.stop();
        recorder.start();
      }
    }, 10000);

    cleanup = () => {
      clearInterval(interval);
      if (recorder.state !== 'inactive') recorder.stop();
      stream.getTracks().forEach(t => t.stop());
    };
  }).catch(err => {
    console.error('[Gleameet] Mic access denied:', err);
  });

  return () => {
    if (cleanup) cleanup();
  };
}
