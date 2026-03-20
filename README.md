# GleaMeet

Private real-time AI meeting coach. GleaMeet runs as a Chrome extension that observes your Google Meet sessions and provides live behavioral coaching prompts based on 12 behavioral science laws from Kahneman, Cialdini, and Thaler.

Coaching is **private to the user only** — no one else in the meeting can see the prompts.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Chrome Extension (Manifest V3)                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │Content Script│  │Service Worker│  │   Popup (React)    │  │
│  │- Meet detect │  │- Event batch │  │- Status display    │  │
│  │- DOM observe │  │  (3s cycle)  │  │- Coaching controls │  │
│  │- Prompt UI   │  │- Prompt poll │  │- Auth flow         │  │
│  │- Captions    │  │  (2s cycle)  │  │                    │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────────────┘  │
│         │                 │                                   │
└─────────┼─────────────────┼───────────────────────────────────┘
          │  chrome.runtime │  HTTP/JSON
          └─────────────────┼──────────────────────────────┐
                            ▼                              │
┌──────────────────────────────────────────────────────────┤
│  Express Backend (Node.js)                               │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐             │
│  │  Feature  │→ │   Law    │→ │Intervention│→ Prompt     │
│  │  Engine   │  │ Evaluator│  │  Engine    │  (≤1/batch) │
│  │(22 feats) │  │(12 laws) │  │ (ranking)  │             │
│  └──────────┘  └──────────┘  └────────────┘             │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐             │
│  │  Report   │  │Retention │  │ Metrics &  │             │
│  │ Generator │  │ Service  │  │  Logging   │             │
│  └──────────┘  └──────────┘  └────────────┘             │
└──────────────────────┬────────────────┬──────────────────┘
                       │                │
                ┌──────▼──────┐  ┌──────▼──────┐
                │  PostgreSQL │  │    Redis     │
                │  (persist)  │  │ (state/cool) │
                └─────────────┘  └─────────────┘
```

### Data Flow

1. Content script detects Google Meet, observes DOM for speech indicators and captions
2. Events buffered in service worker, flushed every 3 seconds to `POST /events/batch`
3. Backend pipeline per batch: validate → extract 22 features → evaluate 12 laws → rank prompts
4. At most 1 prompt returned per batch (FR-045); silence preferred over low confidence (SR-006)
5. Prompt displayed as overlay on Meet page; auto-dismissed after 15 seconds
6. On meeting end: post-meeting report generated with strengths, growth areas, timeline

## Local Development Setup

### Prerequisites

- Node.js 18+
- PostgreSQL 14+ and Redis 7+ — either via Docker **or** installed locally
- Chrome browser (for extension)
- (Recommended) [Ollama](https://ollama.com) for local LLM-powered report generation

### Quick Start (without Docker)

If you have Postgres and Redis running locally (e.g. via Homebrew, apt, or your OS package manager):

```bash
# 1. Clone and install
git clone <repo-url> && cd gleameet
npm install

# 2. Create the database and load the schema
createdb gleameet                           # or: psql -c "CREATE DATABASE gleameet;"
psql -d gleameet -f packages/backend/src/db/schema.sql

# 3. Configure environment
cp .env.example .env
# Edit .env if your local Postgres user/password differs from the defaults

# 4. Pull the default Ollama model (for LLM-powered reports)
ollama pull llama3.2

# 5. Build shared packages and start backend in dev mode
npm run build:shared && npm run build:law-registry
npm run dev:backend

# 6. Run tests
cd packages/backend && npm test
```

### Quick Start (with Docker)

```bash
# 1. Clone and install
git clone <repo-url> && cd gleameet
npm install

# 2. Start infrastructure
docker-compose up -d postgres redis

# 3. Configure environment
cp .env.example .env

# 4. Build shared packages and start backend in dev mode
npm run build:shared && npm run build:law-registry
npm run dev:backend

# 5. Run tests
cd packages/backend && npm test
```

> **Note:** When using Docker for Postgres, the schema is automatically loaded on first start via the `docker-entrypoint-initdb.d` mount.

### Full Docker Setup

```bash
# Build and start everything (backend + postgres + redis)
docker-compose up --build

# Backend available at http://localhost:3001
# Health check: http://localhost:3001/health
# Metrics: http://localhost:3001/metrics
```

### LLM Configuration

By default, GleaMeet uses a local [Ollama](https://ollama.com) instance for LLM-powered report generation (strengths, growth areas, recommendations). If Ollama is not running, the report generator falls back to rule-based output automatically.

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_BASE_URL` | `http://localhost:11434/v1` | LLM API base URL |
| `LLM_MODEL` | `llama3.2` | Model name |
| `LLM_API_KEY` | `ollama` | API key (Ollama ignores this) |

To use OpenAI or another provider instead, set these variables in your `.env`:

```bash
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=sk-your-key-here
```

## Deploy to Render (Cloud)

Deploy GleaMeet so the Chrome extension works for anyone — no local backend needed.

