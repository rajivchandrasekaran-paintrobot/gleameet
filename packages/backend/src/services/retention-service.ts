import { DEFAULT_RETENTION_DAYS } from '@gleameet/shared';
import { cleanupExpiredData } from '../db/queries';

/** Configurable retention periods (days) */
export interface RetentionConfig {
  raw_transcript: number;
  derived_features: number;
  prompts: number;
  reports: number;
}

const DEFAULT_CONFIG: RetentionConfig = {
  raw_transcript: DEFAULT_RETENTION_DAYS.RAW_TRANSCRIPT,
  derived_features: DEFAULT_RETENTION_DAYS.DERIVED_FEATURES,
  prompts: DEFAULT_RETENTION_DAYS.PROMPTS,
  reports: DEFAULT_RETENTION_DAYS.REPORTS,
};

let retentionInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Run a single retention cleanup pass.
 * Deletes records older than their configured retention period.
 */
export async function runRetentionCleanup(config: RetentionConfig = DEFAULT_CONFIG): Promise<void> {
  console.log('[RETENTION] Starting cleanup...');
  try {
    const result = await cleanupExpiredData(config);
    console.log(
      `[RETENTION] Cleanup complete: ` +
      `raw_events=${result.raw_events}, features=${result.features}, ` +
      `prompts=${result.prompts}, reports=${result.reports}`
    );
  } catch (err) {
    console.error('[RETENTION] Cleanup failed:', err);
  }
}

/**
 * Start the retention service background job.
 * Runs cleanup at the specified interval (default: every 6 hours).
 */
export function startRetentionService(
  intervalMs: number = 6 * 60 * 60 * 1000,
  config: RetentionConfig = DEFAULT_CONFIG
): void {
  if (retentionInterval) {
    console.log('[RETENTION] Service already running');
    return;
  }

  console.log(`[RETENTION] Starting service (interval: ${intervalMs / 1000}s)`);

  // Run immediately on start
  runRetentionCleanup(config);

  // Then run on interval
  retentionInterval = setInterval(() => runRetentionCleanup(config), intervalMs);
}

/** Stop the retention service */
export function stopRetentionService(): void {
  if (retentionInterval) {
    clearInterval(retentionInterval);
    retentionInterval = null;
    console.log('[RETENTION] Service stopped');
  }
}
