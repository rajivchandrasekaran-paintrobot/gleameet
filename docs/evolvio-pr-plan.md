# Evolvio — PR-Based Implementation Plan with Subagent Orchestration

> **Model:** Sonnet 4.6 default, Opus for planning/review
> **Harness:** Everything Claude Code (ECC) with custom subagents
> **Each PR** = one branch, one reviewable unit, own exit criteria
> **Rule:** Chrome extension must stay green after every PR merge
> **Product name note:** The SoW uses "Evolvio"; the Zoom workplan uses "GleaMeet." Same product. This document uses "Evolvio" to match the SoW.

---

## Part 0 — Architecture & Codebase Baseline

> Sourced from the Zoom Conversion Workplan analysis. Read this before touching any code — it tells you what's reusable, what's coupled, and where the seams go.

### Target Architecture: Dual-Adapter (Hexagonal)

Two adapter seams with a frozen contract between them. The front-end UX and backend analysis engine develop in parallel without breaking each other:

```
Platform UX  (Meet / Zoom / Teams panel)
   ↕   platform adapter  — AuthProvider, MeetingPlatformAdapter, PromptSurface, AudioCaptureProvider
client-core  (session, batching, polling — platform-neutral)          ← FRONT-END ADAPTER
   ↕
====  @gleameet/shared : normalized event model + API types  ====      ← THE CONTRACT (already exists)
   ↕
Transport layer  (Express routes = thin HTTP → engine mapping)        ← BACK-END ADAPTER
   ↕   engine port — ingestEvents() / startSession() / endSession()
Analysis Engine Core  (feature-engine → law-evaluator → intervention-engine)   ← PURE CORE
   ↕   StateStore(Redis) · PersistencePort(Postgres) · LlmPort · PromptSink
```

**Three rules that make parallel development real:**
1. `packages/shared` is the contract / anti-corruption layer. Only the two adapters import it; neither side reaches past it.
2. A backend engine port decouples the analysis engine from transport/infra. Routes become thin transport adapters mapping HTTP → `AnalysisEngine.ingestEvents(session, events)`.
3. Contract tests are the enforcement mechanism. A shared suite asserts the wire shape; a drift breaks the test on whichever side moved, not in production.

### Codebase Analysis (Grounded in the Repo)

**Monorepo — 4 real packages today** (teams-app/zoom-app do NOT exist):
```
packages/shared        TS types, API contracts, constants    (reusable as-is, minor extension)
packages/law-registry  12 behavioral-law JSON defs           (unchanged)
packages/backend       Express API + pipeline                (reusable; needs identity + queue + source-metadata)
packages/extension     Chrome MV3 client                     (the coupled part; source of extraction)
```

**Extension file-by-file reusability assessment:**

| File | LOC | Contains | Reusable? |
|---|---|---|---|
| `utils/api-client.ts` | 161 | All backend HTTP calls | Logic yes, but bound to `chrome.storage`/`chrome.identity` at lines 14–40 — must be de-chromed |
| `background/service-worker.ts` | 618 | Session lifecycle, event batching, prompt polling, tab-audio orchestration | Logic yes (session/batch/poll); Chrome runtime plumbing no |
| `utils/event-factory.ts` | — | Normalized event creation | Yes — platform-neutral core |
| `utils/transcript-attribution.ts` | — | User-vs-other attribution | Yes — platform-neutral core |
| `popup/Popup.tsx` | 710 | Auth UI, status, history, report views | Screens yes, but too large/Chrome-specific; must be split |
| `content/content-script.ts` | 915 | Meet DOM speech/caption capture, overlay | Chrome/Meet-only — not reused by Zoom |
| `offscreen.ts` | — | MV3 mic + tab audio capture | Chrome-only — Zoom cannot use tabCapture/offscreen |
| `utils/platform.ts` | — | URL-based platform detection | Chrome-only — Zoom uses SDK context, not URL heuristics |

**Takeaway:** ~40% of the client (API/session/event/attribution logic + UI screens) is genuinely reusable; the capture and runtime layers are Chrome-specific and have no direct Zoom equivalent.

**Backend — close to reusable, three concrete gaps:**
- Auth is Google-only: `routes/auth.ts:14` — `POST /auth/session` takes `google_id_token` only
- Prompt queue is in-memory: `routes/prompts.ts:9` — `const pendingPrompts = new Map<...>()`
- Event source is coarse: `schema.sql:60` — `source CHECK IN ('extension','backend','adapter')`
- Pipeline itself (`feature-engine → law-evaluator → intervention-engine → rankAndSelectPrompt` at `intervention-engine.ts:28`) is platform-neutral and stays

**Shared model — already multi-platform, two hard-coded identity leaks:**
- `models.ts:43` — `Platform = 'google_meet' | 'teams' | 'zoom' | 'slack'` ✅
- `models.ts:4` — `User.google_subject_id` hard-coded
- `schema.sql:9` — `google_subject_id VARCHAR(255) UNIQUE NOT NULL` is the canonical identity key

### Zoom Desktop Reality Check

A Zoom App is NOT a browser extension. It runs as a sandboxed webview in the Zoom desktop client. This inverts the extension's most powerful capabilities:

- **No `tabCapture`, no offscreen document, no privileged `getUserMedia` on the meeting stream.** The extension's entire audio path (`offscreen.ts` → 10s WebM chunks → Whisper) does not port.
- **Real-time meeting audio/transcript is gated behind RTMS** (server-to-server, receive-only, paid Developer Pack, account-level enablement) or Meeting SDK raw data callbacks (native app, visible participant). Each has its own auth, scopes, and review implications.
- **`navigator.mediaDevices.getUserMedia({ audio: true })` may fail** inside the Zoom webview if Zoom already holds the mic device — this is a hardware exclusivity conflict, not a permissions issue.
- **Meeting context comes from the SDK, not the DOM:** `getMeetingContext`, `getRunningContext`, `getUserContext`, lifecycle events replace URL/DOM detection.
- **Prompts render in the Zoom app panel/sidebar**, not a DOM overlay.
- **Auth is Zoom OAuth / app-context via `zoomSdk.authorize()` with PKCE**, not `chrome.identity`.

