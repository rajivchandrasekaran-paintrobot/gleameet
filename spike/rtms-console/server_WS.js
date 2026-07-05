import 'dotenv/config';
import rtms from '@zoom/rtms';

// ── console audio meter helpers ─────────────────────────────
function pcmLevel(buf) {
  // 16-bit signed PCM → RMS level 0..1
  let sum = 0;
  const samples = buf.length / 2;
  for (let i = 0; i < buf.length; i += 2) {
    const s = buf.readInt16LE(i) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

function meter(level, width = 30) {
  const filled = Math.min(width, Math.round(level * width * 4)); // ×4 gain for visibility
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ── RTMS wiring ─────────────────────────────────────────────
console.log('RTMS console listener starting…');
console.log(`Webhook: http://localhost:${process.env.ZM_RTMS_PORT}${process.env.ZM_RTMS_PATH}`);

rtms.onWebhookEvent(({ event, payload }) => {
  console.log(`\n[webhook] ${event}`);

  if (event !== 'meeting.rtms_started') return;

  console.log(`[rtms] meeting_uuid=${payload.meeting_uuid}`);
  console.log(`[rtms] stream_id=${payload.rtms_stream_id}`);

  const client = new rtms.Client();

  // Raw PCM, 16kHz mono, per-participant streams so metadata carries the speaker
  client.setAudioParams({
    contentType: rtms.AudioContentType.RAW_AUDIO,
    sampleRate:  rtms.AudioSampleRate.SR_16K,
    channel:     rtms.AudioChannel.MONO,
    dataOpt:     rtms.AudioDataOption.AUDIO_MULTI_STREAMS,
    duration:    20,   // 20ms frames
  });

  let frames = 0;
  let bytes  = 0;

  client.onAudioData((data, timestamp, metadata) => {
    frames++;
    bytes += data.length;
    const level = pcmLevel(data);
    const who = metadata?.userName || `user:${metadata?.userId ?? '?'}`;

    // single overwriting status line + meter
    process.stdout.write(
      `\r[audio] ${meter(level)} ${(level * 100).toFixed(0).padStart(3)}%  ` +
      `${who.padEnd(20).slice(0, 20)}  ` +
      `frames=${frames}  ${(bytes / 1024).toFixed(0)}KB  ts=${timestamp}`
    );
  });

  client.onActiveSpeakerEvent((timestamp, userId, userName) => {
    process.stdout.write(`\n[speaker] ${userName} (${userId})\n`);
  });

  // Optional: if your account has RTMS transcript enabled, log lines too
  client.onTranscriptData?.((data, timestamp, metadata) => {
    process.stdout.write(`\n[transcript] ${metadata?.userName ?? '?'}: ${data.toString()}\n`);
  });

  client.onLeave?.((reason) => {
    console.log(`\n[rtms] stream ended (${reason}). total: ${frames} frames, ${(bytes / 1024).toFixed(0)}KB`);
  });

  client.join(payload);
});