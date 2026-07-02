import request from 'supertest';
import express from 'express';
import { eventsRouter } from '../src/routes/events';
import { authMiddleware } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/error-handler';

// Mock all database modules (mirrors api-routes.test.ts)
jest.mock('../src/db/pool', () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: jest.fn(),
    }),
  },
}));

jest.mock('../src/db/redis', () => ({
  redis: {
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
    keys: jest.fn().mockResolvedValue([]),
    ping: jest.fn().mockResolvedValue('PONG'),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
  },
  initMeetingState: jest.fn().mockResolvedValue(undefined),
  getMeetingState: jest.fn(),
  updateMeetingState: jest.fn().mockResolvedValue(undefined),
  isLawOnCooldown: jest.fn().mockResolvedValue(false),
  setLawCooldown: jest.fn().mockResolvedValue(undefined),
  isGlobalCooldownActive: jest.fn().mockResolvedValue(false),
  setGlobalCooldown: jest.fn().mockResolvedValue(undefined),
  incrementPromptCount: jest.fn().mockResolvedValue(1),
  getPromptCount: jest.fn().mockResolvedValue(0),
  isUserSpeaking: jest.fn().mockResolvedValue(false),
  setUserSpeaking: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/db/queries', () => ({
  insertRawEvents: jest.fn().mockResolvedValue(undefined),
  insertLawTrigger: jest.fn().mockResolvedValue(undefined),
  insertPromptEvent: jest.fn().mockResolvedValue(undefined),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/events', authMiddleware, eventsRouter);
  app.use(errorHandler);
  return app;
}

const TOKEN = 'session:test-user-id:abc123';

describe('Zoom spike: /events/batch ingestion proof point (Piece 0)', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    const { redis } = require('../src/db/redis');
    (redis.get as jest.Mock).mockResolvedValue('test-user-id');
    app = createApp();
  });

  function activeState(overrides: Record<string, unknown> = {}) {
    return {
      meeting_session_id: 'zoom-sess-1',
      user_id: 'test-user-id',
      status: 'active',
      started_at: new Date().toISOString(),
      speaking_time_total_ms: 0,
      other_speaking_time_total_ms: 0,
      turn_count: 0, interruption_count: 0,
      question_count: 0, clarifying_question_count: 0,
      summary_or_recap_count: 0, acknowledgment_count: 0,
      last_speech_start_ms: null, last_turn_change_ms: null,
      user_is_speaking: false, prompts_shown_count: 0,
      last_prompt_shown_at: null, last_reinforcement_behavior_count: 0, events_ingested: 0,
      hedging_hits: 0, certainty_hits: 0, loss_frame_hits: 0,
      gain_frame_hits: 0, action_specificity_hits: 0,
      transcript_segment_count: 0, disagreement_detected: false,
      option_count_presented: 0, default_recommendation_present: false,
      owner_assignment_present: false, deadline_present: false,
      evidence_reference_present: false, peer_example_present: false,
      shared_goal_language_present: false,
      law_trigger_ids: [], prompt_ids: [], recent_transcript: [],
      ...overrides,
    };
  }

  test('accepts a zoom-platform transcript event and persists it via insertRawEvents', async () => {
    const { getMeetingState } = require('../src/db/redis');
    const { insertRawEvents } = require('../src/db/queries');
    (getMeetingState as jest.Mock).mockResolvedValue(activeState());

    const zoomEvent = {
      event_id: 'zoom-e1',
      meeting_session_id: 'zoom-sess-1',
      user_id: 'test-user-id',
      platform: 'zoom',
      event_type: 'transcript_segment',
      event_time_utc: new Date().toISOString(),
      source: 'adapter',
      capture_confidence: 0.6,
      payload: { text: 'Testing zoom capture spike', speaker: 'user' },
    };

    const res = await request(app)
      .post('/events/batch')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ meeting_session_id: 'zoom-sess-1', events: [zoomEvent] });

    expect(res.status).toBe(200);
    expect(res.body.accepted_count).toBe(1);
    expect(res.body.errors).toEqual([]);

    expect(insertRawEvents).toHaveBeenCalledTimes(1);
    const persisted = (insertRawEvents as jest.Mock).mock.calls[0][0];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      event_id: 'zoom-e1',
      platform: 'zoom',
      event_type: 'transcript_segment',
      source: 'adapter',
    });
  });

  test('rejects a zoom event missing required fields (platform-agnostic validation)', async () => {
    const { getMeetingState } = require('../src/db/redis');
    (getMeetingState as jest.Mock).mockResolvedValue(activeState());

    const res = await request(app)
      .post('/events/batch')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        meeting_session_id: 'zoom-sess-1',
        events: [{ event_id: 'zoom-e2', platform: 'zoom', event_type: 'transcript_segment' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.accepted_count).toBe(0);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].event_id).toBe('zoom-e2');
  });
});
