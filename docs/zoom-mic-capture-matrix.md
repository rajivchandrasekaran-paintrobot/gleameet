# Zoom Mic-Capture Matrix — Path B Spike

> **Status: NOT YET RUN.** Scaffold is in place (`spike/zoom-mic-capture-app/`); needs to be
> tunneled, registered/reused as a Zoom App, and tested live inside a Zoom desktop meeting.
> Fill in every field below once tested; flip this status line when done.

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

## 2. Probe results (fill in after a live test)

| Check | Result |
|---|---|
| `getUserMedia({ audio: true })` outside a meeting | |
| `getUserMedia({ audio: true })` **during** a live Zoom meeting | `'live'` / `NotReadableError` / other |
| Device-conflict case: does Zoom already hold the mic exclusively? | |
| `MediaRecorder` produces non-empty chunks once `'live'` | |
| Chunk size/interval sanity (1s chunks used here, matches extension's approach) | |
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
