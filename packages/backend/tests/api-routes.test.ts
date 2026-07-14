import request from 'supertest';
import express from 'express';
import { authRouter } from '../src/routes/auth';
import { meetingsRouter } from '../src/routes/meetings';
import { eventsRouter } from '../src/routes/events';
import { promptsRouter, enqueuePendingPrompt } from '../src/routes/prompts';
import { registryRouter } from '../src/routes/registry';
import { historyRouter } from '../src/routes/history';
import { reportsRouter } from '../src/routes/reports';
import { authMiddleware } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/error-handler';

// Mock all database modules
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
  getMeetingState: jest.fn().mockResolvedValue(null),
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
  upsertUser: jest.fn().mockResolvedValue('test-user-id'),
  getUserByGoogleSubject: jest.fn().mockResolvedValue(null),
  insertMeetingSession: jest.fn().mockResolvedValue(undefined),
  insertConsentRecord: jest.fn().mockResolvedValue('consent-id'),
  endMeetingSession: jest.fn().mockResolvedValue(undefined),
  insertRawEvents: jest.fn().mockResolvedValue(undefined),
  insertLawTrigger: jest.fn().mockResolvedValue(undefined),
  insertPromptEvent: jest.fn().mockResolvedValue(undefined),
  insertReport: jest.fn().mockResolvedValue(undefined),
  getLawTriggersForSession: jest.fn().mockResolvedValue([]),
  getPromptsForSession: jest.fn().mockResolvedValue([]),
  getReport: jest.fn().mockResolvedValue(null),
  getUserMeetings: jest.fn().mockResolvedValue([]),
  updatePromptDisplayState: jest.fn().mockResolvedValue(undefined),
  deleteMeetingData: jest.fn().mockResolvedValue('audit-id'),
  deleteAllUserData: jest.fn().mockResolvedValue('audit-id'),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use('/meetings', authMiddleware, meetingsRouter);
  app.use('/events', authMiddleware, eventsRouter);
  app.use('/prompts', authMiddleware, promptsRouter);
  app.use('/registry', authMiddleware, registryRouter);
  app.use('/history', authMiddleware, historyRouter);
  app.use('/reports', authMiddleware, reportsRouter);
  app.use(errorHandler);
  return app;
}

const TOKEN = 'session:test-user-id:abc123';

