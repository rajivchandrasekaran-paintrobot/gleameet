import type { TranscriptAttribution, TranscriptSource, TranscriptPayload } from '@gleameet/shared';

type Speaker = 'user' | 'other';

interface RecentTranscriptContext {
  speaker: Speaker;
  source: TranscriptSource;
  text: string;
  ts: number;
}

const RECENT_CONTEXT_WINDOW_MS = 15000;
const MAX_CONTEXT_ENTRIES = 20;
const MIN_OVERLAP_TOKENS = 4;
const STRONG_OVERLAP_SCORE = 0.72;

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(' ')
    .filter(token => token.length >= 2);
}

function computeOverlapScore(a: string, b: string): number {
  const normalizedA = normalizeText(a);
  const normalizedB = normalizeText(b);
  if (!normalizedA || !normalizedB) return 0;
  if (normalizedA === normalizedB) return 1;
  if (normalizedA.length >= 12 && normalizedB.includes(normalizedA)) return 0.95;
  if (normalizedB.length >= 12 && normalizedA.includes(normalizedB)) return 0.95;

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let shared = 0;
  for (const token of setA) {
    if (setB.has(token)) shared++;
  }

  if (shared < Math.min(MIN_OVERLAP_TOKENS, setA.size, setB.size)) return 0;
  return shared / Math.max(Math.min(setA.size, setB.size), 1);
}

export class TranscriptAttributionTracker {
  private readonly recentContext: RecentTranscriptContext[] = [];

  classifySegment(params: {
    text: string;
    source: TranscriptSource;
    candidateSpeaker: Speaker;
    timestampMs: number;
    startOffsetMs: number;
    endOffsetMs: number;
  }): TranscriptPayload | null {
    const text = params.text.trim();
    if (!text) return null;

    this.pruneContext(params.timestampMs);

    const attribution = this.buildAttribution(params);
    const payload: TranscriptPayload = {
      text,
      speaker: attribution.final_speaker,
      start_offset_ms: params.startOffsetMs,
      end_offset_ms: params.endOffsetMs,
      attribution,
    };

    this.rememberContext({
      speaker: payload.speaker,
      source: params.source,
      text,
      ts: params.timestampMs,
    });

    return payload;
  }

  private buildAttribution(params: {
    text: string;
    source: TranscriptSource;
    candidateSpeaker: Speaker;
    timestampMs: number;
  }): TranscriptAttribution {
    if (params.candidateSpeaker === 'other') {
      return {
        source: params.source,
        candidate_speaker: 'other',
        final_speaker: 'other',
        passes_user_attribution: false,
        reason: 'non_user_context',
      };
    }

    const overlapMatch = this.findBestNonUserOverlap(params.text, params.timestampMs);
    if (overlapMatch && overlapMatch.score >= STRONG_OVERLAP_SCORE) {
      return {
        source: params.source,
        candidate_speaker: 'user',
        final_speaker: 'other',
        passes_user_attribution: false,
        reason: 'overlap_with_recent_non_user_context',
        overlap_score: Number(overlapMatch.score.toFixed(2)),
        matched_source: overlapMatch.entry.source,
      };
    }

    return {
      source: params.source,
      candidate_speaker: 'user',
      final_speaker: 'user',
      passes_user_attribution: true,
      reason: 'self_declared',
    };
  }

  private findBestNonUserOverlap(text: string, timestampMs: number): { entry: RecentTranscriptContext; score: number } | null {
    let best: { entry: RecentTranscriptContext; score: number } | null = null;

    for (const entry of this.recentContext) {
      if (entry.speaker !== 'other') continue;
      if (timestampMs - entry.ts > RECENT_CONTEXT_WINDOW_MS) continue;

      const score = computeOverlapScore(text, entry.text);
      if (!best || score > best.score) {
        best = { entry, score };
      }
    }

    return best;
  }

  private rememberContext(entry: RecentTranscriptContext): void {
    this.recentContext.push(entry);
    if (this.recentContext.length > MAX_CONTEXT_ENTRIES) {
      this.recentContext.splice(0, this.recentContext.length - MAX_CONTEXT_ENTRIES);
    }
  }

  private pruneContext(timestampMs: number): void {
    const cutoff = timestampMs - RECENT_CONTEXT_WINDOW_MS;
    while (this.recentContext.length > 0 && this.recentContext[0].ts < cutoff) {
      this.recentContext.shift();
    }
  }
}
