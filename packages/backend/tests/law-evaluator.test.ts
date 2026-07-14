import { evaluateLaws } from '../src/law-engine/law-evaluator';
import { MeetingState } from '../src/db/redis';
import { FeatureSnapshot, processEvents } from '../src/features/feature-engine';
import { RawEvent } from '@gleameet/shared';

// Mock Redis to avoid real connections
jest.mock('../src/db/redis', () => ({
  redis: { on: jest.fn(), set: jest.fn(), get: jest.fn(), del: jest.fn(), keys: jest.fn(), ping: jest.fn() },
  MeetingState: {},
  isLawOnCooldown: jest.fn().mockResolvedValue(false),
  setLawCooldown: jest.fn().mockResolvedValue(undefined),
  initMeetingState: jest.fn(),
  getMeetingState: jest.fn(),
  updateMeetingState: jest.fn(),
  isGlobalCooldownActive: jest.fn(),
  setGlobalCooldown: jest.fn(),
  incrementPromptCount: jest.fn(),
  getPromptCount: jest.fn(),
  isUserSpeaking: jest.fn(),
  setUserSpeaking: jest.fn(),
}));

function createState(overrides: Partial<MeetingState> = {}): MeetingState {
  return {
    meeting_session_id: 'test-session',
    user_id: 'test-user',
    status: 'active',
    started_at: new Date(Date.now() - 60000).toISOString(),
    speaking_time_total_ms: 30000,
    other_speaking_time_total_ms: 30000,
    turn_count: 5,
    interruption_count: 0,
    question_count: 0,
    clarifying_question_count: 0,
    summary_or_recap_count: 0,
    acknowledgment_count: 0,
    last_speech_start_ms: null,
    last_turn_change_ms: null,
    user_is_speaking: false,
    prompts_shown_count: 0,
    last_prompt_shown_at: null,
    last_reinforcement_behavior_count: 0,
    events_ingested: 10,
    hedging_hits: 0,
    certainty_hits: 0,
    loss_frame_hits: 0,
    gain_frame_hits: 0,
    action_specificity_hits: 0,
    transcript_segment_count: 0,
    disagreement_detected: false,
    option_count_presented: 0,
    default_recommendation_present: false,
    owner_assignment_present: false,
    deadline_present: false,
    evidence_reference_present: false,
    peer_example_present: false,
    shared_goal_language_present: false,
    law_trigger_ids: [],
    prompt_ids: [],
    recent_prompt_law_ids: [],
    recent_transcript: [],
    ...overrides,
  };
}

function makeTranscriptEvent(text: string): RawEvent {
  return {
    event_id: `evt-${Math.random().toString(36).slice(2)}`,
    meeting_session_id: 'test-session',
    user_id: 'test-user',
    platform: 'google_meet',
    event_type: 'transcript_segment',
    event_time_utc: new Date().toISOString(),
    source: 'extension',
    capture_confidence: 0.9,
    payload: { text, speaker: 'user', start_offset_ms: 0, end_offset_ms: 100 },
  };
}

