import { processEvents, PATTERNS } from '../src/features/feature-engine';
import { MeetingState } from '../src/db/redis';
import { RawEvent } from '@gleameet/shared';

function createMeetingState(overrides: Partial<MeetingState> = {}): MeetingState {
  return {
    meeting_session_id: 'test-session',
    user_id: 'test-user',
    status: 'active',
    started_at: new Date(Date.now() - 60000).toISOString(),
    speaking_time_total_ms: 0,
    other_speaking_time_total_ms: 0,
    turn_count: 0,
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
    events_ingested: 0,
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
    ...overrides,
  };
}

function makeTranscriptEvent(text: string, time?: string): RawEvent {
  return {
    event_id: `evt-${Math.random().toString(36).slice(2)}`,
    meeting_session_id: 'test-session',
    user_id: 'test-user',
    platform: 'google_meet',
    event_type: 'transcript_segment',
    event_time_utc: time || new Date().toISOString(),
    source: 'extension',
    capture_confidence: 0.9,
    payload: { text, speaker: 'user', start_offset_ms: 0, end_offset_ms: 100 },
  };
}

describe('Feature Engine - Linguistic Classifiers', () => {
  describe('hedging_language_score', () => {
    test('detects hedging words', async () => {
      const state = createMeetingState();
      const events = [
        makeTranscriptEvent('I think maybe we should consider this'),
        makeTranscriptEvent('Perhaps we could try a different approach'),
        makeTranscriptEvent('I\'m not sure about the timeline'),
      ];
      const features = await processEvents(events, state);
      expect(features.hedging_language_score).toBeGreaterThan(0);
      expect(state.hedging_hits).toBe(3);
    });

    test('no hedging in direct speech', async () => {
      const state = createMeetingState();
      const events = [makeTranscriptEvent('We will ship this by Friday')];
      const features = await processEvents(events, state);
      expect(features.hedging_language_score).toBe(0);
    });
  });

  describe('certainty_language_score', () => {
    test('detects certainty language', async () => {
      const state = createMeetingState();
      const events = [
        makeTranscriptEvent('I definitely think this is the right call'),
        makeTranscriptEvent('Absolutely, we should proceed'),
        makeTranscriptEvent('I am certain this will work'),
      ];
      const features = await processEvents(events, state);
      expect(features.certainty_language_score).toBeGreaterThan(0);
      expect(state.certainty_hits).toBe(3);
    });
  });

  describe('loss_frame_score', () => {
    test('detects loss/risk language', async () => {
      const state = createMeetingState();
      const events = [
        makeTranscriptEvent('The risk here is that we could lose market share'),
        makeTranscriptEvent('The downside is significant cost'),
        makeTranscriptEvent('This could be a failure if we miss the deadline'),
      ];
      const features = await processEvents(events, state);
      expect(features.loss_frame_score).toBeGreaterThan(0);
      expect(state.loss_frame_hits).toBeGreaterThanOrEqual(3);
    });
  });

  describe('gain_frame_score', () => {
    test('detects opportunity/upside language', async () => {
      const state = createMeetingState();
      const events = [
        makeTranscriptEvent('This is a great opportunity for growth'),
        makeTranscriptEvent('The benefit is clear: more revenue'),
        makeTranscriptEvent('We could win significant advantage here'),
      ];
      const features = await processEvents(events, state);
      expect(features.gain_frame_score).toBeGreaterThan(0);
      expect(state.gain_frame_hits).toBeGreaterThanOrEqual(3);
    });
  });

  describe('action_specificity_score', () => {
    test('detects owner + verb patterns', async () => {
      const state = createMeetingState();
      const events = [
        makeTranscriptEvent('I will complete the report by Friday'),
        makeTranscriptEvent('John should handle the client outreach'),
      ];
      const features = await processEvents(events, state);
      expect(features.action_specificity_score).toBeGreaterThan(0);
    });
  });

  describe('acknowledgment_count', () => {
    test('detects acknowledgment phrases', async () => {
      const state = createMeetingState();
      const events = [
        makeTranscriptEvent('I understand your concern'),
        makeTranscriptEvent('That\'s a fair point'),
        makeTranscriptEvent('Makes sense, let me think about that'),
      ];
      await processEvents(events, state);
      expect(state.acknowledgment_count).toBe(3);
    });
  });

  describe('question_count and clarifying_question_count', () => {
    test('detects questions by "?"', async () => {
      const state = createMeetingState();
      const events = [
        makeTranscriptEvent('What do you think about this?'),
        makeTranscriptEvent('How should we proceed?'),
      ];
      await processEvents(events, state);
      expect(state.question_count).toBe(2);
    });

    test('detects clarifying questions', async () => {
      const state = createMeetingState();
      const events = [
        makeTranscriptEvent('What do you mean by that?'),
        makeTranscriptEvent('Could you explain the timeline?'),
        makeTranscriptEvent('Just to be clear, are we aligned?'),
      ];
      await processEvents(events, state);
      expect(state.clarifying_question_count).toBeGreaterThanOrEqual(2);
    });
  });

  describe('disagreement_detected', () => {
    test('detects disagreement markers', async () => {
      const state = createMeetingState();
      const events = [
        makeTranscriptEvent('However, I disagree with that assessment'),
      ];
      const features = await processEvents(events, state);
      expect(features.disagreement_detected).toBe(true);
    });

    test('disagreement is sticky', async () => {
      const state = createMeetingState();
      await processEvents([makeTranscriptEvent('I disagree')], state);
      expect(state.disagreement_detected).toBe(true);
      // Even neutral text doesn't reset it
      await processEvents([makeTranscriptEvent('Let us continue')], state);
      expect(state.disagreement_detected).toBe(true);
    });
  });

  describe('option_count_presented', () => {
    test('detects option presentation', async () => {
      const state = createMeetingState();
      const events = [
        makeTranscriptEvent('We have option A and option B'),
        makeTranscriptEvent('Alternatively, we could take a different approach'),
      ];
      await processEvents(events, state);
      expect(state.option_count_presented).toBeGreaterThanOrEqual(2);
    });
  });

  describe('default_recommendation_present', () => {
    test('detects recommendations', async () => {
      const state = createMeetingState();
      const events = [makeTranscriptEvent('I recommend we go with plan B')];
      const features = await processEvents(events, state);
      expect(features.default_recommendation_present).toBe(true);
    });
  });

  describe('owner_assignment_present', () => {
    test('detects owner assignments', async () => {
      const state = createMeetingState();
      const events = [makeTranscriptEvent('Sarah will handle the design review')];
      const features = await processEvents(events, state);
      expect(features.owner_assignment_present).toBe(true);
    });
  });

  describe('deadline_present', () => {
    test('detects deadline language', async () => {
      const state = createMeetingState();
      const events = [makeTranscriptEvent('This needs to be done by Friday')];
      const features = await processEvents(events, state);
      expect(features.deadline_present).toBe(true);
    });

    test('detects date formats', async () => {
      const state = createMeetingState();
      const events = [makeTranscriptEvent('Target date is March 15')];
      const features = await processEvents(events, state);
      expect(features.deadline_present).toBe(true);
    });
  });

  describe('evidence_reference_present', () => {
    test('detects evidence references', async () => {
      const state = createMeetingState();
      const events = [makeTranscriptEvent('According to the data, users prefer mobile')];
      const features = await processEvents(events, state);
      expect(features.evidence_reference_present).toBe(true);
    });
  });

  describe('peer_example_present', () => {
    test('detects peer examples', async () => {
      const state = createMeetingState();
      const events = [makeTranscriptEvent('This is similar to what Google does with their onboarding')];
      const features = await processEvents(events, state);
      expect(features.peer_example_present).toBe(true);
    });
  });

  describe('shared_goal_language_present', () => {
    test('detects shared goal language', async () => {
      const state = createMeetingState();
      const events = [makeTranscriptEvent('We all want to hit our Q2 targets')];
      const features = await processEvents(events, state);
      expect(features.shared_goal_language_present).toBe(true);
    });
  });

  describe('summary_or_recap_count', () => {
    test('detects summary language', async () => {
      const state = createMeetingState();
      const events = [
        makeTranscriptEvent('To summarize, we agreed on three priorities'),
        makeTranscriptEvent('Let me recap what we decided'),
      ];
      await processEvents(events, state);
      expect(state.summary_or_recap_count).toBe(2);
    });
  });
});

