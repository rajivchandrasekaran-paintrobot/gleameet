# GleaMeet Zoom Mic-Capture Spike (Path B)

Throwaway spike that probes whether the local user's own microphone can be
captured from inside the Zoom desktop client's webview — the privacy-preserving
alternative to RTMS. **Never** taps other participants' audio or the meeting's
mixed stream.

## Why this exists

The plan calls out two paths for getting audio out of a Zoom meeting:
- **Path A — RTMS** (Real-Time Media Streams): taps the meeting's mixed audio
  from a server-side media connector. Powerful but raises consent/privacy
  concerns and is heavy to operate.
- **Path B — local mic in the Zoom App webview** (this spike): records the
  user's own mic using `getUserMedia` inside the embedded webview and ships
  the chunks somewhere for transcription. The audio we capture is
  *whatever the user would have said anyway* — we are not eavesdropping on
  other participants.

## What this spike answers

1. Does `getUserMedia({ audio: true })` succeed from inside the Zoom desktop
   app's embedded webview?
2. Does it fail with `NotReadableError` while Zoom is already holding the
   mic for the call (the "device held by another tab" case)?
3. Can we `MediaRecorder.start(1000)` and actually receive chunks?
4. Does the Zoom Apps SDK initialise with the right capabilities?

## Run

Two modes, controlled by a `--local` flag:

**Local dev (against the Zoom desktop client):**
```bash
npm install
npm run dev
```
Listens on:
- `https://localhost:3443` — for loading inside the Zoom desktop app
  (HTTPS is required; a self-signed cert is generated on first run in
  `.certs/`).
- `http://localhost:3000` — convenience plain-HTTP for browser testing.

**Render / production (default — no flag):**
```bash
npm start
```
Listens on plain HTTP on `process.env.PORT` (Render assigns this and
terminates HTTPS at its own edge, so no self-signed cert is needed or
generated in this mode). This is what Render's build should run as the
start command.

## Relay to the Render backend (full behavioral loop)

With two env vars set, the local server relays each 10s mic blob to the
deployed GleaMeet backend: `/audio/transcribe` (Whisper) → wraps the text as a
`transcript_segment` → `/events/batch` (feature → law → intervention engine)
and logs any returned **coaching prompt** in the terminal. Without them it
falls back to local-only chunk logging.

```powershell
$env:RENDER_API_BASE = 'https://gleameet.onrender.com'
$env:GOOGLE_ACCESS_TOKEN = '<paste access token>'
npm start
```

The webview never talks to Render directly — everything proxies through this
server, so CORS never applies and the session token never enters the webview.

**Getting `GOOGLE_ACCESS_TOKEN`** (~1 min, expires after ~1 h — re-paste on 401):
1. Open https://developers.google.com/oauthplayground
2. Step 1: select `userinfo.email` + `userinfo.profile` scopes → **Authorize APIs**
3. Step 2: **Exchange authorization code for tokens** → copy the `access_token`

Session lifecycle: the relay calls `/auth/session` + `/meetings/start` when you
click **Start mic probe**, and `/meetings/end` (which triggers report
generation, logging the `report_id`) when you click **Stop**. Watch the other
side in the Render dashboard → `gleameet` service → **Logs** tab
(`[AUDIO]` / `[EVENTS]` / `[MEETING]` lines).

## Load inside Zoom

The Zoom desktop client loads apps by URL. For local development, the
app needs to be registered on the Zoom App Marketplace with
**`dev_allow_local: true`** and point at `https://localhost:3443`. You will
also need to trust the self-signed certificate (the client opens it once
during install and the SDK handles the rest).

When the page loads inside the Zoom webview you should see, in the log:
- `zoomSdk.config` — confirms capabilities were accepted
- `meetingContext` / `runningContext` / `userContext` — confirms SDK calls work
- `getUserMedia` — if this throws `NotReadableError` it means the device is
  held by the Zoom call itself and Path B needs a different device-pick
  strategy.