1. **Push to GitHub** — fork or push this repo to your GitHub account
2. **Create a Blueprint on Render** — go to [render.com](https://render.com) → **New** → **Blueprint** → connect your repo. Render reads the `render.yaml` and provisions the web service, Postgres, and Redis automatically
3. **Set LLM environment variables** — in the Render dashboard, open the `gleameet-backend` service → **Environment** → set:
   - `LLM_BASE_URL` = `https://api.openai.com/v1`
   - `LLM_MODEL` = `gpt-4o-mini`
   - `LLM_API_KEY` = your OpenAI API key
4. **Wait for the first deploy** to finish. Copy the service URL (e.g. `https://gleameet-backend.onrender.com`)
5. **Configure the extension** — load the extension in Chrome (see below), right-click the extension icon → **Options** → paste the Render URL → **Save**
6. **Done** — the extension now talks to your cloud backend

## Loading the Extension

1. Build the extension (or use source directly for development)
2. Open Chrome → `chrome://extensions/`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked" → select `packages/extension/public/`
5. Navigate to a Google Meet call
6. Click the GleaMeet popup → Sign In → Enable Coaching

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/session` | No | Create authenticated session |
| POST | `/meetings/start` | Yes | Start coached meeting |
| POST | `/meetings/end` | Yes | End meeting, generate report |
| DELETE | `/meetings/:id` | Yes | Delete meeting + all data |
| POST | `/events/batch` | Yes | Ingest event batch |
| GET | `/prompts/poll` | Yes | Poll for pending prompts |
| POST | `/prompts/ack` | Yes | Acknowledge prompt action |
| GET | `/reports/:id` | Yes | Fetch post-meeting report |
| GET | `/history` | Yes | List user's meetings |
| GET | `/registry/active` | Yes | Get active law definitions |
| DELETE | `/user/data` | Yes | Delete all user data |
| GET | `/health` | No | Health check (postgres + redis) |
| GET | `/metrics` | No | Prometheus-style metrics |

Auth: Bearer token from `/auth/session` in `Authorization` header.

## Law Registry Format

Laws are defined as JSON files in `packages/law-registry/laws/`. Each law follows this schema:

```json
{
  "law_id": "K-01",
  "version": "1.0.0",
  "status": "active",
  "source_family": "Kahneman",
  "law_name": "System 1 vs System 2",
  "description": "Detects rapid rebuttal under disagreement...",
  "meeting_relevance": "User may react too quickly under pressure.",
  "observable_inputs": ["disagreement_detected", "response_latency_seconds"],
  "trigger_type": "event",
  "trigger_logic": {
    "all": [
      {"feature": "disagreement_detected", "op": "eq", "value": true},
      {"feature": "response_latency_seconds", "op": "lt", "value": 1.5}
    ]
  },
  "disconfirming_logic": {
    "any": [
      {"feature": "acknowledgment_count", "op": "gt", "value": 0}
    ]
  },
  "prompt_templates_live": [
    {"type": "ask", "text": "Pause. Ask one question first."}
  ],
  "prompt_templates_post": ["You often moved quickly to rebuttal..."],
  "confidence_threshold": 0.72,
  "cooldown_seconds": 180,
  "risk_notes": ["Do not infer trait impulsivity."],
  "allowed_inferences": ["User may be reacting automatically..."]
}
```

### Active Laws

| ID | Family | Name | Trigger Type |
|----|--------|------|--------------|
| K-01 | Kahneman | System 1 vs System 2 | event |
| K-02 | Kahneman | Loss Aversion | rolling_window |
| K-03 | Kahneman | Anchoring | rolling_window |
| K-04 | Kahneman | Overconfidence | rolling_window |
| C-01 | Cialdini | Reciprocity | event |
| C-02 | Cialdini | Commitment/Consistency | rolling_window |
| C-03 | Cialdini | Social Proof | rolling_window |
| C-04 | Cialdini | Authority | rolling_window |
| T-01 | Thaler | Choice Architecture | rolling_window |
| T-02 | Thaler | Default Effect | rolling_window |
| T-03 | Thaler | Nudge | rolling_window |
| T-04 | Thaler | Present Bias | rolling_window |

## Feature Extractors (22 features)

**Timing**: speaking_time, speaking_share, continuous_speaking, turn_count, interruption_count, response_latency

**Engagement**: question_count, clarifying_question_count, summary_count, acknowledgment_count

**Linguistic** (rule-based classifiers, 0-1 scores): hedging_language, certainty_language, loss_frame, gain_frame, action_specificity

**Structural** (boolean/count): option_count, default_recommendation, owner_assignment, deadline, evidence_reference, peer_example, shared_goal_language, disagreement_detected

## Data Retention

| Data Type | Default Retention | Configurable |
|-----------|-------------------|--------------|
| Raw transcript events | 7 days | Yes |
| Derived features | 30 days | Yes |
| Prompt records | 90 days | Yes |
| Reports | 365 days | Yes |

Background cleanup runs every 6 hours. Users can delete individual meetings or all data at any time.

## Project Structure

```
packages/
├── shared/          # TypeScript types, API contracts, constants
├── law-registry/    # 12 behavioral law definitions (JSON)
├── backend/         # Express API server
│   ├── src/
│   │   ├── db/          # Postgres pool, Redis client, queries
│   │   ├── features/    # Feature extraction engine (22 classifiers)
│   │   ├── law-engine/  # Law evaluation against features
│   │   ├── intervention/# Prompt ranking and selection
│   │   ├── services/    # Report generator, retention, metrics
│   │   ├── middleware/  # Auth, error handling, logging
│   │   └── routes/      # API route handlers
│   └── tests/           # Jest test suites (61 tests)
└── extension/       # Chrome Manifest V3 extension
    ├── public/      # Manifest, HTML, CSS
    └── src/
        ├── background/  # Service worker (batching, polling)
        ├── content/     # Content script (Meet detection, overlay)
        ├── popup/       # React popup UI
        └── utils/       # API client, event factory
```