describe('Feature Engine - Timing Features', () => {
  test('tracks speaking time from speech events', async () => {
    const state = createMeetingState();
    const now = Date.now();
    const events: RawEvent[] = [
      {
        event_id: 'e1', meeting_session_id: 'test-session', user_id: 'test-user',
        platform: 'google_meet', event_type: 'speech_started',
        event_time_utc: new Date(now - 5000).toISOString(),
        source: 'extension', capture_confidence: 0.9,
        payload: { speaker: 'user' },
      },
      {
        event_id: 'e2', meeting_session_id: 'test-session', user_id: 'test-user',
        platform: 'google_meet', event_type: 'speech_ended',
        event_time_utc: new Date(now - 2000).toISOString(),
        source: 'extension', capture_confidence: 0.9,
        payload: { speaker: 'user' },
      },
    ];
    const features = await processEvents(events, state);
    expect(features.speaking_time_total_seconds).toBeCloseTo(3, 0);
  });

  test('tracks turn count', async () => {
    const state = createMeetingState();
    const events: RawEvent[] = [
      {
        event_id: 'e1', meeting_session_id: 'test-session', user_id: 'test-user',
        platform: 'google_meet', event_type: 'turn_change',
        event_time_utc: new Date().toISOString(),
        source: 'extension', capture_confidence: null,
        payload: { from_speaker: 'user', to_speaker: 'other', gap_ms: 200 },
      },
      {
        event_id: 'e2', meeting_session_id: 'test-session', user_id: 'test-user',
        platform: 'google_meet', event_type: 'turn_change',
        event_time_utc: new Date().toISOString(),
        source: 'extension', capture_confidence: null,
        payload: { from_speaker: 'other', to_speaker: 'user', gap_ms: 500 },
      },
    ];
    const features = await processEvents(events, state);
    expect(features.turn_count).toBe(2);
  });

  test('tracks interruption count', async () => {
    const state = createMeetingState();
    const events: RawEvent[] = [
      {
        event_id: 'e1', meeting_session_id: 'test-session', user_id: 'test-user',
        platform: 'google_meet', event_type: 'interruption_candidate',
        event_time_utc: new Date().toISOString(),
        source: 'extension', capture_confidence: 0.8,
        payload: {},
      },
    ];
    const features = await processEvents(events, state);
    expect(features.interruption_count).toBe(1);
  });
});