**Capture decision tree (resolved by the spike, PR 0):**
- RTMS available → server-side capture, no client-side AudioCaptureProvider needed, full meeting audio including other participants for contextual features
- RTMS unavailable, mic works → client-side mic-only, degraded coaching (only user's voice)
- Both unavailable → lifecycle-only signals, minimal coaching, flag for upgrade

**Why other participants' audio matters (even though you only assess the user):**
Several of the 12 behavioral laws are fundamentally about interactions: interruption detection (needs to know when the user cut someone off), turn-taking / dominance patterns (needs both sides), responding to others' framing (loss-aversion language, present-bias cues someone else said), acknowledgment/clarifying-question detection (needs to know what was said to the user). Mic-only gives you zero visibility into any of this. However, per the product owner's direction, other participants' audio is processed **transiently** for context extraction only — no behavioral record, transcript, or analysis is stored for non-users. The product is a private behavioral mirror for the user only; meetings are the entry point for gathering behavioral intelligence, not the assessment of other participants.

### Risk-to-PR Mapping

| # | Risk | Handled in PR |
|---|---|---|
| R1 | Zoom App cannot access real-time audio/transcript — highest risk, gates product shape | PR 0 (spike), PR 13 (capture implementation) |
| R2 | Identity migration breaks existing Chrome users | PR 4 (additive identity), PR 17 (cleanup, late) |
| R3 | Refactor regresses the working Meet extension | PR 6 (regression gate — explicit behavior-preserving check) |
| R4 | Redis queue introduces duplicate prompts | PR 5 (idempotent ack + safe dequeue) |
| R5 | Prompt UX must move from overlay to panel-style | PR 7 (ui-app), PR 12 (Zoom prompt surface) |
| R6 | Coaching over-triggers on weaker Zoom signals | PR 14 (per-platform calibration) |
| R7 | Marketplace review latency | PR 16 (private/beta distribution sidesteps public review) |

### Parallel Development Lanes (Dual-Adapter Payoff)

The hexagonal architecture creates two independent lanes:

- **Front-end lane:** PR 2 (client-core) → PR 6 (chrome regression gate) → PR 7 (ui-app) → PRs 12–13 (Zoom). Teams (PRs 10–11) is Milestone 2, after Zoom ships.
- **Back-end lane:** PR 4 (identity) → PR 5 (queue+metadata) → PR 9 (engine port) → PR 9B (infra ports, optional)
- **Bridge:** PR 8 (contract tests + mock backend) lets the front-end lane develop/test against a mock while the back-end lane evolves. Freeze `@gleameet/shared` after PRs 4 + 5 land, then stand up the contract tests.

---

## Setup: Project-Level Subagents & CLAUDE.md

Before any PR work begins, create the subagent definitions and project config that every phase uses.

### CLAUDE.md (project root)

```markdown
# Evolvio — Meeting Coaching Platform

## Architecture
Monorepo with 11 packages. Build order: shared → law-registry → client-core → ui-app → platform-* → backend | extension | teams-app | zoom-app

## Hard Rules
- `packages/client-core` must NEVER import chrome.*, @microsoft/teams-js, or @zoom/appssdk
- `packages/ui-app` must NEVER import any platform-specific API
- All backend route changes must be backward-compatible with the shipping Chrome extension
- Every PR must pass: `npm run build && npm test` from root
- The Chrome extension must install and complete a full Meet session after every backend/shared change

## Package Dependency Graph
shared ← law-registry
shared ← client-core ← platform-chrome ← extension
shared ← client-core ← platform-teams-app ← teams-app
shared ← client-core ← platform-zoom-app ← zoom-app
shared ← client-core ← ui-app ← (extension | teams-app | zoom-app)
shared ← backend

## Subagent Delegation Rules
- Read-only research and analysis: delegate to @explore or @analyzer
- Code extraction/porting: delegate to @extractor
- New module creation: delegate to @implementer
- Test writing: delegate to @test-writer
- Cross-package validation: delegate to @contract-checker
- Never let a write-capable agent touch packages/extension without explicit instruction
```

### Custom Subagents — `.claude/agents/`

Create these 6 project-scoped subagent definitions:

```markdown
<!-- .claude/agents/extractor.md -->
---
name: extractor
description: Extracts and ports logic from one package to another while preserving behavior. Use when moving code from packages/extension into packages/client-core or packages/platform-chrome. Strips platform-specific imports and replaces with injected interfaces.
tools: Read, Write, Edit, Grep, Glob, Bash
model: sonnet
---
You are a code extraction specialist. Your job is to move logic from a source package to a target package while:
1. Preserving exact behavior — no feature changes, no refactors beyond what's needed for the port
2. Replacing platform-specific imports (chrome.*, @microsoft/teams-js, @zoom/appssdk) with dependency-injected interfaces from packages/client-core/src/types/runtime.ts
3. Never introducing new dependencies the target package shouldn't have
4. Leaving the source files untouched — extraction creates new files, it doesn't delete old ones yet

After extraction, run: grep -r "chrome\.\|@microsoft/teams-js\|@zoom/appssdk" <target-package>/src/
If anything is found, you have a bug. Fix it before returning.
```

```markdown
<!-- .claude/agents/implementer.md -->
---
name: implementer
description: Creates new modules, adapters, and platform integrations from interface contracts. Use when building new packages like zoom-app, teams-app, or new backend services like RTMS listener or Redis prompt queue.
tools: Read, Write, Edit, Bash, Grep, Glob
model: sonnet
---
You are a module implementer. You receive an interface contract and build a concrete implementation.

Rules:
1. Read the interface definition first. Every public method must be implemented.
2. Include comprehensive error handling — network failures, auth expiry, device conflicts, timeouts.
3. Add JSDoc comments on every exported function.
4. Do NOT import from packages you weren't told to depend on.
5. After creating files, run `npx tsc --noEmit` in the package directory to verify compilation.
6. Return a summary of: files created, interfaces implemented, dependencies added.
```

```markdown
<!-- .claude/agents/test-writer.md -->
---
name: test-writer
description: Writes unit and integration tests for newly created or modified modules. Use after code extraction or implementation to verify behavior. Focuses on edge cases, error paths, and backward compatibility.
tools: Read, Write, Edit, Bash, Grep, Glob
model: sonnet
---
You are a test specialist. For each module you're given:
1. Read the source and identify every public method and branch.
2. Write tests covering: happy path, error/rejection paths, edge cases (empty input, null, timeout).
3. For extracted code: write a backward-compatibility test proving the old call path still works.
4. Use the existing test framework (Jest) and follow existing test patterns in packages/backend/tests/.
5. Run the tests. If any fail, fix the test OR flag a real bug in the source (do not silently skip).
6. Return: test file paths, number of tests, pass/fail count.
```

```markdown
<!-- .claude/agents/contract-checker.md -->
---
name: contract-checker
description: Validates cross-package contracts and backward compatibility. Use after any change to packages/shared, packages/backend routes, or packages/client-core interfaces. Checks that no existing consumer is broken.
tools: Read, Grep, Glob, Bash
model: sonnet
---
You are a contract validation specialist. You check that changes to shared interfaces, API routes, or database schemas don't break existing consumers.

Checklist:
1. If packages/shared types changed: grep every package that imports from @gleameet/shared and verify compatibility.
2. If backend routes changed: verify the Chrome extension's existing API calls still work (check api-client.ts call sites).
3. If database schema changed: verify migrations are additive (no column drops, no constraint changes that break existing data).
4. If client-core interfaces changed: verify all implementations (platform-chrome, platform-teams-app, platform-zoom-app) still satisfy the contract.
5. Run `npx tsc --noEmit` across all packages.

Return: PASS/FAIL with specific breakages listed.
```

```markdown
<!-- .claude/agents/reviewer.md -->
---
name: reviewer
description: Reviews completed PR work for quality, security, and adherence to project rules. Use as the final step before marking a PR ready. Read-only — does not modify code.
tools: Read, Grep, Glob
model: sonnet
---
You are a senior code reviewer for the Evolvio project. Review with this priority order:

1. **Contract violations:** Does any package import something it shouldn't? (client-core importing chrome.*, ui-app importing platform code, etc.)
2. **Backward compatibility:** Will the existing Chrome extension break? Check every route change, shared type change, and database migration.
3. **Error handling:** Are network calls, auth flows, and device access wrapped in try/catch with meaningful fallbacks?
4. **Security:** No secrets in code, no raw SQL outside queries.ts, auth tokens handled correctly.
5. **Missing tests:** Flag any new public method without test coverage.

Output format:
- CRITICAL: [must fix before merge]
- WARNING: [should fix, acceptable to defer]
- NOTE: [style/improvement suggestion]
- VERDICT: APPROVE / REQUEST_CHANGES
```

```markdown
<!-- .claude/agents/migrator.md -->
---
name: migrator
description: Handles database migrations, schema changes, and data backfill scripts. Use for identity refactor, event metadata changes, and any schema.sql modifications. Ensures migrations are idempotent and backward-compatible.
tools: Read, Write, Edit, Bash, Grep, Glob
model: sonnet
---
You are a database migration specialist working with PostgreSQL.

Rules:
1. Every migration must be idempotent — running it twice must not error.
2. Use IF NOT EXISTS for CREATE TABLE, ADD COLUMN IF NOT EXISTS for ALTER TABLE.
3. Never DROP a column that existing code still references — add new columns alongside old ones.
4. Include a backfill query when adding columns that should be populated from existing data.
5. Test the migration against the current schema by running it in a transaction with ROLLBACK.
6. Name migrations sequentially: migrations/NNN_description.sql
7. Return: migration file path, tables affected, backward-compatibility assessment.
```

---

## PR 0: Zoom Capture Spike + Capability Matrix

**Branch:** `spike/zoom-capture`
**Depends on:** Nothing
**Risk:** None — throwaway spike code, only the decision doc persists
**Type:** Research spike — the doc is the durable artifact; code is disposable.
**Time-box:** 1–2 days maximum. Do NOT let this expand into a full investigation phase.

### Why This Goes First

Unlike the Meet extension (which had privileged capture before you designed anything), the Zoom App gives you no guaranteed capture path. The answer to "what real-time signal can this app actually get?" changes the shape of the `MeetingPlatformAdapter`, the `AudioCaptureProvider`, whether Whisper stays in the loop, and even which OAuth scopes you request (which drives marketplace review later). Building the full shell blind risks a large rework.

**This reorders the SoW: Zoom leads the critical path (not Teams), and this spike gates the shell.**

### Orchestrator Prompt

```
This is a throwaway spike. Code quality doesn't matter — we're testing feasibility, not
building production code. The ONLY durable output is docs/zoom-capability-matrix.md.

Step 1: Stand up a minimal Zoom App that loads in the Zoom desktop client:
- Create a minimal React app with zoomSdk.config()
- Register it as a development Zoom App
- Confirm it loads in the Zoom desktop client

Step 2: Probe 3 capture paths IN THIS ORDER:

Path A — RTMS (best case):
- Check: Is RTMS enabled on the target Zoom account? (Admin Portal → App Marketplace)
- Check: Is Zoom Developer Pack active? What tier?
- If yes: register for meeting.rtms_started webhook, confirm it fires during a meeting
- If yes: attempt WebSocket connection for audio/transcript
- Record: latency, data format, speaker attribution quality

Path B — Mic-in-webview (fallback):
- During a LIVE Zoom meeting in the desktop client, run this in the app's webview:
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(s => { const t = s.getAudioTracks()[0]; console.log(t.label, t.readyState); })
    .catch(e => console.error(e.name, e.message));
- Record: does it return 'live', 'ended', NotReadableError, or undefined?
- If 'live': test with MediaRecorder, confirm audio chunks contain actual data
- Test the DEVICE CONFLICT case: does it work while Zoom holds the mic for the call?

Path C — Lifecycle-only (minimum viable):
- Confirm: getMeetingContext(), getRunningContext(), getUserContext() return data
- Confirm: lifecycle events (onMeeting, onMyUserContextChange) fire
- This path always works but gives minimal coaching signal

Step 3: Write docs/zoom-capability-matrix.md with:
- RTMS: available / not available / pending sales conversation
- Mic-in-webview: works / fails (with specific error) / untested
- Chosen capture path for MVP and rationale
- Required OAuth scopes for the chosen path
- Impact on AudioCaptureProvider interface:
  - RTMS → capture is a BACKEND component, not client-side
  - Mic → client-side AudioCaptureProvider
  - Lifecycle-only → no capture provider needed
- Which of the 12 behavioral laws will have signal vs. be degraded
- Background-polling allowance in the Zoom webview
```

### Three Prerequisites for the RTMS Path

If the spike picks RTMS, these are hard blockers — check them before writing capture code:

1. **RTMS is a paid, sales-gated feature** — part of Zoom's Developer Pack with no public pricing. If nobody's talked to Zoom sales, the spike literally cannot test RTMS.
2. **Account-level enablement, not per-participant.** If the coached user joins meetings hosted by other orgs, RTMS won't be available for those meetings unless the host's org has it enabled. Check whether the usage model is "coach me in my meetings" vs. "coach me anywhere."
3. **RTMS activation is a visible consent moment** for other participants. Good for compliance, but needs deliberate UX design.

### Exit Criteria
- [ ] `docs/zoom-capability-matrix.md` committed with all fields filled
- [ ] At least one signal path proven end-to-end into `POST /events/batch`
- [ ] Capture decision recorded: RTMS / mic-only / lifecycle-only
- [ ] If RTMS: confirm PR 13 is a backend component, not a client-side AudioCaptureProvider
- [ ] If mic-only: document which laws are degraded and flag for calibration in PR 14
- [ ] Spike code deleted or moved to a throwaway branch (not merged to main)

### Does NOT Block
PRs 1–5, 7–9 (foundation refactor) can start in parallel. Only PRs 12, 13 (Zoom shell + capture) depend on this spike's decision.

---

## PR 1: Repository Scaffolding & Interface Contracts

**Branch:** `chore/monorepo-scaffold`
**Depends on:** Nothing
**Risk:** None — no existing code modified

### Orchestrator Prompt

```
We're scaffolding the Evolvio monorepo for platform conversion. No existing code will be
modified. We need to add 7 new workspace packages and define the shared interface contracts.

Step 1: Use @implementer to create skeleton package.json + tsconfig.json for each new package:
- packages/client-core (pure TS, no browser deps)
- packages/ui-app (React)
- packages/platform-chrome (depends on client-core)
- packages/platform-teams-app (depends on client-core, @microsoft/teams-js)
- packages/platform-zoom-app (depends on client-core, @zoom/appssdk)
- packages/teams-app (depends on client-core, ui-app, platform-teams-app; Vite)
- packages/zoom-app (depends on client-core, ui-app, platform-zoom-app; Vite)

Step 2: Use @implementer to create packages/client-core/src/types/runtime.ts with these
interface contracts:
- AuthProvider: signInInteractive(), signInSilent(), refreshSession(), signOut?()
- StorageProvider: get(key), set(key, value), remove(key)
- MeetingPlatformAdapter: detectMeeting(), subscribeMeetingLifecycle(cb), subscribeSignals(cb), startCapture(ctx), stopCapture()
- PromptSurface: showPrompt(prompt), dismissPrompt(id), setMuted(muted)
- AudioCaptureProvider: startMicCapture(), startSystemCapture(), stopAllCapture()
- RuntimeMessenger: send(msg), onMessage(cb), removeListener(cb)

Step 3: Update root package.json workspaces array to include all 11 packages.

Step 4: Run npm install and npx tsc --noEmit in client-core to verify.

Step 5: Use @contract-checker to verify no existing package is broken.
```

### Subagent Delegation

| Agent | Task | Parallel? |
|---|---|---|
| @implementer | Create 7 package skeletons | Yes — fan out, one per package |
| @implementer | Create runtime.ts interfaces | After skeletons |
| @contract-checker | Verify existing packages unaffected | After all creation |

### Exit Criteria
- [ ] `npm install` clean from root
- [ ] `npx tsc --noEmit` passes in client-core
- [ ] All 11 packages in root workspaces
- [ ] runtime.ts has all 6 interfaces
- [ ] Zero changes to existing source files

---

## PR 1B: CI Guardrails

**Branch:** `chore/ci-guardrails`
**Depends on:** PR 1
**Risk:** None
**Why it exists:** With 12+ PRs and a "Chrome must stay green" rule, the guardrails must fire automatically on every PR — not when a human remembers. This makes the plan's own hard rules machine-enforced.

### Orchestrator Prompt

```
Create a GitHub Actions workflow that runs on every PR:

Step 1: Use @implementer to create .github/workflows/pr-checks.yml:
- Job 1: npm install + npm run build (all workspaces, in dependency order)
- Job 2: npm test (backend Jest suite + any package tests)
- Job 3: Import-violation guard — fail the build if this returns anything:
  grep -r "chrome\.\|@microsoft/teams-js\|@zoom/appssdk" packages/client-core/src/ packages/ui-app/src/ 2>/dev/null
- Job 4 (added after PR 8 lands): contract tests against the mock backend

Step 2: Add a root npm script "guard:imports" wrapping the grep so it's runnable locally
and referenced by the CI job (single source of truth).

Step 3: Use @reviewer to verify the workflow fails correctly — introduce a deliberate
chrome.* import in client-core on a scratch branch and confirm CI goes red.
```

### Exit Criteria
- [ ] CI runs build + test + import guard on every PR
- [ ] A deliberate violation makes CI fail (tested)
- [ ] `npm run guard:imports` works locally

---

## PR 2: Client-Core Extraction — Session, API, Events & Prompts

> **Merged scope:** This PR now absorbs the former PR 3. Both halves are pure extraction into the same new package with no consumers yet — separate PRs added review overhead and a second ECC session re-reading the same contracts for no isolation benefit. Execute as two commit series on one branch.

**Branch:** `refactor/client-core`
**Depends on:** PRs 1, 1B
**Risk:** Low — new files only, extension untouched

### Orchestrator Prompt

```
Extract platform-neutral session management and API gateway logic from the Chrome extension
into packages/client-core. The extension source files are READ-ONLY in this step — we create
new files in client-core, we don't modify the extension yet.

Step 1: Use @extractor to read packages/extension/src/utils/api-client.ts and extract the
API call logic into packages/client-core/src/api/gateway-client.ts. Replace every chrome.storage
call with StorageProvider injection and every chrome.identity call with AuthProvider injection.

Step 2: Use @extractor to read packages/extension/src/background/service-worker.ts and
extract session state machine logic into packages/client-core/src/session-manager.ts.
Constructor takes GatewayClient + MeetingPlatformAdapter + PromptSurface.

Step 3: Use @extractor to port these modules (likely near-verbatim if already platform-neutral):
- event-factory.ts → client-core/src/events/event-factory.ts
- transcript-attribution.ts → client-core/src/transcript/transcript-attribution.ts

Step 4: Use @implementer to create two new modules:
- client-core/src/events/batch-flusher.ts (configurable interval, max batch size, retry with backoff)
- client-core/src/prompts/prompt-poller.ts (configurable poll interval, routes to PromptSurface)

Step 5: Use @test-writer to write unit tests for session-manager and gateway-client.

Step 6: Use @contract-checker — grep for any chrome.* in packages/client-core/src/. Must be zero.
```

### Subagent Delegation

| Agent | Task | Parallel? |
|---|---|---|
| @extractor | gateway-client.ts extraction | Yes |
| @extractor | session-manager.ts extraction | Yes |
| @extractor | event-factory.ts + transcript-attribution.ts | Yes |
| @implementer | batch-flusher.ts + prompt-poller.ts | After extractors (needs gateway-client types) |
| @test-writer | Tests for session-manager, gateway-client | After implementer |
| @contract-checker | Zero chrome.* check | Final |

### Exit Criteria
- [ ] `grep -r "chrome\." packages/client-core/src/` returns nothing
- [ ] All modules compile: `npx tsc --noEmit` in client-core
- [ ] Unit tests pass for session-manager and gateway-client
- [ ] Extension source files are UNCHANGED (diff shows zero modifications to packages/extension/)

---

## PR 2 (continued): Event Pipeline & Prompt Polling — second commit series

> Formerly PR 3. Same branch (`refactor/client-core`), executed after the session/API extraction above. Kept as a separate orchestrator session for context hygiene, but merged into one reviewable PR.

**Branch:** `refactor/client-core` (same branch)
**Depends on:** PR 2 first commit series
**Risk:** Low — new files only

### Orchestrator Prompt

```
Continue client-core extraction. This PR finishes the event and prompt pipeline modules.

Step 1: Use @extractor to read the event batching logic from service-worker.ts and verify
batch-flusher.ts (created in PR 2) covers all the batching behavior. If gaps exist, update
batch-flusher.ts.

Step 2: Use @extractor to read the prompt polling/ack logic from service-worker.ts and verify
prompt-poller.ts covers all the polling behavior. Ensure:
- Configurable poll interval (default 3s)
- Calls PromptSurface.showPrompt() on receipt
- Calls GatewayClient.ackPrompt() after display
- Handles poll failures gracefully (log, retry, don't crash)

Step 3: Use @implementer to create packages/client-core/src/index.ts that re-exports all
public modules: SessionManager, GatewayClient, EventFactory, BatchFlusher, PromptPoller,
TranscriptAttribution, and all interfaces from types/runtime.ts.

Step 4: Use @test-writer to add tests for batch-flusher (flush on interval, flush on size,
retry on failure) and prompt-poller (poll cycle, ack after display, error handling).

Step 5: Use @reviewer to review the complete client-core package.
```

### Subagent Delegation

| Agent | Task | Parallel? |
|---|---|---|
| @extractor | Verify/complete batch-flusher | Yes |
| @extractor | Verify/complete prompt-poller | Yes |
| @implementer | Create index.ts barrel export | After extractors |
| @test-writer | Tests for batch-flusher + prompt-poller | After implementer |
| @reviewer | Full client-core package review | Final |

### Exit Criteria
- [ ] client-core builds standalone
- [ ] All tests pass
- [ ] Zero platform-specific imports
- [ ] index.ts re-exports everything consumers need
- [ ] @reviewer returns APPROVE

---

## PR 4: Backend Identity Refactor

**Branch:** `feat/identity-provider-model`
**Depends on:** PR 1 (shared types only)
**Parallel-safe with:** PRs 2, 3, 5

### Orchestrator Prompt

```
Refactor the backend identity system from Google-only to provider-aware. The existing
Chrome extension must continue working identically — POST /auth/session stays as a Google alias.

Step 1: Use @migrator to create migrations/002_user_identities.sql:
- CREATE TABLE user_identities (identity_id, user_id FK CASCADE, provider, provider_subject_id, email, display_name, created_at, UNIQUE(provider, provider_subject_id))
- Backfill from existing users WHERE google_subject_id IS NOT NULL
- Do NOT drop google_subject_id

Step 2: Use @implementer to create the auth provider layer — 4 files:
- backend/src/auth/types.ts (IdentityProvider union, AuthResult interface)
- backend/src/auth/providers/google.ts (extract from current auth.ts)
- backend/src/auth/providers/microsoft.ts (stub — validates Entra ID tokens, returns TODO)
- backend/src/auth/providers/zoom.ts (stub — validates Zoom OAuth, returns TODO)

Step 3: Use @implementer to create backend/src/auth/identity-service.ts:
- authenticateWithProvider(provider, token)
- upsertUserIdentity(provider, providerSubjectId, email, displayName)
- getUserByIdentity(provider, providerSubjectId)
- linkIdentityToUser(userId, provider, ...)
- createUserWithIdentity(provider, ...)

Step 4: Use @implementer to update routes/auth.ts:
- Keep POST /auth/session EXACTLY as-is (Google alias, backward compat)
- Add POST /auth/session/google (same logic, explicit)
- Add POST /auth/session/zoom (uses zoom provider)
- Add POST /auth/session/microsoft (uses microsoft provider)

Step 5: Use @implementer to update db/queries.ts — add identity-aware functions ALONGSIDE
existing ones (do NOT remove getUserByGoogleSubject yet).

Step 6: Use @test-writer to write tests:
- Existing Google flow still works via /auth/session
- New Google flow works via /auth/session/google
- Zoom/Microsoft stubs return appropriate error until implemented
- Migration is idempotent (run twice without error)
- User deletion cascades to identity records

Step 7: Use @contract-checker to verify:
- POST /auth/session still accepts google_id_token and returns same response shape
- All existing Jest tests pass
```

### Subagent Delegation

| Agent | Task | Parallel? |
|---|---|---|
| @migrator | Migration SQL | First |
| @implementer | auth types + providers | After migration |
| @implementer | identity-service.ts | After types |
| @implementer | Route updates + query updates | After identity-service |
| @test-writer | Identity tests | After implementation |
| @contract-checker | Backward compat verification | Final |

### Exit Criteria
- [ ] `POST /auth/session` with `google_id_token` works identically
- [ ] `user_identities` table created and backfilled
- [ ] Migration is idempotent
- [ ] All existing Jest tests pass
- [ ] New provider routes exist

---

## PR 5: Redis Prompt Queue + Event Source Metadata

**Branch:** `feat/redis-prompt-queue`
**Depends on:** PR 1
**Parallel-safe with:** PRs 2, 3, 4

### Orchestrator Prompt

```
Two tightly-related backend changes in one PR: replace the in-memory prompt queue with
Redis, and extend event/session schemas for cross-platform source tracking.

PART A — Redis Queue:
Step 1: Use @implementer to create backend/src/services/prompt-queue.ts:
- enqueue(userId, sessionId, prompt) → RPUSH to Redis list
- poll(userId, sessionId) → LRANGE + LTRIM (atomic drain)
- ack(userId, sessionId, promptId) → SADD to acked set (idempotent)
- isAcked(sessionId, promptId) → SISMEMBER
- TTL 24h on all keys

Step 2: Use @implementer to update routes/prompts.ts:
- Remove the pendingPrompts Map entirely
- Wire poll/ack to PromptQueue methods
- Update wherever enqueuePendingPrompt is called (intervention engine)

PART B — Source Metadata:
Step 3: Use @migrator to create migrations/003_source_metadata.sql:
- Add client_version, client_type, runtime_type to meeting_sessions
- Add platform_meeting_id VARCHAR(255) to meeting_sessions (nullable) — the platform's own
  meeting identifier (e.g. Zoom meeting UUID). This is the JOIN KEY that lets the RTMS
  listener (PR 13) correlate a server-side media stream with the client-side session.
  Adding it here, not in PR 13, avoids a late-stage migration blocking capture work.
- Add source_runtime, source_channel to raw_events
- Do NOT drop extension_version or modify source CHECK

Step 4: Use @implementer to update packages/shared types:
- Add ClientType, RuntimeType, SourceRuntime, SourceChannel unions
- Add optional fields to RawEvent, MeetingSession, MeetingStartRequest
- Keep extension_version optional for backward compat

Step 5: Use @implementer to update routes/meetings.ts and routes/events.ts to accept new fields.

Step 6: Use @test-writer for both parts:
- Queue: enqueue → poll returns prompt; ack is idempotent; restart survives
- Metadata: old-format requests still work; new fields persist

Step 7: Use @contract-checker — Chrome extension posting old field names still works.
```

### Subagent Delegation

| Agent | Task | Parallel? |
|---|---|---|
| @implementer | prompt-queue.ts | Yes — Part A |
| @migrator | migrations/003 | Yes — Part B |
| @implementer | Update prompts.ts routes | After queue |
| @implementer | Update shared types | After migration |
| @implementer | Update meeting/event routes | After shared types |
| @test-writer | Queue tests + metadata tests | After all implementation |
| @contract-checker | Backward compat | Final |

### Exit Criteria
- [ ] `pendingPrompts` Map is gone
- [ ] Queue survives backend restart
- [ ] Idempotent ack (200 on repeated calls)
- [ ] Old-format Chrome requests still work
- [ ] All existing tests pass

---

## PR 6: Chrome Platform Adapter + Extension Rebind

**Branch:** `refactor/platform-chrome`
**Depends on:** PRs 2, 3 (client-core complete)
**Risk:** HIGH — this is the regression gate

### Orchestrator Prompt

```
⚠️ THIS IS THE CRITICAL PR. The Chrome extension must work IDENTICALLY after this change.

Create packages/platform-chrome with Chrome-specific implementations of the client-core
interfaces, then rewire the extension to use client-core + platform-chrome.

Step 1: Use @implementer to create 6 adapter files in packages/platform-chrome/src/:
- chrome-auth-provider.ts → AuthProvider via chrome.identity
- chrome-storage-provider.ts → StorageProvider via chrome.storage.local
- chrome-meeting-adapter.ts → MeetingPlatformAdapter via DOM detection (port from platform.ts + content-script.ts)
- chrome-audio-provider.ts → AudioCaptureProvider wrapping offscreen.ts / tabCapture
- chrome-prompt-surface.ts → PromptSurface via DOM overlay injection
- chrome-messenger.ts → RuntimeMessenger via chrome.runtime
Create a factory: createChromeRuntime() that wires all 6 together.

Step 2: Use @extractor to update packages/extension/src/background/service-worker.ts:
- Import createChromeRuntime() from platform-chrome
- Import SessionManager, BatchFlusher, PromptPoller from client-core
- Wire them together
- service-worker.ts becomes bootstrap/wiring ONLY
- Remove duplicated logic that now lives in client-core

Step 3: Use @test-writer to write integration tests verifying:
- createChromeRuntime() returns all required interfaces
- SessionManager initializes with Chrome adapters without error
- Event flow: Chrome adapter → EventFactory → BatchFlusher → GatewayClient

Step 4: MANUAL VERIFICATION (not automated — the orchestrator must instruct the human):
- Install the rebuilt extension in Chrome
- Join a Google Meet call
- Verify: start session → prompts appear → pause → resume → end → view report → view history
- Every step must work identically to the pre-refactor extension

Step 5: Use @reviewer to do a full review of the complete PR diff. Priority: any behavior change
is a bug, not a feature.
```

### Subagent Delegation

| Agent | Task | Parallel? |
|---|---|---|
| @implementer | 6 Chrome adapter files (fan out 3 parallel subagents, 2 files each) | Yes |
| @implementer | createChromeRuntime() factory | After adapters |
| @extractor | Rewire service-worker.ts | After factory |
| @test-writer | Integration tests | After rewire |
| @reviewer | Full PR review | Final, before manual test |

### Exit Criteria
- [ ] Chrome extension installs in Chrome without errors
- [ ] Full Meet lifecycle: start → prompts → pause → resume → end → report → history
- [ ] `packages/extension/src/` has minimal direct chrome.* (only in bootstrap)
- [ ] All logic flows through client-core → platform-chrome
- [ ] @reviewer returns APPROVE
- [ ] **Manual regression test passes** — no behavior delta

---

## PR 7: Shared UI Extraction

**Branch:** `refactor/ui-app`
**Depends on:** PR 2 (client-core types needed for hooks)
**Parallel-safe with:** PRs 4, 5, 6

### Orchestrator Prompt

```
Split the 710-line Popup.tsx into reusable, platform-neutral React screens in packages/ui-app.

Step 1: Use @extractor to read packages/extension/src/popup/Popup.tsx and identify:
- Distinct screen states (auth, live coaching, history, transcript, report)
- Shared components (prompt card, meeting status badge)
- State management patterns that should become hooks

Step 2: Use @implementer to create shared hooks:
- ui-app/src/hooks/useSessionState.ts — takes SessionManager, returns { state, meeting, prompts, ... }

Step 3: Use @implementer to create screens (fan out — one subagent per screen):
- screens/AuthScreen.tsx
- screens/LiveCoachingScreen.tsx
- screens/HistoryScreen.tsx
- screens/TranscriptScreen.tsx
- screens/ReportScreen.tsx

RESPONSIVE REQUIREMENT: Every screen must work at ~360px width. The Zoom mobile client
renders apps in a phone-width sheet, and the desktop panel is narrow too. Design
mobile-first now — retrofitting responsiveness after PR 12 ships is far more expensive.
No fixed widths, no hover-only interactions, PromptCard must be readable at 360px.

Step 4: Use @implementer to create shared components:
- components/PromptCard.tsx
- components/MeetingStatusBadge.tsx

Step 5: Use @contract-checker — grep for chrome.* in packages/ui-app/src/. Must be zero.

Step 6: After PR 6 merges, update packages/extension/src/popup/Popup.tsx to mount screens
from ui-app instead of inline rendering. (This step can be a follow-up commit on the PR.)
```

### Subagent Delegation

| Agent | Task | Parallel? |
|---|---|---|
| @extractor | Analyze Popup.tsx structure | First |
| @implementer | useSessionState hook | After analysis |
| @implementer × 5 | One screen each (fan out parallel) | After hook |
| @implementer | PromptCard + MeetingStatusBadge | Parallel with screens |
| @contract-checker | Zero platform imports | Final |

### Exit Criteria
- [ ] ui-app builds standalone
- [ ] Zero chrome.* / platform imports
- [ ] Every screen is a self-contained React component accepting props
- [ ] If PR 6 has merged: Chrome popup renders identically from shared screens

---

## PR 8: Contract Tests & Mock Backend

**Branch:** `test/contract-suite`
**Depends on:** PRs 4, 5 (shared types finalized)
**Parallel-safe with:** PRs 6, 7

### Orchestrator Prompt

```
Create a contract test suite and mock backend so Teams and Zoom apps can develop against
the mock while the real backend continues to evolve.

ARCHITECTURE RULE: packages/shared stays a PURE contract layer — types only, no Express,
no runtime dependencies. The mock backend gets its own workspace package so shared's
anti-corruption-layer role is preserved.

Step 1: Use @implementer to create packages/mock-backend/ as a new workspace package:
- packages/mock-backend/src/mock-server.ts — Express app implementing all routes from
  the SoW §6.3 endpoint table
- In-memory state: users, sessions, prompts, history, reports
- Supports all three auth providers (returns mock tokens)
- Serves realistic prompt and report data
- Depends on @gleameet/shared for types; nothing depends on it except tests
- Register in root package.json workspaces

Step 2: Use @test-writer to create packages/mock-backend/contract-tests/:
- auth.contract.test.ts — all 4 auth endpoints
- meetings.contract.test.ts — start, end, with new and old field names
- events.contract.test.ts — batch with source_runtime/source_channel
- prompts.contract.test.ts — poll, ack (idempotent), queue survival
- history.contract.test.ts — list, transcript, report shapes

Step 3: Wire contract tests to run against both targets:
- npm run test:contract:mock → tests against mock-server
- npm run test:contract:real → tests against real backend with test DB

Step 4: Use @contract-checker to verify both pass.
```

### Subagent Delegation

| Agent | Task | Parallel? |
|---|---|---|
| @implementer | Mock server | First |
| @test-writer × 5 | One contract test file each (fan out) | After mock server |
| @contract-checker | Run both suites | Final |

### Exit Criteria
- [ ] Mock backend serves all routes
- [ ] Contract tests pass against mock
- [ ] Contract tests pass against real backend
- [ ] npm scripts registered in root package.json

---

## PR 9: Backend Engine Port

**Branch:** `refactor/backend-engine-port`
**Depends on:** PR 5 (Redis queue for PromptSink)
**Parallel-safe with:** PRs 6, 7, 8
**Optional but strongly recommended if RTMS is the capture path**

### Orchestrator Prompt

```
Extract the coaching pipeline behind a port interface so it can be called from both
HTTP routes AND the RTMS listener (server-side capture) without going through Express.

Step 1: Use @implementer to create backend/src/engine/engine-port.ts:
interface AnalysisEngine {
  startSession(session: SessionContext): Promise<void>;
  ingestEvents(session: SessionContext, events: NormalizedEvent[]): Promise<PromptDecision[]>;
  endSession(session: SessionContext): Promise<Report>;
}
interface PromptSink {
  emit(userId: string, sessionId: string, prompt: Prompt): Promise<void>;
}

Step 2: Use @extractor to create backend/src/engine/analysis-engine.ts:
- Wraps the existing feature-engine → law-evaluator → intervention-engine pipeline
- Takes PromptSink (implemented by Redis PromptQueue from PR 5)
- No Express, no req/res objects — pure business logic

Step 3: Use @extractor to update route handlers (events.ts, meetings.ts):
- Routes call AnalysisEngine methods instead of reaching into pipeline internals
- Routes become thin transport adapters: HTTP → engine port

Step 4: Use @test-writer to verify:
- Engine produces same prompt decisions when called directly (no HTTP)
- All existing Jest tests still pass (routes unchanged from consumer's perspective)

Step 5: Use @reviewer to verify routes are genuinely thin — no business logic left in handlers.
```

### Subagent Delegation

| Agent | Task | Parallel? |
|---|---|---|
| @implementer | Engine port interface | First |
| @extractor | analysis-engine.ts wrapping pipeline | After interface |
| @extractor | Update route handlers | After engine |
| @test-writer | Direct-call tests + regression | After routes |
| @reviewer | Verify routes are thin | Final |

### Exit Criteria
- [ ] AnalysisEngine callable without HTTP
- [ ] Routes only call engine port methods
- [ ] All existing tests pass
- [ ] RTMS listener (PR 13) can call engine.ingestEvents() directly

---

## PR 9B: Engine Infra Ports — StateStore / LlmPort / PersistencePort (OPTIONAL)

**Branch:** `refactor/backend-ports`
**Depends on:** PR 9 (engine port)
**Optional:** Skip for the first cut if time-boxed. PR 9 alone delivers the decoupling; this is hardening. Primarily valuable if you plan to swap Redis/Postgres/LLM providers or want full unit-test isolation of the coaching engine.

### Orchestrator Prompt

```
Abstract the engine's Redis state, Postgres persistence, and LLM access behind interfaces
injected into the engine core. Current Redis/Postgres/OpenAI implementations become the
default adapters. This lets coaching logic be tested with in-memory fakes and infra be
swapped without touching the core.

Step 1: Use @implementer to define 3 port interfaces in backend/src/engine/ports/:
- StateStore: get/set/delete session state (currently direct Redis calls)
- PersistencePort: insert/query events, sessions, reports (currently direct Postgres pool calls)
- LlmPort: generate completion (currently direct OpenAI calls)

Step 2: Use @extractor to move current Redis/Postgres/OpenAI usage out of the engine
core into adapter implementations:
- backend/src/engine/adapters/redis-state-store.ts
- backend/src/engine/adapters/postgres-persistence.ts
- backend/src/engine/adapters/openai-llm.ts

Step 3: Use @implementer to create in-memory fakes for testing:
- backend/src/engine/adapters/memory-state-store.ts
- backend/src/engine/adapters/memory-persistence.ts
- backend/src/engine/adapters/stub-llm.ts

Step 4: Use @test-writer to verify:
- Engine core has ZERO direct redis/pool/OpenAI imports
- Unit tests run with in-memory fakes and produce same prompt decisions
- All existing Jest tests still pass (real adapters unchanged)

Step 5: Use @reviewer to verify the engine core is genuinely infra-agnostic.
```

### Exit Criteria
- [ ] Engine core has zero direct `redis`/`pool`/`openai` imports
- [ ] Unit tests run entirely with in-memory fakes
- [ ] All existing Jest tests pass with real adapters
- [ ] Adapters are swappable via constructor injection

---

# ═══ MILESTONE 2 — TEAMS (DEFERRED) ═══

> **Sequencing decision (per the Zoom workplan): Zoom leads the critical path; Teams is the second cut.** PRs 10–11 are fully specified below so the second milestone starts without re-planning, but they do NOT run in Week 3 of Milestone 1. They reuse client-core, ui-app, the identity model, and the Redis queue unchanged — which is the whole point of doing the extraction first. Execute them, as one merged PR on one branch, only after PR 16 (Zoom private distribution) ships.
>
> The one Milestone-1 task Teams still owns: PR 4 creates the `microsoft.ts` provider **stub** so the auth architecture is provider-complete from day one.

## PR 10: Teams App Shell — Auth & Lifecycle [MILESTONE 2]

**Branch:** `feat/teams-app` (shared with PR 11 — one merged PR)
**Depends on:** PRs 2, 4, 7 (client-core + identity + ui-app) and Milestone 1 complete

### Orchestrator Prompt

```
Build the Microsoft Teams app — auth, meeting lifecycle, and prompt panel.

Step 1: Use @implementer to create platform adapters in packages/platform-teams-app/src/:
- teams-auth-provider.ts → AuthProvider via microsoftTeams.authentication.getAuthToken()
- teams-storage-provider.ts → StorageProvider via localStorage
- teams-meeting-adapter.ts → MeetingPlatformAdapter via microsoftTeams.meeting.*
- teams-prompt-surface.ts → PromptSurface rendering in side panel
- teams-context.ts → wraps microsoftTeams.app.getContext()

Step 2: Use @implementer to create the app shell in packages/teams-app/src/:
- index.tsx — entry point, Teams SDK init
- app/TeamsApp.tsx — wires platform adapters to client-core, mounts ui-app screens
- Vite build config (vite.config.ts)
- public/manifest.json — Teams app manifest with side panel config

Step 3: Wire the full lifecycle:
- Teams meeting start → SessionManager.startSession() with client_type: 'teams_app'
- BatchFlusher tags events with source_runtime: 'teams_app', source_channel: 'sdk_context'
- PromptPoller → PromptSurface → PromptCard in side panel
- History + Report screens fetch from GatewayClient

Step 4: Use @test-writer to write tests for each platform adapter.

Step 5: Use @contract-checker to verify:
- teams-app has NO chrome.* imports
- All events reach the backend with correct source metadata
```

### Subagent Delegation

| Agent | Task | Parallel? |
|---|---|---|
| @implementer × 5 | One adapter file each (fan out) | Yes |
| @implementer | TeamsApp.tsx + Vite config + manifest | After adapters |
| @implementer | Full lifecycle wiring | After shell |
| @test-writer | Adapter tests | After wiring |
| @contract-checker | Import validation | Final |

### Exit Criteria
- [ ] Teams app builds with Vite
- [ ] Loads in Teams desktop client (dev sideload)
- [ ] SSO retrieves token
- [ ] Meeting context detected during a meeting
- [ ] Prompts render in side panel

---

## PR 11: Teams App — Full Lifecycle & Polish [MILESTONE 2 — same branch as PR 10]

**Branch:** `feat/teams-app` (second commit series on PR 10's branch — one merged PR)
**Depends on:** PR 10 commit series

### Orchestrator Prompt

```
Complete the Teams app: full meeting lifecycle end-to-end, history, reports, and prompt ack.

Step 1: Use @implementer to wire remaining lifecycle events:
- Pause/resume detection from Teams SDK meeting events
- End-of-meeting trigger → SessionManager.endSession()
- Session metadata: client_type, runtime_type, client_version

Step 2: Use @implementer to wire post-meeting flows:
- ReportScreen fetches from GatewayClient.fetchReport()
- HistoryScreen fetches from GatewayClient.fetchHistory()
- TranscriptScreen fetches from GatewayClient.fetchTranscript()

Step 3: Use @test-writer for end-to-end integration tests against mock backend.

Step 4: MANUAL VERIFICATION:
- Join a real Teams meeting with the sideloaded app
- Start session → prompts appear → pause → resume → end → report → history
- Verify events in backend are tagged source_runtime: 'teams_app'
```

### Exit Criteria
- [ ] Full lifecycle works in Teams desktop client
- [ ] Report + history viewable in panel
- [ ] Events land in backend with correct source tags
- [ ] Manual test passes

---

# ═══ MILESTONE 1 CONTINUES — ZOOM (THE FIRST CUT) ═══

## PR 12: Zoom App Shell — Auth & Lifecycle

**Branch:** `feat/zoom-app-shell`
**Depends on:** PRs 2, 4, 7 (client-core + identity + ui-app) + PR 0's capture decision
**This is the Milestone 1 centerpiece — the convergence point of both lanes.**

### Orchestrator Prompt

```
Build the Zoom app — auth, meeting lifecycle, and prompt panel. Refer to
docs/zoom-capability-matrix.md for the capture decision.

CRITICAL CONSTRAINTS:
- No tabCapture, no offscreen document, no privileged getUserMedia on meeting audio
- Meeting context from zoomSdk, not DOM
- Auth via zoomSdk.authorize() with PKCE
- localStorage unreliable in Zoom webview — use in-memory storage

Step 1: Use @implementer to create platform adapters in packages/platform-zoom-app/src/:
- zoom-auth-provider.ts → AuthProvider via zoomSdk.authorize() + onAuthorized + PKCE
- zoom-storage-provider.ts → StorageProvider via in-memory Map (NOT localStorage)
- zoom-meeting-adapter.ts → MeetingPlatformAdapter via zoomSdk.getMeetingContext(),
  getRunningContext(), lifecycle events. startCapture/stopCapture are NO-OPS if RTMS path,
  or attempt getUserMedia if mic-only path.
- zoom-prompt-surface.ts → PromptSurface rendering in Zoom panel
- zoom-context.ts → wraps zoomSdk.getUserContext() and getMeetingContext() (exposes
  meeting UUID for RTMS correlation)

Step 2: Use @implementer to create the app shell in packages/zoom-app/src/:
- index.tsx — entry point
- app/ZoomApp.tsx — zoomSdk.config() with capabilities, wire adapters, mount ui-app screens
- vite.config.ts
- public/manifest.json — Zoom App SDK manifest

Step 3: Wire lifecycle (client_type: 'zoom_app', source_runtime: 'zoom_app').
CRITICAL: at POST /meetings/start, send the Zoom meeting UUID (from zoom-context.ts) as
platform_meeting_id (column added in PR 5). This is the join key the RTMS listener (PR 13)
uses to correlate the server-side media stream with this session. Without it, RTMS-derived
prompts have no session to land in.

Step 4 (RTMS path only): Use @implementer to build the RTMS activation consent moment.
RTMS activation is VISIBLE to other participants — this is a designed UX, not incidental
wiring. Requirements:
- Before starting capture, show the user what will happen: "Activating coaching will
  notify other participants that this app is accessing meeting content."
- Explicit user action to activate (no silent auto-start)
- Clear session indicator while coaching is active
- One-tap deactivation

Step 5: DECISION — prompt delivery transport. The 3s HTTP poll from client-core is the
Chrome-proven default, but two factors favor WebSocket/SSE push for Zoom:
(a) RTMS delivery to the backend is near-instant, so poll interval dominates felt latency;
(b) mobile webviews throttle background timers aggressively, making polling unreliable
when the panel is backgrounded.
If choosing push: extend client-core's PromptPoller with a WebSocket-based implementation
behind the same interface (both Chrome and Zoom can then share it). Record the decision
in the PR description either way.

Step 6: MOBILE SURFACE — in the Zoom App marketplace config, enable Mobile Client under
Zoom Client Support (Surface page). For iOS/iPadOS support, supply the Apple Developer
Program Team ID. Constraint: the app must not contain in-app purchase flows or links to
external purchasing (Apple policy enforced by Zoom). Test on at least one iPad.

Step 7: Use @test-writer for adapter tests.

Step 8: Use @contract-checker — zero chrome.* or @microsoft/teams-js imports.
```

### Subagent Delegation

Same fan-out pattern as the Teams shell (Milestone 2), adjusted for Zoom SDK: 5 parallel @implementer agents for adapters, then shell, then wiring, then @test-writer, then @contract-checker.

### Exit Criteria
- [ ] Zoom app builds with Vite
- [ ] Loads in Zoom desktop client (dev mode)
- [ ] zoomSdk.config() succeeds
- [ ] Meeting context retrieved during live meeting
- [ ] Zoom OAuth flow completes → backend session created
- [ ] platform_meeting_id sent at meetings/start and persisted
- [ ] (RTMS path) Consent/activation UX implemented — no silent capture start
- [ ] Prompt transport decision recorded (poll vs push)
- [ ] Mobile Client surface enabled; app loads on at least one mobile/iPad client

---

## PR 13: Zoom Capture — RTMS Backend Listener OR Mic Fallback

**Branch:** `feat/zoom-capture`
**Depends on:** PR 12 + PR 9 (engine port, if RTMS path)
**Decision gate:** docs/zoom-capability-matrix.md from the spike

### Path A: RTMS (if available)

**This is a BACKEND component, not a client-side AudioCaptureProvider.**

#### Orchestrator Prompt

```
Build the server-side RTMS listener that receives meeting audio/transcript from Zoom and
feeds the coaching engine directly.

PRIVACY CONSTRAINT: Other participants' audio is processed TRANSIENTLY for context only.
No behavioral record, transcript, or analysis is stored for non-users.

Step 1: Verify prerequisites (no migration needed — platform_meeting_id was added in
PR 5, and PR 12 already sends it at meetings/start). Confirm with a quick query that
zoom_app sessions have the column populated.

Step 2: Use @implementer to create backend/src/rtms/rtms-webhook-handler.ts:
- POST /webhooks/zoom/rtms endpoint
- Handle meeting.rtms_started event
- Extract meeting UUID, look up corresponding Evolvio session

Step 3: Use @implementer to create backend/src/rtms/rtms-media-listener.ts:
- Open signaling + media WebSocket to Zoom
- Receive audio frames or transcript segments (based on spike decision)
- Speaker attribution via RTMS metadata
- For coached user: create full transcript_segment events
- For other participants: extract ONLY contextual features (interruption timing, turn
  boundaries), then DISCARD raw content — never store

Step 4: Use @implementer to create backend/src/rtms/rtms-event-normalizer.ts:
- Convert RTMS segments → NormalizedEvent format
- Tag: source_runtime='zoom_app', source_channel='rtms_audio' or 'rtms_transcript'

Step 5: Wire into AnalysisEngine.ingestEvents() (from PR 9).

Step 6: Use @test-writer for:
- Webhook receives event and logs meeting UUID
- Normalizer produces correct event shapes
- Non-user audio is not persisted (check DB after processing)

Step 7: Use @reviewer with SECURITY focus:
- Verify no non-user audio/transcript is stored
- Verify webhook validates Zoom signature
- Verify WebSocket reconnection on failure
```

### Path B: Mic-Only (if RTMS unavailable)

#### Orchestrator Prompt

```
Implement mic capture in the Zoom webview as a fallback. This is FRAGILE — getUserMedia
may fail if Zoom holds the mic.

Step 1: Use @implementer to update zoom-meeting-adapter.ts startCapture():
- Attempt navigator.mediaDevices.getUserMedia({ audio: true })
- Check track.readyState === 'live' — if not, log and set captureAvailable = false
- If live: MediaRecorder with 10s chunks → POST to backend
- Wrap everything in try/catch — NEVER crash, just degrade

Step 2: Use @implementer to create zoom-audio-chunker.ts:
- MediaRecorder → WebM chunks → events/batch endpoint
- Tag: source_channel='mic_audio'

Step 3: Document degraded laws in docs/zoom-capability-matrix.md:
- Full signal: speaking pace, filler words, monologue length, self-framing
- No signal: interruption, turn-taking, dominance, reactive framing
- Partial: pause patterns (can't distinguish listening from hesitating)

Step 4: Use @test-writer for the graceful degradation paths.
```

### Exit Criteria (either path)
- [ ] Capture mechanism receives audio/transcript from a live Zoom meeting
- [ ] Events reach the backend with correct source tags
- [ ] Coaching prompts fire during a Zoom session
- [ ] (RTMS only) No non-user data persisted in DB
- [ ] (Mic only) Graceful degradation if mic unavailable

---

## PR 14: Per-Platform Signal Calibration

**Branch:** `chore/platform-calibration`
**Depends on:** PRs 11, 12, 13 (all platforms functional)

### Orchestrator Prompt

```
Tune coaching thresholds so prompts are useful on Teams/Zoom without over-triggering.

Step 1: Use @implementer to create backend/src/config/platform-thresholds.ts:
- Load per-platform threshold overrides for each of the 12 laws
- Default thresholds stay for Chrome/Meet
- Higher thresholds for lower-fidelity platforms (fewer but higher-confidence prompts)
- Config structure: { [lawId]: { default: 0.7, zoom_app: 0.85, teams_app: 0.8 } }

Step 2: Use @implementer to update the law evaluator to accept platform context and
apply platform-specific thresholds.

Step 3: Use @test-writer to verify:
- Chrome/Meet thresholds unchanged
- Zoom/Teams thresholds are higher
- Threshold config is externalized (not hard-coded)

Step 4: MANUAL CALIBRATION (not automated):
- Run same conversation on Meet (extension) vs Teams vs Zoom
- Compare prompt count, relevance, false positives
- Adjust thresholds iteratively
```

### Exit Criteria
- [ ] Per-platform thresholds configurable via config
- [ ] Meet coaching unchanged
- [ ] Teams/Zoom prompts are useful without over-triggering

---

## PR 15: Cross-Platform QA & Integration Tests

**Branch:** `test/cross-platform-qa`
**Depends on:** PRs 12, 13, 14 (Milestone 1 scope: Chrome/Meet + Zoom columns only; the Teams column of the matrix below is exercised in Milestone 2 when PRs 10+11 land)
**Additional mobile check:** run the Zoom column once on a mobile/iPad client — prompt delivery while the panel is backgrounded is the case most likely to fail (timer throttling)

### Orchestrator Prompt

```
Build a comprehensive cross-platform test suite and run it.

Step 1: Use @test-writer to create tests/integration/cross-platform.test.ts covering
every cell in this matrix:

| Test                      | Chrome/Meet  | Teams        | Zoom         |
|---------------------------|-------------|-------------|-------------|
| Sign in with platform ID  | Google      | Microsoft   | Zoom OAuth  |
| Start meeting → session   | ✓           | ✓           | ✓           |
| Prompts during meeting    | ✓           | ✓           | ✓           |
| Prompt ack recorded       | ✓           | ✓           | ✓           |
| Pause / resume            | ✓           | ✓           | ✓           |
| End → report available    | ✓           | ✓           | ✓           |
| History shows session     | ✓           | ✓           | ✓           |
| Correct source tags       | extension   | teams_app   | zoom_app    |
| Backend restart → prompts | ✓           | ✓           | ✓           |
| User delete removes all   | ✓           | ✓           | ✓           |

Step 2: Use @contract-checker to verify no cross-platform state leaks.

Step 3: Use @reviewer for final review of the entire test suite.
```

### Exit Criteria
- [ ] Every matrix cell has a test
- [ ] All tests pass against real backend with test DB
- [ ] @reviewer APPROVE

---

## PR 16: Private Distribution Packaging

**Branch:** `chore/private-distribution`
**Depends on:** PR 15

### Orchestrator Prompt

```
Package both apps for private/beta deployment and prepare compliance artifacts.

Step 1: Use @implementer to finalize Teams packaging:
- Teams app manifest with correct permissions and scopes
- App package (.zip: manifest + icons)
- Admin sideload documentation

Step 2: Use @implementer to finalize Zoom packaging:
- Zoom App SDK manifest with least-privilege OAuth scopes
- Register as private app in Zoom Marketplace
- Installation documentation

Step 3: Use @implementer to create compliance docs:
- docs/privacy-policy.md — meeting data, transcript handling, retention policy,
  explicit statement that non-user audio is processed transiently and never stored
- docs/permissions-matrix.md — per-platform OAuth scopes with justification
- docs/reviewer-test-plan.md — happy-path steps for both platforms
- docs/architecture-summary.md — target audience: marketplace reviewers

Step 4: Use @implementer to add platform monitoring:
- client_type dimension on existing backend metrics
- Per-platform error rate logging

Step 5: Use @reviewer for final review of all artifacts.
```

### Exit Criteria
- [ ] Teams app installable via admin sideload
- [ ] Zoom app installable as private app
- [ ] All compliance docs committed
- [ ] Monitoring shows events segmented by platform

---

## PR 17: Legacy Cleanup (Deliberately Late)

**Branch:** `chore/identity-cleanup`
**Depends on:** All previous PRs merged and stable in production
**Timeline:** After compatibility window (all Chrome extension users have updated)

### Orchestrator Prompt

```
Remove legacy compatibility shims. Only do this after confirming all clients use new paths.

Step 1: Use @migrator to create migration dropping google_subject_id from users table.

Step 2: Use @implementer to remove:
- POST /auth/session Google alias
- extension_version from MeetingStartRequest
- Old source CHECK constraint on raw_events

Step 3: Use @contract-checker to verify no remaining code references dropped columns/routes.

Step 4: Use @test-writer to update tests to reflect new-only paths.
```

### Exit Criteria
- [ ] No legacy columns in schema
- [ ] All routes use new naming
- [ ] All three clients work after cleanup

---

## Verification Strategy (Per Wave)

> Sourced from the Zoom Conversion Workplan Part E. Each PR has exit criteria, but these wave-level checks catch cross-PR integration issues.

**Wave 1 — Foundation (PRs 1–5, 7, 9):**
Non-negotiable gate is the `packages/backend` Jest suite staying green after every merge. Backend changes are additive only — verify with: "Does the existing Chrome extension still work if I install it right now against this backend?"

**Wave 2 — Chrome Rebind (PR 6):**
The make-or-break regression gate. Run a **real Meet session** through: start → live prompt → pause → resume → end → report → history. No behavior delta allowed. This is how R3 (keep Chrome working) is enforced. Do not proceed to any Zoom work until this passes.

**Wave 3 — Zoom (PRs 12, 13):**
Manual end-to-end in the **Zoom desktop client**: install the private app, run a real meeting, confirm private prompts render in-panel, lifecycle transitions fire, report + history load, and events land tagged `zoom_app`. Backend metrics segmented by platform.

**Wave 4 — Calibration (PR 14):**
Side-by-side Meet vs Zoom on comparable meetings. Confirm no over-triggering and Meet behavior unchanged. This is the product-quality gate, not just a technical gate.

**Identity (PR 4):**
Unit + integration: existing Google alias path still returns a session; a synthetic Zoom-provider request creates a linked identity with no Google row; deletion removes identity rows. Verify backfill idempotency on a copy of the schema.

**Queue (PR 5):**
Restart the backend mid-session and confirm queued prompts survive. Hammer `/prompts/poll` to confirm idempotent, no-duplicate delivery.

---

## PR Dependency Graph — Milestone 1 (Zoom-first)

```
PR 0 (spike) ──────────────────────────────────────────────────────────────┐
  │ (does NOT block foundation PRs)                                         │
  │                                                                         │
PR 1 (scaffold) ──► PR 1B (CI guardrails)                                   │
 ├── PR 2 (client-core — both commit series) ──► PR 6 (chrome adapter)      │
 │                                                ⚠️ REGRESSION GATE       │
 ├── PR 4 (identity refactor) ──────────────────────────┤                   │
 ├── PR 5 (redis queue + metadata + platform_meeting_id)┤                   │
 └── PR 7 (ui-app, responsive/360px) ───────────────────┤                   │
                                                        │                   │
 PR 8 (contract tests + packages/mock-backend) ◄── PRs 4+5 (shared frozen)  │
 PR 9 (engine port) ◄── PR 5                                                │
 PR 9B (infra ports, optional) ◄── PR 9                                     │
                                                        │                   │
                            ┌───────────────────────────┘                   │
                            ▼                                               │
              PR 12 (zoom shell + consent UX + UUID wiring) ◄── PR 0 ───────┘
                        │
                        ├──► PR 13 (zoom capture — RTMS or mic, per spike; needs PR 9 if RTMS)
                        ▼
              PR 14 (calibration) ──► PR 15 (QA) ──► PR 16 (private dist)
                                                            │
                                                            ▼
                                        ═══ MILESTONE 2: PRs 10+11 (Teams, one merged PR) ═══
                                                            │
                                                            ▼
                                              PR 17 (cleanup — after compat window)
```

### Two Independent Lanes (Dual-Adapter Payoff)

```
BACK-END LANE:  PR 4 (identity) · PR 5 (queue+meta) · PR 9 (engine port) · PR 9B (optional)
FRONT-END LANE: PR 2 (client-core) · PR 6 (chrome gate) · PR 7 (ui-app) · PRs 12–13 (zoom)
BRIDGE:         PR 8 (contract tests + mock-backend package) — front-end develops against mock
```

Freeze `@gleameet/shared` after PRs 4 + 5 land, then stand up the contract tests (PR 8). This is the mechanism that keeps parallel front/back development from breaking each other.

## Parallel Execution Map — Milestone 1

```
Day 1:   PR 0 (spike, 1-2 days) — START THE ZOOM SALES CONVERSATION FOR RTMS DAY 1
         PR 1 (scaffold) → PR 1B (CI guardrails), same day

Week 1:  PR 0 continues (if RTMS needs sales contact)
         Fan out from PR 1B:
         ├── PR 2 (both commit series — client-core — FRONT-END LANE)
         ├── PR 4                   (backend identity — BACK-END LANE)
         ├── PR 5                   (backend queue+meta+UUID col — BACK-END LANE)
         ├── PR 7                   (ui-app, responsive — FRONT-END LANE)
         └── PR 9                   (engine port — BACK-END LANE)

Week 2:  PR 6 ⚠️ REGRESSION GATE  (chrome adapter, needs PR 2)
         PR 8                      (contract tests + mock-backend, needs PRs 4+5 — BRIDGE)
         PR 9B                     (infra ports, optional, needs PR 9)

Week 3:  PR 12 → PR 13            (zoom shell → zoom capture; needs PRs 2,4,7 + PR 0's decision)
         ── Teams does NOT run this week (deferred to Milestone 2) ──

Week 4:  PR 14 → PR 15 → PR 16   (calibration → QA → private distribution)

MILESTONE 2 (after Zoom ships): PRs 10+11 as one merged PR (Teams)
Later:   PR 17                     (cleanup, after compat window)
```

## Platform Coverage & Scope Boundaries

> Explicit decisions so nobody discovers these as surprises during a pilot.

| Surface | Covered? | How |
|---|---|---|
| Meet — Chrome desktop | ✅ M1 | Existing extension (PR 6 preserves it) |
| Zoom — desktop client | ✅ M1 | Zoom App (PRs 12–13) |
| Zoom — mobile/iPad client | ✅ M1 (same app) | Enable Mobile Client surface in PR 12; Apple Team ID for iOS; responsive ui-app from PR 7; RTMS capture unaffected (server-side) |
| Zoom — **browser web client** | ❌ Out of scope v1 | Zoom Apps panel does not exist in the browser client — the app cannot load or activate, so RTMS never starts either. Migration path if needed later: a `zoom-web` DOM adapter inside `platform-chrome` (the Chrome manifest already lists Zoom web URLs), NOT the Zoom App. Record in the capability matrix. |
| Teams — desktop | ⏸ Milestone 2 | PRs 10+11 |
| Meet — mobile | ❌ No path | Mobile Chrome has no extensions; would require a different product surface entirely |

Two mobile-specific engineering notes carried into the PRs above: (a) mobile webviews throttle background timers, which motivates the WebSocket/SSE push option for prompt delivery (decision in PR 12 Step 5); (b) the mic-in-webview fallback is even more restricted on iOS than desktop — another reason RTMS is the preferred capture path.

## ECC-Specific Tips

1. **Use `/multi-plan` before each PR** to have the orchestrator decompose the PR into subagent tasks and verify the plan before execution.

2. **Use `/multi-execute` for fan-out steps** — e.g., creating 5 adapter files in parallel, or 5 contract test files in parallel.

3. **Keep subagent mandates narrow.** "Return a summary" not "return everything." Each subagent's output lands in the orchestrator's context, so verbose returns burn your window.

4. **Strategic compaction.** Use `/compact` between subagent fan-outs. After a 5-agent fan-out returns, compact before the next phase to keep the orchestrator's context clean.

5. **Model tiering for this project:**
   - Sonnet 4.6: all @extractor, @implementer, @test-writer, @migrator work
   - Opus: @reviewer (final PR review), orchestrator planning, and any session that fails on first Sonnet attempt

6. **Hook suggestion:** Add a post-edit hook that runs `grep -r "chrome\.\|@microsoft/teams-js\|@zoom/appssdk" packages/client-core/src/ packages/ui-app/src/` and fails if anything is found. This catches contract violations at edit time, not review time.

7. **The lead owns two contracts** (from the workplan's dual-adapter model):
   - `client-core/types/runtime.ts` (front-end port)
   - `@gleameet/shared` + the engine port (back-end seam)
   Keep both stable before each lane fans out. If a subagent proposes a change to either contract, escalate to the orchestrator for review — don't let agents silently modify shared interfaces.

8. **Front-end lane can develop against the mock (PR 8) while back-end lane evolves.** Once the contract tests exist, the front-end lane doesn't need the real backend running. This means Teams and Zoom app development is unblocked even if backend PRs 9/9B are still in progress.

9. **RTMS SDK context.** Sonnet's training data may not include the latest Zoom RTMS Node.js/Python SDK (v1.0 released 2025–2026). When running PR 13 Path A, provide the npm package README or Zoom's RTMS documentation as context in the Claude Code session using `cat node_modules/@zoom/rtms/README.md` or by pasting the docs.

10. **Zoom webview gotchas for subagents.** When @implementer creates Zoom adapter code, remind it: `localStorage` is unreliable across Zoom sessions (use in-memory `Map`), `navigator.mediaDevices.getUserMedia` may return `undefined` (not just reject), and `zoomSdk` methods are async but may silently fail without throwing — always check return values.

## Open Items to Confirm Before Execution

> From the Zoom Conversion Workplan — resolve these before or during PR 0.

1. **Capture fidelity for v1** — resolved by PR 0's spike. If you already know Zoom real-time transcript is out of reach, pre-commit the MVP to mic-only/lifecycle signals and skip part of the spike.
2. **Auth choice for Zoom** — Zoom OAuth vs. app-context/SSO; affects PR 4's `zoom` provider stub and PR 12 wiring.
3. **RTMS account status** — has anyone talked to Zoom sales about Developer Pack pricing? This is a hard blocker for the RTMS path that no amount of engineering can work around.
