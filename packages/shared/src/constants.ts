import { CoachingIntensity } from './models';

/** Maximum prompt rates per 30 minutes by intensity (FR-047/FR-048) */
export const MAX_PROMPTS_PER_30_MIN: Record<CoachingIntensity, number> = {
  'minimal': 10,
  'standard': 20,
  'high-support': 40,
};

/** Rolling window durations in seconds (FR-028) */
export const ROLLING_WINDOWS = {
  SHORT: 30,
  MEDIUM: 90,
  FULL: Infinity, // full meeting to date
} as const;

/** Prompt text limits */
export const PROMPT_LIMITS = {
  BODY_MAX_WORDS: 25,      // FR-058 (extended for richer nudges)
  RATIONALE_MAX_WORDS: 10, // FR-059
  EXAMPLE_MAX_WORDS: 20,   // FR-060
} as const;

/** Prompt ranking weights (section 26) */
export const RANKING_WEIGHTS = {
  TRIGGER_CONFIDENCE: 0.35,
  URGENCY: 0.20,
  NOVELTY: 0.15,
  TIMING_FIT: 0.15,
  ESTIMATED_USEFULNESS: 0.15,
} as const;

/** Default retention periods in days */
export const DEFAULT_RETENTION_DAYS = {
  RAW_TRANSCRIPT: 7,
  DERIVED_FEATURES: 30,
  PROMPTS: 90,
  REPORTS: 365,
} as const;

/** Target latencies */
export const LATENCY_TARGETS = {
  EVENT_PROMPT_MAX_MS: 3000,   // NFR-001
  EVENT_PROMPT_MEDIAN_MS: 2000, // NFR-002
  REPORT_GENERATION_MAX_MS: 120000, // NFR-003
} as const;