describe('API Routes', () => {
  let app: express.Express;

  beforeAll(() => {
    app = createApp();
  });

  describe('POST /auth/session', () => {
    test('returns 400 without google_id_token', async () => {
      const res = await request(app).post('/auth/session').send({});
      expect(res.status).toBe(400);
    });

    test('returns session token with valid token', async () => {
      const res = await request(app)
        .post('/auth/session')
        .send({ google_id_token: 'mock-google-token' });
      expect(res.status).toBe(200);
      expect(res.body.session_token).toBeDefined();
      expect(res.body.user_id).toBeDefined();
      expect(res.body.preferences).toBeDefined();
    });
  });

  describe('POST /meetings/start', () => {
    test('returns 401 without auth', async () => {
      const res = await request(app).post('/meetings/start').send({});
      expect(res.status).toBe(401);
    });

    test('returns 400 without required fields', async () => {
      const res = await request(app)
        .post('/meetings/start')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({});
      expect(res.status).toBe(400);
    });

    test('creates meeting session', async () => {
      const res = await request(app)
        .post('/meetings/start')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({
          platform: 'google_meet',
          extension_version: '1.0.0',
          consent: {
            consent_version: '1.0',
            scope: {
              capture_audio_events: true,
              capture_transcript: true,
              capture_timing: true,
              live_coaching: true,
              post_meeting_report: true,
            },
          },
        });
      expect(res.status).toBe(201);
      expect(res.body.meeting_session_id).toBeDefined();
      expect(res.body.session_config).toBeDefined();
      expect(res.body.active_laws).toBeInstanceOf(Array);
    });
  });

  describe('POST /events/batch', () => {
    test('returns 400 without meeting_session_id', async () => {
      const res = await request(app)
        .post('/events/batch')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({});
      expect(res.status).toBe(400);
    });

    test('returns 404 for unknown session', async () => {
      const res = await request(app)
        .post('/events/batch')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ meeting_session_id: 'unknown', events: [] });
      expect(res.status).toBe(404);
    });

    test('processes events for active session', async () => {
      const { getMeetingState } = require('../src/db/redis');
      (getMeetingState as jest.Mock).mockResolvedValue({
        meeting_session_id: 'sess-1',
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
      });

      const res = await request(app)
        .post('/events/batch')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({
          meeting_session_id: 'sess-1',
          events: [
            {
              event_id: 'e1',
              meeting_session_id: 'sess-1',
              user_id: 'test-user-id',
              platform: 'google_meet',
              event_type: 'transcript_segment',
              event_time_utc: new Date().toISOString(),
              source: 'extension',
              capture_confidence: 0.9,
              payload: { text: 'Hello everyone', speaker: 'user' },
            },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.accepted_count).toBe(1);
    });
  });

  describe('GET /prompts/poll', () => {
    test('returns 400 without meeting_session_id', async () => {
      const res = await request(app)
        .get('/prompts/poll')
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(res.status).toBe(400);
    });

    test('returns empty prompts for session with none', async () => {
      const res = await request(app)
        .get('/prompts/poll?meeting_session_id=sess-1')
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.prompts).toEqual([]);
    });

    test('leases enqueued prompts until acknowledged', async () => {
      const dateNowSpy = jest.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(1000);

      enqueuePendingPrompt('sess-poll-test', {
        prompt_id: 'p1',
        short_text: 'Test prompt',
        law_id: 'K-01',
      });

      const res = await request(app)
        .get('/prompts/poll?meeting_session_id=sess-poll-test')
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.prompts.length).toBe(1);
      expect(res.body.prompts[0].prompt_id).toBe('p1');

      // Second poll inside the delivery lease should be empty.
      const res2 = await request(app)
        .get('/prompts/poll?meeting_session_id=sess-poll-test')
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(res2.body.prompts).toEqual([]);

      // If the frontend never acks display, the prompt becomes deliverable again.
      dateNowSpy.mockReturnValue(10000);
      const res3 = await request(app)
        .get('/prompts/poll?meeting_session_id=sess-poll-test')
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(res3.status).toBe(200);
      expect(res3.body.prompts.length).toBe(1);
      expect(res3.body.prompts[0].prompt_id).toBe('p1');

      dateNowSpy.mockRestore();
    });
  });

  describe('POST /prompts/ack', () => {
    test('returns 400 without required fields', async () => {
      const res = await request(app)
        .post('/prompts/ack')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({});
      expect(res.status).toBe(400);
    });

    test('acknowledges prompt successfully', async () => {
      enqueuePendingPrompt('sess-ack-test', {
        prompt_id: 'p-ack',
        short_text: 'Ack prompt',
        law_id: 'K-01',
      });

      const res = await request(app)
        .post('/prompts/ack')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({
          prompt_id: 'p-ack',
          meeting_session_id: 'sess-ack-test',
          action: 'dismissed',
          timestamp: new Date().toISOString(),
        });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const poll = await request(app)
        .get('/prompts/poll?meeting_session_id=sess-ack-test')
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(poll.body.prompts).toEqual([]);
    });
  });

  describe('GET /registry/active', () => {
    test('returns active laws', async () => {
      const res = await request(app)
        .get('/registry/active')
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.laws).toBeInstanceOf(Array);
      expect(res.body.laws.length).toBe(12);
      expect(res.body.registry_version).toBeDefined();
    });
  });

  describe('GET /history', () => {
    test('returns empty meeting list', async () => {
      const res = await request(app)
        .get('/history')
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.meetings).toEqual([]);
    });
  });

  describe('GET /reports/:meeting_session_id', () => {
    test('returns 404 when no report exists', async () => {
      const res = await request(app)
        .get('/reports/unknown-session')
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(res.status).toBe(404);
    });
  });

  describe('Auth middleware', () => {
    test('rejects requests without Authorization header', async () => {
      const res = await request(app).get('/history');
      expect(res.status).toBe(401);
    });

    test('rejects invalid token format', async () => {
      const res = await request(app)
        .get('/history')
        .set('Authorization', 'Bearer invalid-token');
      expect(res.status).toBe(401);
    });

    test('accepts valid session token', async () => {
      const res = await request(app)
        .get('/history')
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(res.status).toBe(200);
    });
  });
});
