# GleaMeet — Zoom Desktop App Conversion: Analysis & Work Breakdown

> **Deliverable type:** Analysis + git-managed work breakdown. No code is written here.
> **Author role split:** Opus produced this architecture/breakdown; Sonnet will execute each piece.
> **Target (per user):** First cut = **Zoom desktop app**. Teams desktop = later. Chrome/Meet extension must keep working throughout.

---

## Context

GleaMeet today is a Chrome extension that coaches the user privately during **Google Meet** only, backed by an Express/Postgres/Redis server. The server, shared data model, coaching engine, and reporting are already substantially platform-neutral. The client is not — it is fused to Chrome extension primitives (`chrome.identity`, `chrome.runtime`, `chrome.storage`, `tabCapture`, offscreen-document audio) and to Google-only identity.

The goal is to reach a **working Zoom desktop app** that does a full meeting lifecycle (start / pause / end), shows private prompts in a Zoom panel, logs in with a non-Google identity, and produces post-meeting reports — reusing the existing backend and coaching logic. Teams follows the same skeleton afterward.

This document (a) analyzes the current codebase against that goal, (b) answers the capture-fidelity sequencing question, and (c) decomposes the work into self-contained, individually-mergeable git pieces with explicit dependency order and exit criteria.

---

## Part 0 — Target architecture: dual-adapter (Ports & Adapters / Hexagonal)

The organizing principle is **two adapter seams with a frozen contract between them**, so the front-end UX and the backend analysis engine can be developed in parallel without breaking each other.

```
Platform UX  (Meet / Zoom / Teams panel)
   ↕   platform adapter  — AuthProvider, MeetingPlatformAdapter, PromptSurface, AudioCaptureProvider
client-core  (session, batching, polling — platform-neutral)          ← FRONT-END ADAPTER
   ↕
====  @gleameet/shared : normalized event model + API types  ====     ← THE CONTRACT (already exists)
   ↕
Transport layer  (Express routes = thin HTTP → engine mapping)        ← BACK-END ADAPTER
   ↕   engine port — ingestEvents() / startSession() / endSession()
Analysis Engine Core  (feature-engine → law-evaluator → intervention-engine)   ← PURE CORE
   ↕   StateStore(Redis) · PersistencePort(Postgres) · LlmPort · PromptSink
```

**Three rules make "develop in parallel, one won't break the other" real:**

1. **`packages/shared` is the contract / anti-corruption layer.** Only the two adapters import it; neither side reaches past it. Front-end and back-end can then be rebuilt independently. Today the extension leaks `chrome.*` into client logic (`api-client.ts:14-40`) — Pieces 1–3 fix the front side.
2. **A backend *engine port* decouples the analysis engine from transport/infra.** Routes become a thin transport adapter mapping HTTP → `AnalysisEngine.ingestEvents(session, events)`. The engine core depends only on abstract ports (`StateStore`, `PersistencePort`, `LlmPort`, `PromptSink`) — so coaching logic is unit-testable with in-memory fakes and Redis/LLM are swappable without touching the engine. The backend is already close to reusable, so this is a **light** extraction, not a rewrite.
3. **Contract tests are the enforcement mechanism.** A shared suite asserts the wire shape: the front end develops against a mock backend satisfying it; the backend must pass it in CI. A drift breaks the test on whichever side moved, not in production.

