# GleaMeet Architecture

> **Last updated:** 2026-04-09 (transcript attribution model)

GleaMeet is a real-time AI meeting coach delivered as a Chrome extension backed by a Node.js API server. It observes meeting signals (speech, captions, behavioral cues), evaluates them against 12 behavioral laws from Cialdini, Kahneman, and Thaler, and delivers personalized nudges via GPT-4o during the call. After the meeting, it generates a detailed coaching report.

---

## Table of Contents

- [Monorepo Structure](#monorepo-structure)
- [Data Pipeline](#data-pipeline)
- [Extension Architecture](#extension-architecture)
- [Backend Architecture](#backend-architecture)
- [Behavioral Laws](#behavioral-laws)
- [LLM Integration](#llm-integration)
- [Audio Capture & Transcription](#audio-capture--transcription)
- [Post-Meeting Reports](#post-meeting-reports)
- [Database Schema](#database-schema)
- [Redis State Management](#redis-state-management)
- [Authentication](#authentication)
- [CORS Policy](#cors-policy)
- [Infrastructure & Deployment](#infrastructure--deployment)
- [Extension Version History](#extension-version-history)

---

## Monorepo Structure

```
gleameet/
├── packages/
│   ├── shared/           # TypeScript types, constants, API contracts
│   ├── law-registry/     # 12 behavioral law definitions (JSON)
│   ├── backend/          # Express.js API server
│   └── extension/        # Chrome extension (Manifest V3)
├── docker-compose.yml    # Local dev: postgres + redis + backend
├── Dockerfile            # Multi-stage production build
├── render.yaml           # Render deployment config
└── scripts/migrate.sh    # DB schema migration
```

**Workspace config:** npm workspaces with build order `shared → law-registry → backend | extension`.

---

## Data Pipeline

```mermaid
flowchart LR
    A[Extension<br/>Content Script] -->|events| B[Service Worker<br/>Batching]
    B -->|POST /events/batch| C[Feature Engine]
    C -->|22 features| D[Law Evaluator]
    D -->|trigger candidates| E[Intervention Engine]
    E -->|prompt event| F[Redis<br/>Prompt Queue]
    F -->|GET /prompts/poll| G[Extension<br/>Overlay Shown]

    B -->|getMediaStreamId| K[Offscreen Doc<br/>offscreen.html]
    K -->|10s WebM chunks<br/>mic + tab audio| I[POST /audio/transcribe]
    I -->|Whisper<br/>noise filter + en| J[Attributed Transcript Segments]
    J --> C
```

### Pipeline Stages

1. **Content Script** — Detects meeting state on `meet.google.com`, `teams.microsoft.com`, `teams.live.com`, `zoom.us/wc`, and `app.zoom.us/wc`. It maintains explicit platform state and only enables signal sources that the platform actually supports. Google Meet uses DOM speech/caption observation plus mic/tab audio. Teams and Zoom web use URL/UI meeting detection plus mic-first speech detection and tab/mic audio capture; they do not pretend to have Meet-equivalent DOM caption/speaker signals.

2. **Service Worker** — Batches events and forwards them to the backend. Polls `/prompts/poll` on a timer to retrieve pending nudges.

3. **Feature Engine** (`packages/backend/src/services/feature-engine.ts`) — Processes raw events and extracts 22 linguistic/behavioral features. Updates rolling meeting state in Redis. Features include turn count, response latency, acknowledgment count, hedging/certainty language scores, loss/gain framing, action specificity, option counts, and boolean flags for defaults, owners, deadlines, evidence references, and peer examples.

4. **Law Evaluator** (`packages/backend/src/services/law-evaluator.ts`) — Evaluates trigger logic for each active law against the current feature snapshot. Checks disconfirming (suppression) logic. Computes trigger confidence scores.

5. **Intervention Engine** (`packages/backend/src/services/intervention-engine.ts`) — Ranks candidate triggers, selects the best prompt (max 1 per batch), applies rate limiting and cooldowns, then optionally personalizes the nudge text via GPT-4o (non-blocking, 6s timeout with static template fallback).

6. **Prompt Delivery** — Extension polls the backend, retrieves pending prompts from Redis, and renders an overlay on the meeting page.

---

## Extension Architecture

**Manifest V3** Chrome extension targeting Google Meet, Microsoft Teams, and Zoom.

| Component | Source | Role |
|-----------|--------|------|
| **Content Script** | `packages/extension/src/content/content-script.ts` | Platform-aware meeting detection, DOM/mic signal capture, prompt overlay rendering |
| **Service Worker** | `packages/extension/src/background/service-worker.ts` | Session management, platform propagation, prompt routing, event batching, tab audio orchestration |
| **Offscreen Document** | `packages/extension/public/offscreen.html` + `src/offscreen.ts` | MV3-compatible mic + tab audio capture isolated from the meeting page |
| **Popup** | `packages/extension/src/popup/Popup.tsx` | Auth UI, coaching status, meeting history, post-meeting reports |
| **API Client** | `packages/extension/src/utils/api-client.ts` | HTTP wrapper for all backend endpoints |

**Permissions:** `activeTab`, `tabCapture`, `storage`, `alarms`, `identity`, `offscreen`
**Host permissions:** `https://meet.google.com/*`, `https://teams.microsoft.com/*`, `https://teams.live.com/*`, `https://zoom.us/*`, `https://app.zoom.us/*`
**OAuth2 scopes:** `openid`, `email`, `profile`

### Platform Detection

The extension uses a small capability model keyed by platform (`google_meet`, `teams`, `zoom`) and keeps platform state in both the content script and service worker. The content script detects the platform from the current URL and polls every 1 second for hash/pushState navigation changes:

| Platform | URL Match | Signal Strategy |
|----------|-----------|-----------------|
| **Google Meet** | `meet.google.com` | User-scoped DOM speech/caption observation + user-specific mic/speech signals |
| **Microsoft Teams** | `teams.microsoft.com`, `teams.live.com` | URL/UI-based meeting detection with end debounce, including `light-meetings/launch`; mic speech detection only; no Meet-style DOM captions/speaker inference |
| **Zoom** | `zoom.us/wc`, `app.zoom.us/wc` | URL/UI-based meeting detection with ended-screen filtering; mic speech detection only; no Meet-style DOM captions/speaker inference |

### Platform Propagation

- `MEETING_DETECTED` now carries the detected platform into the service worker.
- `START_COACHING` resolves the active supported web tab and starts the backend meeting session with that platform instead of defaulting to `google_meet`.
- Raw events emitted from the content script carry the current platform explicitly.
- `STATUS_UPDATE`, `COACHING_STARTED`, prompt delivery, and prompt dismissal are broadcast across all supported web meeting tabs rather than Google Meet only.
- `AUDIO_TRANSCRIPT_RESULT` is broadcast back into the meeting tab so transcript attribution can happen before event ingestion.

### Transcript Attribution Model

- Full-meeting transcript context is preserved. Non-user transcript context from tab audio and DOM captions is kept in the transcript history and recent-context buffer.
- Each `transcript_segment` now carries attribution metadata: source (`mic`, `tab`, `caption`, `web_speech`), candidate speaker, final speaker, whether it passed user attribution, and overlap evidence when suppression occurred.
- Candidate self/user transcripts are compared against a short rolling buffer of recent non-user transcript context. If a candidate strongly overlaps recent non-user captions/tab audio, it is reclassified as `other` with reason `overlap_with_recent_non_user_context`.
- Coaching remains user-only because only segments that still pass attribution are allowed to increment user-triggering features.

### Coaching Lifecycle Messages

| Message | Handler | Effect |
|---------|---------|--------|
| `START_COACHING` | `handleStartCoaching()` | Starts session with the detected web platform, intervals, and tab capture. If session exists, resumes it (`{ resumed: true }`) |
| `STOP_COACHING` | `handlePauseCoaching()` | Pauses coaching — flushes events, clears intervals, sets status to `'ready'`. Session stays alive |
| `RESUME_COACHING` | `handleStartCoaching()` | Restarts intervals on existing session |
| `END_MEETING` | `handleStopCoaching()` | Terminates session, calls `/meetings/end`, generates report, resets to `'off'` |

The content script's `onMeetingEnded()` sends `END_MEETING` (not `STOP_COACHING`) to ensure report generation. Meeting-end detection is debounced to tolerate transient DOM/router churn on Meet, Teams, and Zoom web.

---

## Backend Architecture

Express.js server on port 3001 with PostgreSQL, Redis, and OpenAI integrations.

### Routes

| Route | Method | Purpose | Auth |
|-------|--------|---------|------|
| `/auth/session` | POST | Google OAuth session creation | No |
| `/meetings/start` | POST | Initialize coaching session | Yes |
| `/meetings/end` | POST | End session, trigger report generation | Yes |
| `/events/batch` | POST | Ingest behavioral events → pipeline | Yes |
| `/prompts/poll` | GET | Fetch pending nudge prompts | Yes |
| `/prompts/ack` | POST | Acknowledge prompt (shown/dismissed/acted) | Yes |
| `/audio/transcribe` | POST | Whisper transcription proxy (multipart) | Yes |
| `/reports/:meeting_session_id` | GET | Retrieve post-meeting report | Yes |
| `/history` | GET | User's meeting history list | Yes |
| `/user` | GET | User profile | Yes |
| `/registry` | GET | Active law registry | Yes |
| `/health` | GET | Service health check | No |
| `/metrics` | GET | Prometheus metrics | No |

**Middleware:** CORS, Helmet, Bearer token auth extraction, request logging.

---

## Behavioral Laws

12 active laws across three source families, defined as JSON in `packages/law-registry/laws/`.

### Cialdini (Persuasion)

| ID | Law | Trigger Summary |
|----|-----|-----------------|
| **C-01** | Reciprocity | No acknowledgments after 3+ turns |
| **C-02** | Commitment & Consistency | 6+ turns with low action specificity |
| **C-03** | Social Proof | No peer examples/evidence after 4+ turns |
| **C-04** | Authority | High certainty without evidence citation |

### Kahneman (Cognitive Bias)

| ID | Law | Trigger Summary |
|----|-----|-----------------|
| **K-01** | System 1 vs System 2 | Rapid rebuttal (<1.5s) after disagreement without clarifying question |
| **K-02** | Loss Aversion | High loss framing (>0.6) without gain framing (<0.3) |
| **K-03** | Anchoring | High specificity + certainty with ≤1 option presented |
| **K-04** | Overconfidence | High certainty (>0.7) without evidence |

### Thaler (Nudge Theory)

| ID | Law | Trigger Summary |
|----|-----|-----------------|
| **T-01** | Choice Architecture | 3+ options without default recommendation |
| **T-02** | Default Effect | Multiple options without default after 5+ turns |
| **T-03** | Nudge | Agreement detected without owner or deadline assignment |
| **T-04** | Present Bias | High loss framing (>0.5) with low gain framing (<0.2) |

Each law definition includes: `trigger_logic` (conditions on features), `disconfirming_logic` (suppression rules), `prompt_templates_live` (real-time nudge text), `prompt_templates_post` (post-meeting reflection), `confidence_threshold`, and `cooldown_seconds`.

**Positive reinforcement:** Every 5 positive behaviors, the system generates a GPT-4o compliment citing the specific good behavior observed.

---

## LLM Integration

| Model | Provider | Use Case |
|-------|----------|----------|
| **GPT-4o** | OpenAI | Nudge personalization, positive reinforcement, report narrative generation |
| **Whisper-1** | OpenAI | Audio transcription (mic capture) |
| **Ollama (llama3.2)** | Local fallback | Development/offline mode |

**Coaching scope:** All GPT-4o prompts (nudge personalization, reinforcement, report narratives) explicitly coach only the user ("YOU"). Other participants ("THEM") appear in transcript context but are never critiqued, praised, or referenced by name. The Feature Engine's `analyzeTranscriptText` only processes user segments that passed attribution; other-speaker text and suppressed candidate-user text contribute only to context/timing.

**Nudge personalization:** Recent transcript (last 5 segments) + feature snapshot → JSON output with `short_text` (≤25 words) and `rationale_text` (≤20 words). Temperature 0.7, 6-second timeout with static template fallback.

**Config:** `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` environment variables. Defaults to local Ollama for development.

---

## Audio Capture & Transcription

Two audio streams are captured simultaneously via the offscreen document:

### Mic Audio (Offscreen Document — MV3)

1. Service worker ensures `offscreen.html` is active.
2. Offscreen doc calls `navigator.mediaDevices.getUserMedia({ audio })` to capture microphone audio without altering the meeting tab's routing.
3. Audio is recorded in 10-second WebM chunks and sent to `/audio/transcribe` as stream type `mic`.

### Tab Audio (Offscreen Document — MV3)

1. Service worker calls `chrome.tabCapture.getMediaStreamId({ targetTabId })` to obtain a stream ID for the meeting tab.
2. Service worker creates the offscreen document (`offscreen.html`) with reason `USER_MEDIA`.
3. Service worker sends `START_TAB_CAPTURE` message to offscreen doc with `streamId`, `sessionToken`, and `apiBase`.
4. Offscreen doc calls `navigator.mediaDevices.getUserMedia()` with `chromeMediaSource: "tab"` and the provided stream ID.
5. Records 10-second WebM chunks; skips chunks <1 KB. Sends to `/audio/transcribe` (stream type `tab`).
6. Both mic and tab transcription results are posted back into the meeting tab as `AUDIO_TRANSCRIPT_RESULT` messages for attribution.

### Backend Transcription & Noise Filtering

The `/audio/transcribe` endpoint proxies to OpenAI Whisper-1 with `language: "en"` forced. Before returning, it applies noise filtering via `isValidTranscript()`:

- Minimum 3 characters and 2 words
- **Noise patterns rejected:** single filler words ("thank you", "thanks"), bracket annotations (`[Music]`, `[Applause]`), music notation (`♪...♪`), lone parentheticals (`(laughing)`)
- **Non-ASCII ratio:** Rejects if >30% of characters are non-ASCII (garbled Whisper output)
- Returns empty string on invalid transcript

Transcript segments are fed into the Feature Engine with attribution metadata. Full transcript history is retained, but only user/candidate-user segments that still have `passes_user_attribution=true` can drive user coaching features.

### Signal Priority

When Whisper is active (`whisperActive` flag), the content script suppresses Web Speech API final transcripts to avoid duplicate self transcripts, but keeps DOM captions and tab-audio transcripts available as non-user context. That context is what powers overlap-based suppression for leaked speaker audio.

---

## Post-Meeting Reports

Generated when `/meetings/end` is called (triggered by `END_MEETING` message). Stored in `post_meeting_reports`.

| Field | Description |
|-------|-------------|
| `summary_analysis` | GPT-4o narrative summary of meeting coaching dynamics (user-only focus) |
| `transcript_with_nudges` | Full transcript annotated with nudge events inline (merged & sorted by `timestamp_ms`) |
| `strengths` | Positive behavioral patterns identified |
| `growth_areas` | Areas for improvement with specific examples |
| `recommended_actions` | Actionable next steps with reasons tied to law triggers |
| `timeline` | Chronological sequence of key events and nudges |

**`transcript_with_nudges` assembly:** Speech entries (filtered to text >5 chars) and nudge entries (prompts with `shown_at`) are merged into a single chronological array sorted by `timestamp_ms`. Nudge entries include `type` (`nudge` or `reinforcement`), combined `short_text` + `rationale`, and `nudge_law_id`. Timestamps use `event_time_utc` relative to `started_at`.

**Backfill:** For older reports generated before `transcript_with_nudges` was stored, the field is backfilled on-the-fly when the report is fetched.

---

## Database Schema

PostgreSQL 16. Schema at `packages/backend/src/db/schema.sql`.

| Table | Purpose |
|-------|---------|
| `users` | Google OAuth accounts (UUID PK, google_subject_id, email, preferences JSONB) |
| `meeting_sessions` | Meeting lifecycle (user FK, platform, start/end times, status, extension version) |
| `consent_records` | Privacy consent tracking (per-meeting, revocable, scope JSONB) |
| `raw_events` | All captured events (event_type, source, capture_confidence, payload JSONB) |
| `feature_observations` | Computed features per window (30s, 90s, full_meeting) |
| `law_registry_entries` | Versioned law definitions (status: draft/active/deprecated/disabled) |
| `law_triggers` | Triggered laws with confidence and evidence refs |
| `prompt_events` | Nudge delivery tracking (display_state, shown_at, dismissed_at). `short_text` and `rationale_text` are TEXT (was VARCHAR(100)). `prompt_type` constraint includes `reinforce` |
| `post_meeting_reports` | Report JSON blobs (summary, insights, strengths, growth areas, timeline, transcript_with_nudges) |
| `meeting_transcripts` | Aggregated transcript JSON per session |
| `user_sessions` | Session persistence: `session_token` (TEXT PK), `user_id`, `created_at`, `expires_at`, `last_used_at`. 30-day TTL. Survives Redis restarts |
| `deletion_audits` | GDPR deletion audit log (scope: meeting or all_user_data) |

**Cascade:** Deleting a user cascades through all related meeting data.

---

## Redis State Management

Redis 7. Key patterns prefixed with `gleameet:`.

| Key Pattern | Purpose | TTL |
|-------------|---------|-----|
| `gleameet:meeting:<sessionId>:state` | Rolling MeetingState (features, transcript buffer, counters) | 4h |
| `gleameet:meeting:<sessionId>:cooldown:<lawId>` | Per-law cooldown | 30–60s |
| `gleameet:meeting:<sessionId>:global_cooldown` | Global prompt cooldown | 15–60s |
| `gleameet:meeting:<sessionId>:prompt_count` | Rate limit counter | 30min |
| `gleameet:meeting:<sessionId>:speaking` | User speaking state | 4h |
| `gleameet:session:<token>` | Auth session validation (backed by PostgreSQL `user_sessions` for durability) | 30d |

**MeetingState** includes: timing metrics, turn counts, linguistic accumulator counters (hedging, certainty, loss/gain framing), structural boolean flags, a rolling transcript buffer (last 10 segments), and prompt tracking arrays.

---

## Authentication

```
Chrome Extension                          Backend
     │                                       │
     │  chrome.identity.getAuthToken()        │
     │  → Google OAuth access token           │
     │                                       │
     │  POST /auth/session {token}  ────────► │
     │                                       │  GET googleapis.com/oauth2/v3/userinfo
     │                                       │  → sub, email, name
     │                                       │  upsertUser()
     │                                       │  Generate session:userId:uuid
     │                                       │  Store in Redis (24h TTL)
     │  ◄──── { session_token, user_id }      │
     │                                       │
     │  All subsequent requests:              │
     │  Authorization: Bearer session:...     │
```

**Scopes:** `openid`, `email`, `profile`
**Session format:** `session:<userId>:<uuid>`

### Session Persistence

Sessions are stored in both Redis (fast lookup) and PostgreSQL (`user_sessions` table, 30-day TTL) for durability. Auth middleware checks Redis first; on cache miss, falls back to Postgres and restores the token to Redis. `last_used_at` is updated on Postgres validation.

---

## CORS Policy

Configured in `packages/backend/src/index.ts`.

| Origin | Purpose |
|--------|---------|
| `chrome-extension://*` | Extension requests |
| `http://localhost*` | Local development |
| `https://meet.google.com` | Content script on Meet pages |
| `https://teams.microsoft.com` | Teams meeting pages |
| `https://app.zoom.us` | Zoom meeting pages |

Credentials enabled for all allowed origins.

---

## Infrastructure & Deployment

| Component | Technology | Location |
|-----------|------------|----------|
| **Backend** | Node.js 20 + Express | Render (Virginia) |
| **Database** | PostgreSQL 16 | Render managed |
| **Cache** | Redis 7 | Render managed |
| **Extension** | Chrome Web Store | Client-side |
| **Container** | Docker multi-stage (Node 20-alpine) | Production builds |

**Local development:** `docker-compose.yml` runs PostgreSQL + Redis. Backend runs via `npm run dev:backend`. Extension built with esbuild via `npm run dev:extension`.

**Production build:** Multi-stage Dockerfile — builder stage installs deps and compiles TypeScript, production stage copies only built artifacts and production dependencies.

**Deployment:** Render auto-deploys from `main`. `render.yaml` defines the web service with build command `npm install && npm run build:shared && npm run build:law-registry && npm run build:backend && bash scripts/migrate.sh`.

---

## Extension Version History

| Version | Date | Changes |
|---------|------|---------|
| v1.0.0 | 2026-03-21 | Initial release: real-time coaching, 12 behavioral laws, DOM caption scraping, post-meeting reports |
| v1.0.1 | 2026-03-21 | Real Google OAuth, privacy policy page, Web Store preparation |
| v1.0.2 | 2026-03-21 | Brand icons from gleameet-logo.webp, stable extension key |
| v1.0.3 | 2026-03-21 | Silent auth on popup open, sign-in button as fallback |
| v1.0.4 | 2026-03-21 | Cloud deployment support, extension points to gleameet.onrender.com |
| v1.0.5 | 2026-03-22 | Richer recommendations with rationale, transcript saving |
| v1.0.6 | 2026-03-22 | Personalized live nudges via GPT-4o with transcript context (≤25 words) |
| v1.0.7 | 2026-03-22 | Nudges include specific why-rationale citing observed behavior |
| v1.0.8 | 2026-03-22 | Positive reinforcement: GPT-4o compliments every 5 positive signals |
| v1.0.9 | 2026-03-22 | Post-call report with annotated transcript + GPT-4o narrative summary |
| v1.0.10 | 2026-03-22 | Report view in popup with summary analysis |
| v1.0.11 | 2026-03-23 | Audio capture via getUserMedia in content script, Whisper transcription replacing caption scraping |
| v1.0.12 | 2026-03-23 | Nudge rate limit raised (20→60), fatigue penalty reduction, meet.google.com CORS fix |
| v1.0.13 | 2026-03-23 | Auto-reauth on 401 (session token expired due to Redis restart) |
| v1.0.14 | 2026-03-23 | Session persistence to PostgreSQL (`user_sessions` table, 30-day TTL, survives Redis restarts) |
| v1.0.15 | 2026-03-24 | Backfill `transcript_with_nudges` on report fetch for older meetings; delete meetings from history; timeline alignment fix |
| v1.0.16 | 2026-03-24 | Correct transcript timestamps; suppress Web Speech/captions when Whisper active; `prompt_type` constraint adds `reinforce` |
| v1.0.17 | 2026-03-24 | Expand `prompt_events` columns to TEXT (was VARCHAR(100) causing silent truncation) |
| v1.0.18 | 2026-03-25 | Teams and Zoom support (mic-only Whisper; Meet DOM scraping unchanged) |
| v1.0.19 | 2026-03-25 | Teams web meeting detection (URL-based + hash navigation polling); Whisper noise filtering; tab audio capture via MV3 offscreen document |
| v1.0.20 | 2026-03-25 | Silence extension context invalidated error on audio transcription |
| v1.0.21 | 2026-03-25 | Pause/resume coaching mid-meeting (`STOP_COACHING` pauses, `RESUME_COACHING` restarts, `END_MEETING` terminates + report) |
| v1.0.22 | 2026-03-25 | Widen popup, fix text overflow in history and report views |
| v1.0.23 | 2026-04-05 | Stabilize Teams/Zoom web support: explicit platform propagation, broader prompt/tab routing, and platform-aware capability handling for non-Meet web clients |
t web clients |
ients |
ts |
