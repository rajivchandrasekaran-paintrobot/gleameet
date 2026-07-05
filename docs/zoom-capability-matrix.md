# Zoom Capability Matrix — Piece 0 Spike

> **Status: IN PROGRESS.** This captures findings gathered so far (app registration, account gating, RTMS
> billing model) via Zoom's dashboard, docs, and developer forum. Live in-meeting SDK enumeration
> (`getMeetingContext`, `onMeeting`, mic permission in the webview) has **not yet been executed** — the
> spike app is registered and tunneled but not yet confirmed loaded inside a real meeting panel. Update
> this doc once that happens, and flip the status line above when the fidelity decision is finalized.

**Source plan:** `docs/Zoom_Conversion_Workplan.md`, Part B/C — Piece 0.
**Zoom account under test:** free/Basic plan (40-min meeting cap, no Pro/Business features).

---

## 1. App registration

- **App type:** must be **"General App"** — this is the only one of Zoom's three dev-portal app types
  (General App / Server-to-Server OAuth / Webhook-only) that supports an embedded in-meeting panel via
  the Zoom Apps SDK. Server-to-Server has no client UI; Webhook-only has no SDK surface at all.
- **Home URL:** Zoom enforces OWASP security headers on the Home URL response before it will validate —
  specifically `Strict-Transport-Security`, `X-Content-Type-Options`, `Content-Security-Policy`, and
  `Referrer-Policy`. A plain static file server (`npx serve`) does **not** set these; had to swap to a
  minimal Express + `helmet` server (`spike/zoom-capture-app/server.js`) to pass validation. CSP was
  scoped to allow `https://appssdk.zoom.us` for the SDK script.
- **Domain Allow List:** expects a **bare hostname**, not a full URL (no `https://` scheme, no trailing
  path) — e.g. `gruffly-scholar-kung.ngrok-free.dev`, not `https://gruffly-scholar-kung.ngrok-free.dev/`.
  The separate **Home URL** field does take the full scheme+path URL. Easy to trip on this distinction.
- **Local dev loop:** `ngrok http <port>` free-tier URLs change on every restart, requiring the Home URL
  and Domain Allow List to be re-pasted each session. Not a blocker, just dev friction to budget for.

## 2. Real-time raw audio (RTMS) — gated, not self-serve on this account

**Finding: not reachable on a free/Basic Zoom account.** The `meeting:read:meeting_audio` scope (the
actual real-time audio stream) appeared grayed out/unselectable in the app's Scopes tab, independent of
app configuration. Cross-checked against the Zoom web portal account page — confirmed Basic plan, no
Pro/Business entitlements.

### What RTMS requires (per Zoom docs + developer forum, not yet independently re-verified end-to-end)
1. **Zoom Developer Pack** — a paid, credit-based add-on. **As of this spike, self-service purchasing is
   now available** (previously some developers reported needing to file a manual enablement request on
   the Zoom Developer Forum and wait for staff approval even after configuring scopes correctly — see
   forum threads on "Enable RTMS for App ID ...").
2. **Account-level admin toggle** — "sharing real-time meeting content with apps" plus auto-start, set
   under Zoom Apps settings in the web portal (separate from the Developer Marketplace dashboard).
3. **RTMS-specific scopes** on the app: `meeting:read:meeting_audio` (the actual stream),
   `rtms:read:rtms_started` / `rtms:read:rtms_stopped` / `rtms:read:rtms_interrupted` (lifecycle
   notifications for the stream itself), plus `zoomapp:inmeeting` (required for any in-meeting panel).

### RTMS billing model (confirmed from Zoom's Developer Pack pricing terms)
- **Billed to the app developer/Customer** (whoever holds the Developer Pack subscription), **not** to
  each end user/meeting host. Metered by "Meeting Streaming Minutes" attributable to the app across all
  meetings it streams into.
- **Rates:** $0.02 / meeting-streaming-minute **with transcription**; $0.01 / minute **without**.
- **End-user/host side:** no purchase required — just needs to approve the account-level "share real-time
  content with apps" authorization once. This removes the earlier concern that every individual GleaMeet
  user would need their own paid Zoom plan.
- **Illustrative cost at scale** (not a committed estimate, for decision-making only):

  | Scenario | Monthly RTMS cost |
  |---|---|
  | 1 user × 10 meetings/mo × 45 min, with transcription | ~$9.00 |
  | 100 users, same usage | ~$900 |
  | 1,000 users, same usage | ~$9,000 |

  This is a real, linearly-scaling per-usage cost with no equivalent on the Chrome/Meet extension (tab
  capture there is free). Whether it's acceptable depends on GleaMeet's pricing/business model — **not
  something this spike should decide unilaterally.**

### Free trial (available — closes open item #4 below at zero cost)
Zoom offers a **Developer Pack Free Trial: 20 free credits**, unlocking both QSS and RTMS access.
Credits are $1 each (confirmed via the published consumption-rate example), so 20 credits = **1,000
RTMS-with-transcription streaming minutes** (~22 full 45-minute test meetings) before any real spend is
required. Unused credits expire after 12 months. This is enough to fully validate the RTMS path — webhook
firing, WebSocket signaling, real transcript data reaching the backend — without a paid commitment.
**Action:** must be claimed manually in the Zoom dashboard (account-tied, requires the account owner's
login) — not something that can be done outside the browser session.