**Minimum viable decoupling** (don't over-engineer): freeze `shared`, route all analysis through one engine port, add contract tests. Full `StateStore`/`LlmPort` abstraction is *optional depth* (Piece B) that can follow.

---

## Part A — Current codebase analysis (grounded in the repo)

### Monorepo (4 real packages — `teams-app`/`zoom-app` do NOT exist, not even as `dist/`)
```
packages/shared        TS types, API contracts, constants   (reusable as-is, minor extension)
packages/law-registry  12 behavioral-law JSON defs          (unchanged)
packages/backend       Express API + pipeline               (reusable; needs identity + queue + source-metadata work)
packages/extension     Chrome MV3 client                    (the coupled part; source of extraction)
```
Root `package.json` workspaces list only these four. Build order: `shared → law-registry → backend | extension`.

### Backend — close to reusable, three concrete gaps
- **Auth is Google-only.** `routes/auth.ts:14` — `POST /auth/session` takes `google_id_token`, verifies against Google userinfo/tokeninfo, `upsertUser(googleSubjectId, …)`. No provider abstraction.
- **Prompt queue is in-memory.** `routes/prompts.ts:9` — `const pendingPrompts = new Map<...>()`; `enqueuePendingPrompt()` (called by the intervention engine) pushes into it; `/prompts/poll` drains it. A code comment already says "Redis-backed in production." Fragile across restarts / multi-instance.
- **Event source is coarse.** `schema.sql:60` — `source CHECK IN ('extension','backend','adapter')`. No way to distinguish Zoom-app vs Chrome vs SDK-context vs audio origin.
- Pipeline itself (`feature-engine` → `law-evaluator` → `intervention-engine` → `rankAndSelectPrompt` at `intervention-engine.ts:28`) is platform-neutral and stays.
- Sessions already persist to Postgres `user_sessions` (30-day TTL) with Redis fast-path + Postgres fallback — good, reuse.

### Shared model — already multi-platform, two hard-coded identity leaks
- `models.ts:43` — `Platform = 'google_meet' | 'teams' | 'zoom' | 'slack'` ✅ (Zoom already a first-class platform value).
- `models.ts:4` — `User.google_subject_id` hard-coded; `models.ts:39` / `api-types.ts:17` — `MeetingSession.extension_version` / `MeetingStartRequest.extension_version` are extension-specific naming.
- `schema.sql:9` — `google_subject_id VARCHAR(255) UNIQUE NOT NULL` is the canonical identity key.

### Extension — the coupled client (what must be decomposed)
| File | LOC | Contains | Reusable? |
|---|---|---|---|
| `utils/api-client.ts` | 161 | All backend HTTP calls | **Logic yes**, but bound to `chrome.storage`/`chrome.identity` (`api-client.ts:14-40`) — must be de-chromed |
| `background/service-worker.ts` | 618 | Session lifecycle, event batching, prompt polling, tab-audio orchestration | **Logic yes** (session/batch/poll); Chrome runtime plumbing no |
| `utils/event-factory.ts` | — | Normalized event creation | **Yes** — platform-neutral core |
| `utils/transcript-attribution.ts` | — | User-vs-other attribution | **Yes** — platform-neutral core |
| `popup/Popup.tsx` | 710 | Auth UI, status, history, report views | **Screens yes**, but too large/Chrome-specific; must be split |
| `content/content-script.ts` | 915 | Meet DOM speech/caption capture, overlay | **Chrome/Meet-only** — not reused by Zoom |
| `offscreen.ts` | — | MV3 mic + tab audio capture | **Chrome-only** — Zoom cannot use `tabCapture`/offscreen |
| `utils/platform.ts` | — | URL-based platform detection | **Chrome-only** — Zoom uses SDK context, not URL heuristics |

**Takeaway:** ~40% of the client (API/session/event/attribution logic + UI screens) is genuinely reusable; the capture and runtime layers are Chrome-specific and have no direct Zoom equivalent.

---

## Part B — Zoom desktop reality check (the make-or-break constraint)

A Zoom App is **not** a browser extension. It runs as a sandboxed web view embedded in the Zoom desktop client, driven by the **Zoom Apps SDK**. This inverts the extension's most powerful capabilities:

- **No `tabCapture`, no offscreen document, no privileged `getUserMedia` on the meeting stream.** The extension's entire audio path (`offscreen.ts` → 10s WebM chunks → Whisper) does not port. Real-time meeting audio/transcript from inside a Zoom App is gated behind separate Zoom mechanisms (e.g. RTMS / Meeting SDK / cloud-recording transcript APIs), each with its own auth, scopes, and review implications.
- **Meeting context comes from the SDK, not the DOM.** `getMeetingContext`, `getRunningContext`, `getUserContext`, lifecycle events — replace URL/DOM detection (`platform.ts`, `content-script.ts`).
- **Prompts render in the Zoom app panel/sidebar**, not a DOM overlay injected into the meeting page.
- **Auth is Zoom OAuth / app-context**, not `chrome.identity`.

**This is exactly Risk R1 in the SoW, and for Zoom it is more binding than for Meet.** The coaching engine is driven by transcript-derived features; if no usable real-time transcript is available inside the Zoom App, the MVP must fall back to lower-fidelity signals (meeting context + user-granted mic where allowed + whatever Zoom exposes).

### Answer to your sequencing question (lower-fidelity MVP #1 vs. spike #2)

**Recommendation: do a short, time-boxed capture spike FIRST — but a narrow one, not a full investigation phase.** Rationale:

- Unlike the Meet extension (which had privileged capture *before* you designed anything), the Zoom App gives you **no guaranteed capture path**. The answer to "what real-time signal can this app actually get?" changes the shape of the `MeetingPlatformAdapter`, the `AudioCaptureProvider`, whether Whisper stays in the loop, and even which OAuth scopes you request (which drives marketplace review later). Building the full shell blind risks a large rework and wasted review cycles.
- But a *heavyweight* discovery phase is overkill for a first cut. Time-box it to ~1–2 days with one concrete exit artifact: **a capability matrix + a thin proof that at least one real-time (or near-real-time) signal reaches the backend from inside a running Zoom App.**
- So: **Piece 0 (spike) → then build the lower-fidelity MVP against whatever the spike proved.** You get the learning of #1 without committing the architecture blind, and you avoid a big-bang #2. If the spike shows real-time transcript is infeasible for the first cut, the MVP ships on meeting-lifecycle + user-mic signals and coaching is calibrated down accordingly (Piece 9).

This reorders the SoW: **Zoom leads the critical path (not Teams)**, and a capture spike gates the shell.

---

## Part C — Work breakdown (self-contained, git-managed pieces)

Each piece = one branch → one PR, independently reviewable, with its own exit criteria. Pieces are ordered by dependency; where two pieces are independent they can run in parallel (noted). Branch names are suggestions.

Throughout: **the Chrome/Meet extension must stay green.** Every backend/shared change is additive and backward-compatible (keep `google_id_token`, keep `extension_version`, keep `source` enum) until a final cleanup piece.

### Piece 0 — Zoom capture spike + capability matrix `spike/zoom-capture`
- **Type:** throwaway spike + written decision doc (the doc is the durable artifact; code is disposable).
- **Do:** stand up a minimal Zoom App (Zoom Apps SDK) that loads in the desktop client; enumerate what's actually reachable at runtime — meeting context, lifecycle events, user context, and every viable real-time/near-real-time audio-or-transcript path (RTMS vs Meeting SDK vs live transcription/CC vs user-granted mic in the app webview). Prove **one** signal path end-to-end into `POST /events/batch`.
- **Exit:** `docs/zoom-capability-matrix.md` committed, answering auth surface, prompt-render surface, capture allowance + chosen path, required OAuth scopes, and background-polling allowance. A decision recorded: **first-cut capture fidelity** (real-time transcript vs. mic-only vs. lifecycle-only).
- **Blocks:** Pieces 6, 7, 9 (shell adapter + audio provider + calibration). Does **not** block Pieces 1–5 (foundation refactor), which can start in parallel.

### Piece 1 — Extract `packages/client-core` (behavior-preserving) `refactor/client-core`
- **Do:** create the new workspace package and move platform-neutral logic out of the extension **with zero behavior change**: API access, session lifecycle, event buffering/batching, prompt poll+ack, event normalization, transcript attribution. Define the runtime interface contracts.
  - Extract from: `extension/utils/api-client.ts`, session/batch/poll logic in `background/service-worker.ts`, `utils/event-factory.ts`, `utils/transcript-attribution.ts`.
  - Create: `client-core/src/session-manager.ts`, `api/gateway-client.ts`, `events/event-factory.ts`, `events/batch-flusher.ts`, `prompts/prompt-poller.ts`, `transcript/transcript-attribution.ts`, `types/runtime.ts`.
  - `types/runtime.ts` defines: `AuthProvider`, `StorageProvider`, `MeetingPlatformAdapter`, `PromptSurface`, `AudioCaptureProvider`, `RuntimeMessenger`. **Chrome storage/identity coupling in `api-client.ts` is replaced by injected `StorageProvider`/`AuthProvider`** — no `chrome.*` in this package.
- **Exit:** package builds standalone; contains no `chrome.*` reference; unit tests for session/batch/poll pass.
- **Blocks:** Pieces 2, 6, 7. First real dependency for everything client-side.

### Piece 2 — `packages/platform-chrome` + thin the extension `refactor/platform-chrome`
- **Do:** move Chrome-specific code into a new adapter package and rebind the extension to `client-core` + `platform-chrome`. Implement the interfaces for Chrome: `chrome-auth-provider.ts`, `chrome-storage-provider.ts`, `chrome-meeting-adapter.ts` (Meet DOM + `platform.ts`), `chrome-audio-provider.ts` (offscreen/tabCapture), `chrome-prompt-surface.ts` (DOM overlay). `service-worker.ts` / `content-script.ts` / `offscreen.ts` become bootstrap/wiring only; `popup/index.tsx` still mounts the current popup (UI split is Piece 3).
- **Exit (regression gate — this is the R3 safety net):** Chrome extension passes full regression on **start, pause, end, history, report** on Google Meet, identical behavior. All client API/session logic now lives outside `packages/extension`.
- **Depends on:** Piece 1. **Parallel-safe with:** Pieces 4, 5 (backend), Piece 0.

### Piece 3 — `packages/ui-app` shared screens `refactor/ui-app`
- **Do:** split the 710-line `Popup.tsx` into reusable, runtime-agnostic React screens/components consumed by Chrome popup and the future Zoom panel: `screens/{AuthScreen,LiveCoachingScreen,HistoryScreen,TranscriptScreen,ReportScreen}.tsx`, `components/{PromptCard,MeetingStatusBadge}.tsx`, `hooks/useSessionState.ts`. Rebind the Chrome popup to consume them.
- **Exit:** Chrome popup renders identically from shared screens; `ui-app` builds standalone with no `chrome.*`.
- **Depends on:** Piece 1 (for `useSessionState`/state types). **Parallel-safe with:** Piece 2.

### Piece 4 — Backend identity refactor + `user_identities` `feat/identity-provider-model`
- **Do:** introduce a provider-aware identity layer, Google fully backward-compatible.
  - New: `backend/src/auth/providers/{google,zoom}.ts` (Microsoft added in the Teams milestone), `auth/identity-service.ts`, `auth/types.ts`.
  - Routes: add `POST /auth/session/google` and `POST /auth/session/zoom`; keep `POST /auth/session` as a **Google alias** for existing extension builds.
  - Schema: add `user_identities(identity_id, user_id FK CASCADE, provider, provider_subject_id, email, display_name, created_at, UNIQUE(provider, provider_subject_id))`; **keep `users.google_subject_id` for now**; backfill `user_identities` from existing users.
  - Queries (`db/queries.ts`): add `upsertUserIdentity`, `getUserByIdentity`, `linkIdentityToUser`, `createUserWithIdentity`; route existing lookups through identities; extend delete routines to remove identity rows.
  - Shared: add `IdentityProvider = google | microsoft | zoom`; add request types `AuthSessionGoogleRequest` / `AuthSessionZoomRequest`.
- **Exit:** existing Chrome users still sign in via Google (alias path); a Zoom-provider session can be created without any Google account; user-deletion removes identity rows. Migration script + backfill included and idempotent.
- **Parallel-safe with:** Pieces 1–3, 5, 0. **Blocks:** Piece 6 (Zoom auth wiring).

### Piece 5 — Redis-backed prompt queue + richer event source `feat/redis-prompt-queue`
- Two tightly-related backend hardening changes; can be one PR or split into 5a/5b.
- **5a — Redis prompt queue:** new `backend/src/services/prompt-queue.ts`; move `pendingPrompts` map out of `routes/prompts.ts`; `enqueuePendingPrompt` (called by intervention engine) and `/prompts/poll` + `/prompts/ack` become thin over Redis with **idempotent ack** and safe dequeue (no duplicate delivery — Risk R4). `/prompts/poll` and `/prompts/ack` contracts unchanged.
  - **Exit:** queue survives backend restart; no duplicate prompt delivery under repeated poll; existing Meet flow unaffected.
- **5b — Event/session source metadata:** schema — add `raw_events.source_runtime`, `raw_events.source_channel` (keep `source` for compat); rename intent `meeting_sessions.extension_version → client_version` **additively** (accept both), add `client_type`, `runtime_type`. Shared: add `ClientType`, `RuntimeType`, `source_runtime`/`source_channel` on `RawEvent`; `MeetingStartRequest` gains `client_version`/`client_type`/`runtime_type` (keep `extension_version` optional). Routes `meetings.ts`/`events.ts` accept the new fields.
  - **Exit:** Chrome extension still posts with old fields and works; new fields persist when sent.
- **Parallel-safe with:** Pieces 1–4, 0.

### Piece A — Backend engine port (transport ↔ analysis-engine seam) `refactor/backend-engine-port`
- **Do:** introduce the back-end adapter seam. Define an `AnalysisEngine` port (`backend/src/engine/engine-port.ts`) with `startSession()`, `ingestEvents(session, events): PromptDecision[]`, `endSession(): Report`. Move the `feature-engine → law-evaluator → intervention-engine` orchestration behind it so the analysis engine is callable independent of Express. Route handlers (`events.ts`, `meetings.ts`) become thin transport adapters that translate HTTP ↔ port calls; they stop calling engine internals directly. Prompt emission goes through a `PromptSink` (implemented by Piece 5a's Redis queue). **No behavior change** to the Meet flow.
- **Exit:** the engine can be driven end-to-end from an in-memory test harness (no HTTP/Redis) producing the same prompt decisions; routes only touch the port. Existing Jest suite green.
- **Parallel-safe with:** Pieces 1–5, 0. **Enables** the backend and front-end streams to evolve independently.

### Piece B (optional depth) — Engine infra ports: `StateStore` / `LlmPort` / `PersistencePort` `refactor/backend-ports`
- **Do:** abstract the engine's Redis state, Postgres persistence, and LLM access behind interfaces injected into the engine core, with the current Redis/Postgres/OpenAI implementations as the default adapters. Lets coaching logic be tested with fakes and infra be swapped without touching the core.
- **Exit:** engine core has zero direct `redis`/`pool`/OpenAI imports; unit tests run with in-memory fakes.
- **Depends on:** Piece A. **Skip for the first cut if time-boxed** — Piece A alone delivers the decoupling; B is hardening.

### Piece C — Cross-adapter contract tests + mock backend `test/contract-suite`
- **Do:** a shared contract-test suite over `@gleameet/shared` API types that both adapters must satisfy: request/response shapes for auth, `meetings/start|end`, `events/batch`, `prompts/poll|ack`, history, report. Provide a **mock backend** honoring the contract so front-end packages (`client-core`, `zoom-app`) can develop/test without a live server; wire the same suite against the real backend in CI.
- **Exit:** front-end streams build against the mock; CI fails on either side if the wire contract drifts. This is the mechanism that keeps parallel front/back development from breaking each other.
- **Depends on:** frozen `shared` contract (coordinate with Pieces 4, 5b which extend it — freeze after those land). **Parallel-safe** otherwise.

### Piece 6 — `packages/zoom-app` shell: auth + lifecycle + prompts `feat/zoom-app-shell`
- **The first cut's centerpiece.** Greenfield source package (nothing exists today).
  - Create: `zoom-app/{package.json,tsconfig.json}`, `src/index.tsx`, `src/app/ZoomApp.tsx`, `src/runtime/{zoom-auth-provider,zoom-storage-provider,zoom-meeting-adapter,zoom-prompt-surface,zoom-context}.ts`, `public/manifest.json`; add Vite (or equivalent) build tooling; register workspace + `build:zoom-app`/`dev:zoom-app` scripts in root `package.json`.
  - Wire: Zoom OAuth/app-context → `POST /auth/session/zoom` (Piece 4); meeting context/lifecycle via Zoom Apps SDK → `client-core` session lifecycle (Piece 1); prompts rendered in the Zoom panel via `PromptSurface` (Piece 3 components); events tagged `source_runtime='zoom_app'` (Piece 5b).
  - **Capture wiring uses whatever Piece 0 proved** — this piece assumes the spike's chosen path; it does not re-litigate capture.
- **Exit:** Zoom desktop app completes a full lifecycle (start → live private prompts → pause → end), authenticates without Google, and fetches history + report. Meeting appears in backend tagged as `zoom_app`.
- **Depends on:** Pieces 1, 3, 4, 5, and 0's decision. This is the convergence point.

### Piece 7 — Zoom real-time capture provider `feat/zoom-audio-capture`
- **Do:** implement the chosen capture path from Piece 0 as a proper `AudioCaptureProvider`/signal source feeding normalized `transcript_segment` events with correct attribution + `source_channel`. If the spike concluded real-time transcript is infeasible for v1, this piece instead implements the **lower-fidelity** signal set and is explicitly scoped as such (and flagged for a later upgrade).
- **Exit:** coaching features populate from Zoom signals end-to-end; attribution keeps prompts user-only.
- **Depends on:** Piece 6 (shell) + Piece 0. Can trail Piece 6 slightly.

### Piece 8 — Zoom UI polish + reports/history in-panel `feat/zoom-app-ui`
- **Do:** mount `ui-app` history/report/transcript screens inside the Zoom panel; ensure prompt-ack analytics are identical to Chrome (Risk R5 — comparable behavior across surfaces).
- **Exit:** history + post-meeting report viewable inside the Zoom app; ack events recorded identically to extension.
- **Depends on:** Pieces 3, 6.

### Piece 9 — Zoom signal calibration & QA `chore/zoom-calibration`
- **Do:** compare feature quality Meet vs Zoom; tune per-platform thresholds/confidence weighting in the law engine to prevent over-triggering on lower-fidelity Zoom signals (Risk R6). Add platform-aware config rather than hard-coding.
- **Exit:** coaching quality acceptable on Zoom; no prompt storms; Meet behavior unchanged.
- **Depends on:** Pieces 6, 7.

### Piece 10 — Private Zoom distribution + compliance artifacts `chore/zoom-private-dist`
- **Do:** package as a **private/beta Zoom app** (no Marketplace review needed for first users — SoW §9.3); least-privilege OAuth scope matrix; privacy policy covering Zoom meeting/audio/transcript handling + retention; short reviewer test plan; per-platform monitoring/metrics tag. These are prepared *during* the build, not after.
- **Exit:** installable private Zoom app + compliance artifact set ready; public Marketplace submission explicitly deferred to a later milestone.
- **Depends on:** Pieces 6–9.

### Piece 11 (cleanup, after Zoom is stable) — retire compatibility shims `chore/identity-cleanup`
- Drop `users.google_subject_id` after the compatibility window; remove `extension_version`/`source`-enum legacy once all clients send new fields. Separate, deliberately late PR (Risk R2).

### Deferred — Teams desktop (second cut, mirrors the Zoom skeleton)
`packages/teams-app` + `platform-teams-app`, `auth/providers/microsoft.ts` + `POST /auth/session/microsoft`, Teams JS SDK meeting context, Teams SSO, side-panel prompt surface. Reuses `client-core`, `ui-app`, identity model, and Redis queue unchanged — which is the whole point of doing the extraction first.

---

## Part D — Dependency graph & merge order

```
                 ┌───────────────► Piece 4  (identity) ──┐
Piece 0 (spike) ─┤                                        │
   (parallel)    └───────────────► Piece 5  (queue+meta) ─┤
                                                          ▼
Piece 1 (client-core) ─► Piece 2 (platform-chrome, REGRESSION GATE)   [Chrome stays green]
        │            └─► Piece 3 (ui-app) ──────────────┐
        └──────────────────────────────────────────────┼─► Piece 6 (zoom shell)
                                                        │        │
                                              (needs 1,3,4,5,0)  ├─► Piece 7 (capture)
                                                                 ├─► Piece 8 (zoom UI)
                                                                 └─► Piece 9 (calibration) ─► Piece 10 (private dist)
                                                                                                    │
                                                                                            Piece 11 (cleanup, late)
```

**Two independent lanes** (this is the payoff of the dual-adapter architecture):
- **Back-end lane:** Piece 4 (identity) · Piece 5 (queue+metadata) · Piece A (engine port) · Piece B (infra ports, optional).
- **Front-end lane:** Piece 1 (client-core) · Piece 2 (chrome regression gate) · Piece 3 (ui-app) · Piece 6+ (zoom).
- **Bridge:** Piece C (contract tests + mock backend) lets the front-end lane run against a mock while the back-end lane evolves. Freeze `@gleameet/shared` after Pieces 4 + 5b land, then stand up C.

**Recommended execution waves (with Sonnet doing the pieces):**
1. **Wave 1 (parallel):** Piece 0 (spike) · Piece 1 (client-core) · Piece 4 (identity) · Piece 5 (queue+metadata) · Piece A (engine port).
2. **Wave 2 (parallel, after 1):** Piece 2 (chrome rebind + **regression gate**) · Piece 3 (ui-app) · Piece C (contract tests + mock) · Piece B (optional).
3. **Wave 3:** Piece 6 (zoom shell) — the convergence, built against the mock (C) then the real backend.
4. **Wave 4 (parallel):** Pieces 7, 8.
5. **Wave 5:** Piece 9 → 10. Piece 11 whenever the compat window closes.

The lead (Opus / you) owns the two contracts — `client-core/types/runtime.ts` (front-end port) and `@gleameet/shared` + the engine port (back-end seam). Keep both stable before each lane fans out, exactly as the SoW's parallel-agent model prescribes.

---

## Part E — Verification strategy (per wave)

- **Piece 1/2/3 (refactor):** the non-negotiable gate is **Chrome/Meet regression** — run a real Meet session through start → live prompt → pause → resume → end → report → history, plus `packages/backend` Jest suite. No behavior delta allowed. This is how R3 (keep Chrome working) is enforced.
- **Piece 4 (identity):** unit + integration — existing Google alias path still returns a session; a synthetic Zoom-provider request creates a linked identity with no Google row; deletion removes identity rows. Verify backfill idempotency on a copy of the schema.
- **Piece 5 (queue):** restart the backend mid-session and confirm queued prompts survive; hammer `/prompts/poll` to confirm idempotent, no-duplicate delivery.
- **Piece 6–8 (Zoom):** manual end-to-end in the **Zoom desktop client** — install the private app, run a real meeting, confirm private prompts render in-panel, lifecycle transitions fire, report + history load, and events land tagged `zoom_app`. Backend `/metrics` segmented by platform.
- **Piece 9:** side-by-side Meet vs Zoom on comparable meetings; confirm no over-triggering and Meet unchanged.

Backend has an existing Jest suite (`packages/backend/tests/*`) — extend it for identity, queue, and source-metadata changes rather than adding a new harness.

---

## Part F — Risks specific to this Zoom-first path

| # | Risk | Mitigation (where handled) |
|---|---|---|
| R1 | Zoom App cannot access real-time audio/transcript the way the extension did — **highest, and it gates the product shape** | Piece 0 spike resolves it *before* the shell; ship lower-fidelity MVP if needed (Piece 7); isolate behind `AudioCaptureProvider` |
| R2 | Identity migration breaks existing Chrome users | Additive `user_identities`, keep `google_subject_id` + `/auth/session` alias; drop only in Piece 11 |
| R3 | Refactor regresses the working Meet extension | Piece 2 is an explicit behavior-preserving regression gate before any Zoom work |
| R4 | Redis queue introduces duplicate prompts | Idempotent ack + safe dequeue in Piece 5a |
| R6 | Coaching over-triggers on weaker Zoom signals | Per-platform calibration in Piece 9 |
| — | Zoom Marketplace review latency | Sidestepped for first cut via **private/beta** distribution (Piece 10); public listing deferred |

---

## Open items for you to confirm before execution
1. **Capture fidelity for v1** — resolved by Piece 0's spike, but if you already know Zoom real-time transcript is out of reach, we can pre-commit the MVP to mic-only/lifecycle signals and skip part of the spike.
2. **Auth choice for Zoom** — Zoom OAuth vs. app-context/SSO; affects Piece 4's `zoom` provider and Piece 6 wiring.
3. Whether Pieces 5a/5b ship as one PR or two.
