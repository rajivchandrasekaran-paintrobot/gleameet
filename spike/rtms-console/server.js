import 'dotenv/config';
import rtms from '@zoom/rtms';

const { ZM_RTMS_CLIENT, ZM_RTMS_SECRET, ZM_RTMS_PORT, ZM_RTMS_PATH } = process.env;

if (!ZM_RTMS_CLIENT || !ZM_RTMS_SECRET) {
  console.error('[init] ERROR: ZM_RTMS_CLIENT and ZM_RTMS_SECRET required in .env');
  process.exit(1);
}

// ── console audio meter helpers ─────────────────────────────
function pcmLevel(buf) {
  let sum = 0;
  const samples = Math.floor(buf.length / 2);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const s = buf.readInt16LE(i) / 32768;
    sum += s * s;
  }
  return samples > 0 ? Math.sqrt(sum / samples) : 0;
}

function meter(level, width = 30) {
  const filled = Math.min(width, Math.round(level * width * 4));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ── active clients registry to prevent leaks ─────────────────
const activeClients = new Map();

function cleanupClient(meetingUuid) {
  activeClients.delete(meetingUuid);
}

// ── RTMS wiring ─────────────────────────────────────────────
rtms.configureLogger({ logLevel: rtms.LogLevel.WARN });

console.log('RTMS console listener starting…');
console.log(`Webhook: http://localhost:${ZM_RTMS_PORT}${ZM_RTMS_PATH}`);

rtms.onWebhookEvent(({ event, payload }) => {
  console.log(`\n[webhook] ${event}`);

  if (event !== 'meeting.rtms_started') return;

  // Validate payload
  if (!payload?.meeting_uuid || !payload?.rtms_stream_id) {
    console.error('[rtms] ERROR: invalid payload (missing meeting_uuid or rtms_stream_id)');
    return;
  }

  const meetingUuid = payload.meeting_uuid;

  // Cleanup existing client for this meeting if it exists
  if (activeClients.has(meetingUuid)) {
    console.log(`[rtms] cleaning up previous client for ${meetingUuid}`);
    cleanupClient(meetingUuid);
  }

  console.log(`[rtms] meeting_uuid=${meetingUuid}`);
  console.log(`[rtms] stream_id=${payload.rtms_stream_id}`);

  const client = new rtms.Client();
  activeClients.set(meetingUuid, client);

  client.setAudioParams({
    contentType: rtms.AudioContentType.RAW_AUDIO,
    sampleRate:  rtms.AudioSampleRate.SR_48K,
    channel:     rtms.AudioChannel.MONO,
    dataOpt:     rtms.AudioDataOption.AUDIO_MULTI_STREAMS,
    duration:    20,
  });

  let frames = 0;
  let bytes  = 0;

  client.onAudioData((data, timestamp, metadata) => {
    frames++;
    bytes += data.length;
    const level = pcmLevel(data);
    const who = metadata?.userName || `user:${metadata?.userId ?? '?'}`;

    process.stdout.write(
      `\r[audio] ${meter(level)} ${(level * 100).toFixed(0).padStart(3)}%  ` +
      `${who.padEnd(20).slice(0, 20)}  ` +
      `frames=${frames}  ${(bytes / 1024).toFixed(0)}KB  ts=${timestamp}`
    );
  });

  client.onActiveSpeakerEvent?.((timestamp, userId, userName) => {
    process.stdout.write(`\n[speaker] ${userName} (${userId})\n`);
  });

  client.onTranscriptData?.((data, timestamp, metadata) => {
    process.stdout.write(`\n[transcript] ${metadata?.userName ?? '?'}: ${data.toString()}\n`);
  });

  client.onLeave?.((reason) => {
    console.log(`\n[rtms] stream ended (${reason}). total: ${frames} frames, ${(bytes / 1024).toFixed(0)}KB`);
    cleanupClient(meetingUuid);
  });

  client.onError?.((error) => {
    console.error(`\n[rtms] client error: ${error.message}`);
    cleanupClient(meetingUuid);
  });

  client.join(payload);
});