import { Router } from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import type { AuthenticatedRequest } from '../middleware/auth';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const whisperClient = new OpenAI({
  apiKey: process.env.LLM_API_KEY || 'ollama',
  baseURL: 'https://api.openai.com/v1',
});

export const audioRouter = Router();

/** Filter out likely noise/garbage transcriptions from Whisper */
function isValidTranscript(text: string, stream: string): boolean {
  if (!text || text.trim().length < 3) return false;

  const trimmed = text.trim();

  // Too short after trimming
  if (trimmed.split(/\s+/).length < 2) return false;

  // Whisper common noise outputs to reject
  const noisePatterns = [
    /^(thank you|thanks|\.+|…+)\.?$/i,
    /^\[.*\]$/, // [Music] [Applause] etc
    /^♪.*♪$/,  // music notation
    /^\(.*\)$/, // (laughing) etc — if entire transcript
  ];
  if (noisePatterns.some(p => p.test(trimmed))) return false;

  // Check for high ratio of non-ASCII characters (garbled output)
  const nonAscii = (trimmed.match(/[^\x00-\x7F]/g) || []).length;
  const ratio = nonAscii / trimmed.length;
  if (ratio > 0.3) return false; // More than 30% non-ASCII = likely noise

  return true;
}

/**
 * POST /audio/transcribe
 * Accepts multipart form: audio file (WebM/WAV) + stream ("mic"|"tab") + meeting_session_id
 * Proxies to OpenAI Whisper and returns { text, stream }
 */
audioRouter.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const file = req.file;
    const stream = req.body?.stream as string;
    const meetingSessionId = req.body?.meeting_session_id as string;

    if (!file) {
      return res.status(400).json({ error: 'Missing audio file', code: 'MISSING_AUDIO' });
    }
    if (!stream || !['mic', 'tab'].includes(stream)) {
      return res.status(400).json({ error: 'Invalid stream type (must be "mic" or "tab")', code: 'INVALID_STREAM' });
    }
    if (!meetingSessionId) {
      return res.status(400).json({ error: 'Missing meeting_session_id', code: 'MISSING_SESSION' });
    }

    // Convert multer buffer to an uploadable file for the OpenAI SDK
    const audioFile = await OpenAI.toFile(
      new Uint8Array(file.buffer),
      file.originalname || 'chunk.webm',
      { type: file.mimetype || 'audio/webm' },
    );

    const transcription = await whisperClient.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      language: 'en',
      response_format: 'json',
    });

    // Filter out noise/garbage transcriptions
    if (!isValidTranscript(transcription.text, stream)) {
      return res.json({ text: '', stream });
    }

    return res.json({
      text: transcription.text,
      stream,
    });
  } catch (err: any) {
    console.error('[AUDIO] Whisper transcription failed:', err.message);
    return res.status(502).json({ error: 'Transcription failed', code: 'WHISPER_ERROR' });
  }
});