### RTMS architecture (for whoever implements Piece 7, if this path is chosen)
- Not exposed via simple SDK calls like `getMeetingContext`. Flow is: Zoom sends a webhook
  (`meeting.rtms_started`) to an endpoint registered under **Event Subscriptions**, containing a
  signaling URL; the app then opens a **WebSocket** to that URL to receive audio/video/transcript media
  frames. Meaningfully more infrastructure than the SDK-panel-only path.
- Third-party wrappers exist (e.g. Recall.ai's RTMS passthrough API) to abstract the WebSocket/signaling
  handling, but they still require RTMS to be enabled/purchased — no bypass of the above gates.
- Recall.ai also has a **separate, unrelated product** — a meeting-bot that joins as a visible participant
  and captures audio without needing RTMS scopes at all. Rejected as an option for GleaMeet: it would show
  up in the participant list, breaking the "private, invisible coaching" product framing, and raises
  additional consent questions for other meeting participants. Documented here only to close the loop on
  investigation, not recommended.

## 3. Free-tier-reachable capabilities (not yet live-tested)

These require **no RTMS, no Developer Pack, no special scopes** — available on any account tier via the
standard Zoom Apps SDK. Enumeration is written into `spike/zoom-capture-app/index.html` but **has not yet
been executed inside a live Zoom meeting** — pending confirmation.

| Capability | Mechanism | Expected to work on Basic? |
|---|---|---|
| Meeting context (ID, topic, participant ID) | `zoomSdk.getMeetingContext()` | Yes (unconfirmed live) |
| Running context (confirms in-meeting) | `zoomSdk.getRunningContext()` | Yes (unconfirmed live) |
| User context | `zoomSdk.getUserContext()` | Yes (unconfirmed live) |
| Lifecycle events (join/leave/mute/etc.) | `zoomSdk.onMeeting()` | Yes (unconfirmed live) |
| User's own mic audio | `navigator.mediaDevices.getUserMedia()` in the webview | Unconfirmed — standard web API, but Zoom's sandboxed webview may block media APIs outright; not yet tested |

### Known limitation of mic-in-webview, even if it works
Captures **only the app user's own voice**, not other participants — fundamentally different from RTMS or
the Chrome extension's tab-capture approach. Several of the 12 behavioral laws in `packages/law-registry`
depend on hearing the *other* speaker (interruption detection, turn-taking/dominance, responding to
others' framing, acknowledgment of what was said to the user) — those would need to degrade gracefully or
be disabled under a mic-only fidelity tier. This is the exact problem Piece 9 (signal calibration) exists
to handle, but mic-only represents close to the floor of that degradation, not a minor compromise.

## 4. Backend readiness (confirmed, separate from Zoom-side findings)

Independent of what Zoom capture path is chosen, the existing backend already accepts Zoom-sourced events
with **zero route/schema changes**. Proven via a TDD test
(`packages/backend/tests/zoom-spike-ingest.test.ts`, committed on `spike/zoom-capture`): `POST
/events/batch` validates and persists a `platform: 'zoom'` event end-to-end through the existing
`validateRawEvent` → `insertRawEvents` path. This means whichever capture path is chosen, wiring it into
the backend is not a blocker.

## 5. Open items — not yet resolved

1. **Live SDK enumeration inside a real meeting** — confirm `getMeetingContext`/`onMeeting`/`getUserContext`
   actually return data (not just registered/configured) once the panel loads in a live Zoom desktop
   meeting.
2. **Mic permission test** — confirm whether `getUserMedia()` is actually grantable inside Zoom's
   sandboxed Apps webview, or blocked by the sandbox regardless of browser standard support.
3. **RTMS host-side authorization confirmation** — the claim that end users only need to flip a free
   account-level toggle (not purchase anything) is inferred from Zoom's billing terms language
   ("Customer" = Developer Pack holder), not independently verified by asking Zoom directly. Worth a
   confirming post on the Zoom Developer Forum before treating this as settled, given the earlier
   confusion in this investigation.
4. **Actual real-time RTMS purchase not made** — pricing is known (per-minute metered), but no live
   Developer Pack purchase has been made to confirm self-service checkout works as described on a Basic
   account (i.e., can RTMS credits be purchased *without* first upgrading the base Zoom plan?).
5. **Final fidelity decision** — pending resolution of items 1–4 above and a product/business call on
   whether the RTMS per-minute cost is acceptable. Not yet made.

## 6. Preliminary lean (not final)

Given confirmed findings so far: RTMS is technically self-service and reasonably priced per-minute, with
billing on the developer side (not a per-user blocker) — better than initially feared. But it adds real
infrastructure (webhook + WebSocket receiver, per Piece 7) and a recurring linear cost that needs a
product/pricing decision, not a spike-level one. Recommend finishing items 1–2 above (cheap, fast, no
purchase required) to confirm the free-tier floor works at all before committing either direction.
