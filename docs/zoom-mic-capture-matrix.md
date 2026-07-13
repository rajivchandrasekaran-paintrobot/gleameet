# Zoom Mic-Capture Matrix — Path B Spike

> **Status: BROWSER-PROVEN, ZOOM-CLIENT TEST PENDING.** (2026-07-12) The full behavioral
> loop is proven end-to-end from a plain browser against the deployed Render backend
> (`https://gleameet.onrender.com`): mic → 10s WebM chunks → `/audio/transcribe` (Whisper)
> → `speech_started`/`speech_ended` + `transcript_segment` → `/events/batch` → **live
> coaching prompt returned** (law K-02 fired, prompt delivered in-session) → `/meetings/end`
> → report generated with correct speaking-time stats. What remains is running the same
> page inside the Zoom desktop client during a live meeting (§2 below).

**Source plan:** `docs/Zoom_Conversion_Workplan.md`; supersedes the RTMS path
(`docs/zoom-capability-matrix.md`) as the chosen capture direction — RTMS was ruled out on
privacy grounds (server-side capture of all participants' audio), not technical feasibility.

**Why mic-in-webview:** it only ever captures the coached user's own microphone, gated by
the browser's standard mic-permission prompt. There is no server-side stream, no other
participant's audio ever reaches this app. This is the same privacy shape as the existing
Chrome extension's mic path.

---

## 1. Setup

- Reuses the Home URL / CSP scaffold proven in the RTMS spike (`spike/zoom-capture-app/`) —
  Zoom requires `Strict-Transport-Security`, `X-Content-Type-Options`, `Content-Security-Policy`,
  `Referrer-Policy` on the Home URL response, so plain `npx serve` won't validate; this spike
  reuses the same `express` + `helmet` server.
- `mediaSrc: ["'self'", 'blob:']` added to the CSP (needed for `MediaRecorder` chunk blobs;
  the RTMS spike's CSP didn't need this since it never touched local media).
- **CSP gotcha:** `script-src 'self' <zoom origins>` silently blocks inline `<script>`
  blocks — page logic must live in an external file (`app.js`) or the page dead-loads.
- Relay architecture: the webview only talks to the local spike server; the server
  forwards server-to-server to the Render backend. Avoids the backend CORS allowlist
  (which permits `http://localhost` but not `https://localhost:3443`) and keeps the
  session token out of the webview.

## 2. Probe results

**Browser baseline (2026-07-12, Chrome + Firefox on `http://localhost:3000`):**

| Check | Result |
|---|---|
| `getUserMedia({ audio: true })` in a plain browser | ✅ `'live'` (after granting permission; first Chrome attempt hit `NotAllowedError` from a stale block) |
| `MediaRecorder` produces valid chunks | ✅ — but **only** with the stop/restart-every-10s pattern; `start(1000)` timeslice chunks lack the WebM header after the first and Whisper cannot decode them |
| Full loop to Render backend | ✅ transcripts + live prompt (K-02) + post-meeting report with 60s/100% speaking-time stats |
| Speech-timing requirement | ⚠️ laws only trigger if `speech_started`/`speech_ended` bracket each voiced chunk — `transcript_segment` alone yields "0 seconds speaking time" and zero triggers |

**Inside the Zoom desktop client (still to run):**

| Check | Result |
|---|---|
| `getUserMedia({ audio: true })` outside a meeting | |
| `getUserMedia({ audio: true })` **during** a live Zoom meeting | `'live'` / `NotReadableError` / other |
| Device-conflict case: does Zoom already hold the mic exclusively? | |
| Background/tab-hidden behavior — does capture keep running if the Zoom App panel isn't focused? | |

## 3. Decision

- [ ] Mic-in-webview confirmed viable for MVP capture
- [ ] If viable: `AudioCaptureProvider` for `platform-zoom-app` is a **client-side** mic-only
      implementation (no backend capture component needed)
- [ ] Degraded-signal laws: interruption detection, turn-taking/dominance, and
      responding-to-others'-framing laws lose fidelity — mic-only never hears other
      participants. Flag for calibration (deferred from the old PR 14 in the retired plan).
- [ ] If NOT viable: fall back to lifecycle-only signals (`getMeetingContext`,
      `getRunningContext`, `onMeeting`) — minimal coaching, no audio capture at all.