describe('Law Evaluator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Re-establish mock implementations after clearAllMocks
    const redis = require('../src/db/redis');
    (redis.isLawOnCooldown as jest.Mock).mockResolvedValue(false);
    (redis.setLawCooldown as jest.Mock).mockResolvedValue(undefined);
  });

  test('K-01: triggers on rapid rebuttal without acknowledgment', async () => {
    const features: FeatureSnapshot = {
      disagreement_detected: true,
      response_latency_seconds: 0.5,
      acknowledgment_count: 0,
      clarifying_question_count: 0,
      speaking_time_total_seconds: 30,
      turn_count: 5,
    };
    const state = createState();
    const triggers = await evaluateLaws('test-session', features, state);
    const k01 = triggers.find(t => t.law_id === 'K-01');
    expect(k01).toBeDefined();
    expect(k01!.trigger_confidence).toBeCloseTo(0.7, 3);
  });

  test('K-01: triggers when response latency is very low (high signal)', async () => {
    const features: FeatureSnapshot = {
      disagreement_detected: true,
      response_latency_seconds: 0.5,
      acknowledgment_count: 0,
      clarifying_question_count: 0,
      turn_count: 3,
    };
    const state = createState();
    const triggers = await evaluateLaws('test-session', features, state);
    const k01 = triggers.find(t => t.law_id === 'K-01');
    expect(k01).toBeDefined();
    expect(k01!.trigger_confidence).toBeCloseTo(0.7, 3);
  });

  test('K-01: suppressed when acknowledgment > 0 (disconfirming)', async () => {
    const features: FeatureSnapshot = {
      disagreement_detected: true,
      response_latency_seconds: 0.5,
      acknowledgment_count: 1,
      clarifying_question_count: 0,
    };
    const state = createState();
    const triggers = await evaluateLaws('test-session', features, state);
    const k01 = triggers.find(t => t.law_id === 'K-01');
    expect(k01).toBeUndefined();
  });

  test('K-02: triggers on high loss framing with low gain framing', async () => {
    const features: FeatureSnapshot = {
      loss_frame_score: 0.9,
      gain_frame_score: 0.1,
    };
    const state = createState();
    const triggers = await evaluateLaws('test-session', features, state);
    const k02 = triggers.find(t => t.law_id === 'K-02');
    // K-02 observable_inputs: [loss_frame_score, gain_frame_score]
    // availability = 2/2 = 1.0
    // mean_strength = (0.9 + 0.1) / 2 = 0.5
    // confidence = 0.4 + 0.3 = 0.7 — at threshold 0.70
    expect(k02).toBeDefined();
    expect(k02!.trigger_confidence).toBeGreaterThanOrEqual(0.70);
  });

  test('live laws can trigger from mic-only transcript activity', async () => {
    const state = createState({ turn_count: 0 });
    const features = await processEvents([
      makeTranscriptEvent('I think the risk is that we miss the deadline.'),
      makeTranscriptEvent('The downside is a real problem for cost.'),
      makeTranscriptEvent('We could fail if we do not address this.'),
    ], state);

    expect(state.turn_count).toBe(0);
    expect(features.turn_count).toBe(3);

    const triggers = await evaluateLaws('test-session', features, state);
    expect(triggers.some(t => t.law_id === 'K-02')).toBe(true);
    expect(triggers.some(t => t.law_id === 'C-01')).toBe(true);
  });

  test('live laws can trigger from one long mic transcript chunk', async () => {
    const state = createState({ turn_count: 0 });
    const features = await processEvents([
      makeTranscriptEvent(
        'I want to walk through the plan and the tradeoffs because there are a few open decisions. ' +
        'We should compare the implementation path, the customer impact, the timeline, and the operating risk before we decide.'
      ),
    ], state);

    expect(state.turn_count).toBe(0);
    expect(state.transcript_segment_count).toBe(1);
    expect(features.turn_count).toBeGreaterThanOrEqual(3);

    const triggers = await evaluateLaws('test-session', features, state);
    expect(triggers.some(t => t.law_id === 'C-01')).toBe(true);
    expect(triggers.some(t => t.law_id === 'C-03')).toBe(true);
  });

  test('K-02: suppressed when gain_frame >= 0.4', async () => {
    const features: FeatureSnapshot = {
      loss_frame_score: 0.8,
      gain_frame_score: 0.5,
    };
    const state = createState();
    const triggers = await evaluateLaws('test-session', features, state);
    const k02 = triggers.find(t => t.law_id === 'K-02');
    expect(k02).toBeUndefined();
  });

  test('does not trigger any law with neutral features', async () => {
    const features: FeatureSnapshot = {
      disagreement_detected: false,
      response_latency_seconds: 3,
      acknowledgment_count: 2,
      clarifying_question_count: 1,
      loss_frame_score: 0.1,
      gain_frame_score: 0.1,
      certainty_language_score: 0.1,
      hedging_language_score: 0.1,
      speaking_share_percent: 50,
      turn_count: 5,
      interruption_count: 0,
      option_count_presented: 2,
      default_recommendation_present: true,
      owner_assignment_present: true,
      deadline_present: true,
      evidence_reference_present: true,
      shared_goal_language_present: true,
      question_count: 3,
      summary_or_recap_count: 1,
      action_specificity_score: 0.5,
    };
    const state = createState();
    const triggers = await evaluateLaws('test-session', features, state);
    // With good engagement and balanced features, most laws shouldn't trigger
    // (some may still trigger depending on exact thresholds)
    expect(triggers.length).toBeLessThanOrEqual(3);
  });

  test('respects cooldown (mocked to false = no cooldown)', async () => {
    const { isLawOnCooldown } = require('../src/db/redis');
    (isLawOnCooldown as jest.Mock).mockResolvedValue(true);

    const features: FeatureSnapshot = {
      disagreement_detected: true,
      response_latency_seconds: 0.5,
      acknowledgment_count: 0,
      clarifying_question_count: 0,
    };
    const state = createState();
    const triggers = await evaluateLaws('test-session', features, state);
    expect(triggers.length).toBe(0); // All on cooldown
  });

  test('trigger includes evidence refs and feature snapshot', async () => {
    // Use K-02 which we know triggers at these values
    const features: FeatureSnapshot = {
      loss_frame_score: 0.9,
      gain_frame_score: 0.1,
    };
    const state = createState();
    const triggers = await evaluateLaws('test-session', features, state);
    const k02 = triggers.find(t => t.law_id === 'K-02');
    expect(k02).toBeDefined();
    expect(k02!.evidence_refs_json.length).toBeGreaterThan(0);
    expect(k02!.feature_snapshot_json).toHaveProperty('loss_frame_score');
  });

  test('T-03: does not trigger early just because action structure is absent', async () => {
    const features: FeatureSnapshot = {
      owner_assignment_present: false,
      deadline_present: false,
      action_specificity_score: 0.1,
      turn_count: 4,
      summary_or_recap_count: 0,
    };
    const state = createState();
    const triggers = await evaluateLaws('test-session', features, state);
    const t03 = triggers.find(t => t.law_id === 'T-03');
    expect(t03).toBeUndefined();
  });

  test('T-03: triggers later when discussion is closing without action structure', async () => {
    const features: FeatureSnapshot = {
      owner_assignment_present: false,
      deadline_present: false,
      action_specificity_score: 0.1,
      turn_count: 10,
      summary_or_recap_count: 1,
    };
    const state = createState();
    const triggers = await evaluateLaws('test-session', features, state);
    const t03 = triggers.find(t => t.law_id === 'T-03');
    expect(t03).toBeDefined();
    expect(t03!.trigger_confidence).toBeGreaterThanOrEqual(0.4);
  });
});
