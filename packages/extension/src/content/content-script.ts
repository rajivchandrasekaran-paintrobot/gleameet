/**
 * GleaMeet Content Script
 * Injected into supported meeting pages. Handles:
 * - Meeting detection (FR-005, FR-006)
 * - Signal capture (FR-016 through FR-022)
 * - Prompt overlay rendering (FR-055 through FR-063)
 * - Status indicator (FR-008)
 */

import { createEvent } from '../utils/event-factory';
import { detectPlatformFromUrl, getPlatformCapabilities } from '../utils/platform';
import { TranscriptAttributionTracker } from '../utils/transcript-attribution';
import type { Platform, PromptEvent, TranscriptSource } from '@gleameet/shared';

type CaptureMode = 'full_meeting' | 'user_voice_only';

/** Session context maintained by the content script */
interface ContentState {
  meetingDetected: boolean;
  meetingSessionId: string | null;
  userId: string | null;
  platform: Platform | null;
  status: 'off' | 'ready' | 'active' | 'muted' | 'error';
  currentPrompt: PromptEvent | null;
  promptDismissTimer: ReturnType<typeof setTimeout> | null;
  mutationObserver: MutationObserver | null;
  speechObserver: MutationObserver | null;
  captionObserver: MutationObserver | null;
  userSpeaking: boolean;
  lastSpeechEmitMs: number;
  eventsEmitted: number;
  diagnosticInterval: ReturnType<typeof setInterval> | null;
  selfNames: Set<string>;
  captureMode: CaptureMode;
}

const state: ContentState = {
  meetingDetected: false,
  meetingSessionId: null,
  userId: null,
  platform: null,
  status: 'off',
  currentPrompt: null,
  promptDismissTimer: null,
  mutationObserver: null,
  speechObserver: null,
  captionObserver: null,
  userSpeaking: false,
  lastSpeechEmitMs: 0,
  eventsEmitted: 0,
  diagnosticInterval: null,
  selfNames: new Set<string>(),
  captureMode: 'full_meeting',
};

// Caption selectors — ordered by likelihood, all tried on every DOM mutation
// Goal: hit the live caption text box at the bottom of Meet, not the language picker
const CAPTION_SELECTORS = [
  // 2025/2026 Meet caption area — the bottom overlay with live text
  '[jsname="tgaKEf"]',                  // Caption text node
  'div[class*="TBMuR"]',               // Caption container
  'div[class*="CNusmb"]',              // Caption block
  'div.a4cQT',                          // Captions wrapper
  // Speaker + text containers
  '[data-message-id]',                  // Timestamped captions
  // Fallbacks
  '[jscontroller="D1tHje"] span',
  'div[class*="iOzk7"] span',
];

// Throttle speech events to avoid flooding (max one per 500ms)
const SPEECH_THROTTLE_MS = 500;
const transcriptAttribution = new TranscriptAttributionTracker();

function rememberSelfName(name: string | null | undefined): void {
  const normalized = (name || '').trim();
  if (!normalized) return;
  if (/^you$/i.test(normalized)) return;
  if (normalized.length < 2) return;
  state.selfNames.add(normalized.toLowerCase());
}

function refreshSelfIdentityHints(): void {
  const candidates = new Set<string>();

  document.querySelectorAll('[aria-label]').forEach((el) => {
    const label = (el.getAttribute('aria-label') || '').trim();
    if (!label) return;
    const youParen = label.match(/^(.*?)\s*\(\s*you\s*\)$/i);
    const youDash = label.match(/^(.*?)\s*[—-]\s*you$/i);
    const youComma = label.match(/^you\s*,\s*(.*?)$/i);
    const direct = youParen?.[1] || youDash?.[1] || youComma?.[1];
    if (direct) candidates.add(direct.trim());
  });

  document.querySelectorAll('*').forEach((el) => {
    const text = (el.textContent || '').trim();
    if (!text || text.length > 80) return;
    if (/\bYou\b/i.test(text)) {
      const prev = (el.previousElementSibling as HTMLElement | null)?.textContent?.trim();
      const next = (el.nextElementSibling as HTMLElement | null)?.textContent?.trim();
      if (prev && prev !== 'You') candidates.add(prev);
      if (next && next !== 'You') candidates.add(next);
    }
  });

  candidates.forEach(rememberSelfName);
}

function isLikelySelfCaption(el: Element): boolean {
  const container = el.closest('[class]');
  const nearby = [
    container?.previousElementSibling?.textContent,
    container?.parentElement?.previousElementSibling?.textContent,
    container?.getAttribute?.('aria-label') || null,
    (el as HTMLElement).getAttribute?.('aria-label') || null,
  ]
    .map((v) => (v || '').trim())
    .filter(Boolean);

  for (const value of nearby) {
    if (/^you$/i.test(value) || /\(\s*you\s*\)$/i.test(value) || /\byou\b/i.test(value)) {
      return true;
    }
    const normalized = value.toLowerCase();
    for (const selfName of state.selfNames) {
      if (normalized === selfName || normalized.includes(selfName)) return true;
    }
  }

  return !!el.closest('[data-self-name]') || !!el.closest('[data-is-self="true"]');
}

// --- Meeting Detection (FR-005, FR-006) ---

/** Detect current platform */
function getPlatform(): Platform | null {
  return detectPlatformFromUrl(window.location.href);
}

/** Detect if we're in an active video call */
function detectMeeting(): boolean {
  const url = window.location.href;
  const platform = getPlatform();
  if (!platform) return false;

  // Google Meet
  if (platform === 'google_meet' && /meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/i.test(url)) {
    const hasVideo = !!document.querySelector('video');
    const hasLeaveBtn = !!document.querySelector('[data-is-muted]') ||
                        !!document.querySelector('[aria-label*="Leave"]') ||
                        !!document.querySelector('[aria-label*="leave"]');
    return hasVideo || hasLeaveBtn;
  }

  // Microsoft Teams web
  if (platform === 'teams') {
    // Check URL path for call indicators (hash/path changes when in a call)
    const decodedUrl = decodeURIComponent(url);
    const inCallUrl = url.includes('/callingv2') ||
                      url.includes('/meet/') ||
                      url.includes('/_#/callingv2') ||
                      url.includes('/calling') ||
                      url.includes('launcher.html') ||
                      url.includes('/l/meetup-join') ||
                      url.includes('/light-meetings/launch') ||
                      url.includes('lightExperience=true') ||
                      url.includes('anon=true') ||
                      url.includes('type=meet') ||
                      decodedUrl.includes('/meet/') ||     // encoded meet URLs
                      decodedUrl.includes('/_#/meet') ||   // encoded hash URLs
                      decodedUrl.includes('/callingv2') ||
                      decodedUrl.includes('/light-meetings/launch');

    const endedUi =
      !!document.querySelector('[data-tid="call-ended-screen"]') ||
      /meeting has ended|call ended|you left the meeting/i.test(document.body.textContent || '');

    const hasCallUi =
      !!document.querySelector('[data-tid="calling-screen"]') ||
      !!document.querySelector('[data-tid="hangup-btn"]') ||
      !!document.querySelector('[data-tid="toggle-mute"]') ||
      !!document.querySelector('[data-tid="toggle-video"]') ||
      !!document.querySelector('[data-tid="prejoin-join-button"]') ||
      !!document.querySelector('button[aria-label*="Leave"]') ||
      !!document.querySelector('button[aria-label*="leave"]') ||
      !!document.querySelector('[class*="calling"]') ||
      !!document.querySelector('[id*="calling"]');

    const titleLooksMeetingLike =
      document.title.toLowerCase().includes('meeting') ||
      document.title.toLowerCase().includes('call');

    // Require a stronger signal than title-only to avoid false positives on calendar/lobby pages.
    return !endedUi && (inCallUrl || hasCallUi || (!!document.querySelector('video') && titleLooksMeetingLike));
  }

  // Zoom web client
  if (platform === 'zoom') {
    const decodedUrl = decodeURIComponent(url);
    const zoomPath = (() => {
      try {
        return new URL(url).pathname;
      } catch (_err) {
        return decodedUrl;
      }
    })();
    const hasWebClientMeetingUrl = /\/wc\/\d+(?:\/(?:join|start|meeting))?(?:\/|$)/i.test(zoomPath);
    const hasMeetingUrl = hasWebClientMeetingUrl || url.includes('/join');
    const hasMeetingUi =
      !!document.querySelector('.meeting-app') ||
      !!document.querySelector('#wc-container-right') ||
      !!document.querySelector('.footer-button-base__button-label') ||
      !!document.querySelector('[aria-label*="Leave"]') ||
      !!document.querySelector('[aria-label*="leave"]') ||
      !!document.querySelector('[aria-label*="mute"]') ||
      !!document.querySelector('[class*="footer"] button') ||
      !!document.querySelector('video');
    const endedScreen =
      !!document.querySelector('.zm-modal-body-title') &&
      /ended|left|removed/i.test(document.body.textContent || '');
    return !endedScreen && hasMeetingUrl && (hasWebClientMeetingUrl || hasMeetingUi);
  }

  return false;
}

let meetingEndDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Start observing the DOM for meeting lifecycle changes */
function startMeetingDetection(): void {
  // Initial check
  if (detectMeeting() && !state.meetingDetected) {
    onMeetingDetected();
  }

  // Observe DOM changes for meeting start/end
  // Use a debounce for "ended" to avoid false positives from transient DOM changes
  state.mutationObserver = new MutationObserver(() => {
    const inMeeting = detectMeeting();
    if (inMeeting && !state.meetingDetected) {
      // Cancel any pending end debounce — we're still in the meeting
      if (meetingEndDebounceTimer) {
        clearTimeout(meetingEndDebounceTimer);
        meetingEndDebounceTimer = null;
      }
      onMeetingDetected();
    } else if (!inMeeting && state.meetingDetected) {
      // Debounce meeting end by 3 seconds — DOM can flicker during Meet reloads
      if (!meetingEndDebounceTimer) {
        meetingEndDebounceTimer = setTimeout(() => {
          meetingEndDebounceTimer = null;
          if (!detectMeeting()) {
            onMeetingEnded();
          }
        }, 3000);
      }
    }
  });

  state.mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function onMeetingDetected(): void {
  const platform = getPlatform();
  if (!platform) return;

  state.meetingDetected = true;
  state.platform = platform;
  if (state.status === 'off') {
    state.status = 'ready';
  }

  // Notify background service worker (FR-006)
  chrome.runtime.sendMessage({ type: 'MEETING_DETECTED', platform }).catch(() => {});

  // Create and inject status indicator (FR-008)
  injectStatusIndicator();

  console.log('[GleaMeet] Meeting detected');
}

function onMeetingEnded(): void {
  state.meetingDetected = false;

  // Meeting ended — end session and generate report
  if (state.status === 'active' || state.status === 'muted' || state.status === 'ready') {
    chrome.runtime.sendMessage({ type: 'MEETING_ENDED' }).catch(() => {});
  }

  state.status = 'off';
  state.meetingSessionId = null;
  state.platform = null;

  stopSignalCapture();

  // Clean up UI
  removeOverlay();
  removeStatusIndicator();

  console.log('[GleaMeet] Meeting ended');
}

// --- Signal Capture (FR-016 through FR-022) ---

/** Start capturing meeting signals */
function startSignalCapture(): void {
  if (!state.meetingSessionId || !state.userId) return;

  const platform = state.platform ?? getPlatform();
  if (!platform) return;
  const capabilities = getPlatformCapabilities(platform);

  if (capabilities.supportsDomSpeechSignals) {
    observeSpeechIndicators();
  }
  if (capabilities.supportsDomCaptions && state.captureMode !== 'user_voice_only') {
    observeCaptions();
  }
  if (!capabilities.supportsDomSpeechSignals && capabilities.supportsMicSpeechDetection) {
    console.log(`[GleaMeet] ${platform}: using mic-first signal capture; DOM-only Meet signals disabled`);
    startMicrophoneDetection(); // Speech start/end detection via Web Speech API
  }

  // Audio capture — delegate to offscreen document via service worker
  chrome.runtime.sendMessage({
    type: "START_AUDIO_CAPTURE",
    meetingSessionId: state.meetingSessionId,
    captureMode: state.captureMode,
  }).catch(() => {});

  // Emit session state change event
  emitEvent('session_state_changed', {
    previous_state: 'ready',
    new_state: 'active',
    reason: 'coaching_enabled',
    platform,
  });

  // Diagnostic log every 10s
  state.diagnosticInterval = setInterval(() => {
    const captionEls = platform === 'google_meet'
      ? CAPTION_SELECTORS.flatMap(sel => Array.from(document.querySelectorAll(sel))).length
      : 0;
    console.log(`[GleaMeet] Diagnostics [${platform}]: events_emitted=${state.eventsEmitted}, speech_active=${state.userSpeaking}, recognition_running=${!!recognition}, capture_mode=${state.captureMode}, caption_elements_found=${captionEls}`);
  }, 10000);

}

function stopSignalCapture(): void {
  chrome.runtime.sendMessage({ type: 'STOP_AUDIO_CAPTURE' }).catch(() => {});

  if (state.speechObserver) {
    state.speechObserver.disconnect();
    state.speechObserver = null;
  }
  if (state.captionObserver) {
    state.captionObserver.disconnect();
    state.captionObserver = null;
  }
  if (state.diagnosticInterval) {
    clearInterval(state.diagnosticInterval);
    state.diagnosticInterval = null;
  }
  state.userSpeaking = false;
  stopMicrophoneDetection();
  dismissCurrentPrompt();
}

/** Observe Google Meet DOM for speech/participant indicators */
function observeSpeechIndicators(): void {
  if (state.speechObserver) {
    state.speechObserver.disconnect();
  }

  // Primary: use Web Audio API to detect microphone activity directly
  // This is reliable regardless of Google Meet's obfuscated CSS classes
  startMicrophoneDetection();

  // Minimal DOM observer — only needed for turn-change detection via captions
  state.speechObserver = new MutationObserver(() => {
    // intentionally empty — mic detection handles speech_started/ended
  });
  state.speechObserver.observe(document.body, { childList: true, subtree: false });
}

let recognition: any = null;
let recognitionShouldRun = false;

function stopMicrophoneDetection(): void {
  recognitionShouldRun = false;
  if (!recognition) return;

  try {
    recognition.onend = null;
    recognition.stop?.();
    recognition.abort?.();
  } catch (_err) {
    // Ignore cleanup failures from browser speech recognition internals.
  }
  recognition = null;
}

/** Use Web Speech API for speech detection + transcript (no extra mic permission needed) */
function startMicrophoneDetection(): void {
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn('[GleaMeet] SpeechRecognition not available');
    return;
  }

  stopMicrophoneDetection();
  recognitionShouldRun = true;

  function startRecognition() {
    if (!recognitionShouldRun) return;

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      console.log('[GleaMeet] Speech recognition active');
    };

    recognition.onspeechstart = () => {
      const now = Date.now();
      if (!state.userSpeaking && now - state.lastSpeechEmitMs > SPEECH_THROTTLE_MS) {
        state.userSpeaking = true;
        state.lastSpeechEmitMs = now;
        emitEvent('speech_started', { speaker: 'user', offset_ms: now }, 0.9);
      }
    };

    recognition.onspeechend = () => {
      const now = Date.now();
      if (state.userSpeaking) {
        state.userSpeaking = false;
        state.lastSpeechEmitMs = now;
        emitEvent('speech_ended', { speaker: 'user', offset_ms: now }, 0.9);
      }
    };

    recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;

        if (result.isFinal && !whisperActive) {
          emitTranscriptSegment(text, 'user', 'web_speech', 0.9);
        }
      }
    };

    recognition.onerror = (event: any) => {
      if (event.error === 'no-speech') return; // ignore, auto-restarts
      console.warn('[GleaMeet] Speech recognition error:', event.error);
      // Restart on recoverable errors
      if (recognitionShouldRun && ['audio-capture', 'network', 'aborted'].includes(event.error)) {
        setTimeout(() => { try { startRecognition(); } catch(e) {} }, 1000);
      }
    };

    recognition.onend = () => {
      if (!recognitionShouldRun) return;
      // Auto-restart with backoff — Meet may have taken the mic temporarily
      setTimeout(() => {
        try { startRecognition(); } catch(e) {
          // If still can't start, try again after 3s
          setTimeout(() => { try { startRecognition(); } catch(_) {} }, 3000);
        }
      }, 1000);
    };

    try {
      recognition.start();
    } catch(e) {
      console.warn('[GleaMeet] Could not start speech recognition:', e);
    }
  }

  startRecognition();
}

/** Observe Google Meet captions/subtitles for transcript extraction */
function observeCaptions(): void {
  if (state.captionObserver) {
    state.captionObserver.disconnect();
  }

  // Watch for caption container appearing — try all known selectors
  state.captionObserver = new MutationObserver(() => {
    refreshSelfIdentityHints();
    // Collect elements from all known caption selectors
    const seen = new Set<Element>();
    for (const selector of CAPTION_SELECTORS) {
      try {
        document.querySelectorAll(selector).forEach(el => seen.add(el));
      } catch(e) { /* invalid selector, skip */ }
    }

    for (const el of seen) {
      const text = (el as HTMLElement).textContent?.trim();
      if (!text || text.length < 10 || el.getAttribute('data-gleameet-captured')) continue;

      // Filter language picker items — format: "Language Name (Country)" e.g. "Arabic (United Arab Emirates)"
      if (/^[A-Z][a-zA-Z\s,]+\([A-Z][a-zA-Z\s]+\)$/.test(text)) continue;

      // Filter UI noise — short single/double words that aren't speech
      const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
      if (wordCount < 5) continue;

      el.setAttribute('data-gleameet-captured', '1');

      // Speaker detection — prefer learned self identity from Meet DOM, not only a literal "You" label
      const isSelf = isLikelySelfCaption(el);
      const speaker = isSelf ? 'user' : 'other';

      console.log(`[GleaMeet] Caption captured (${speaker}): ${text.slice(0, 80)}`);
      emitTranscriptSegment(text, speaker, 'caption', 0.3);
    }
  });

  state.captionObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

/** Check if a DOM change indicates speech activity */
function checkSpeechState(element: HTMLElement): void {
  refreshSelfIdentityHints();
  const classes = (typeof element.className === 'string' ? element.className : element.className?.baseVal) || '';
  const now = Date.now();

  // Throttle speech events
  if (now - state.lastSpeechEmitMs < SPEECH_THROTTLE_MS) return;

  // Detect user speaking — try both CSS classes and data attributes
  const isSpeakingIndicator = classes.includes('IisKdb') ||
                              classes.includes('gLhFNb') ||
                              classes.includes('Gv1mTb-aTv5jf') ||
                              classes.includes('VfPpkd-Bz112c') ||
                              (element as HTMLElement).hasAttribute('data-audio-level') ||
                              element.closest('[data-is-muted="false"]') !== null;

  const isSelfView = !!element.closest('[data-self-name]') ||
                     !!element.closest('[data-is-self="true"]');

  if (isSpeakingIndicator && isSelfView) {
    if (!state.userSpeaking) {
      state.userSpeaking = true;
      state.lastSpeechEmitMs = now;
      emitEvent('speech_started', { speaker: 'user', offset_ms: now }, 0.7);
    }
  } else if (state.userSpeaking && isSelfView && !isSpeakingIndicator) {
    state.userSpeaking = false;
    state.lastSpeechEmitMs = now;
    emitEvent('speech_ended', { speaker: 'user', offset_ms: now }, 0.7);
  }

  // Ignore non-user speaking indicators here.
  // Coaching should be driven only by the user's own signals.
}

/** Emit a normalized event to the background service worker */
function emitEvent(
  eventType: string,
  payload: Record<string, unknown>,
  captureConfidence: number | null = null
): void {
  if (!state.meetingSessionId || !state.userId || !state.platform) return;

  state.eventsEmitted++;

  const event = createEvent(
    state.meetingSessionId,
    state.userId,
    state.platform,
    eventType as any,
    payload,
    captureConfidence
  );

  chrome.runtime.sendMessage({ type: 'INGEST_EVENT', event }).catch(() => {});
}

function emitTranscriptSegment(
  text: string,
  candidateSpeaker: 'user' | 'other',
  source: TranscriptSource,
  captureConfidence: number | null,
  timing?: { startOffsetMs?: number; endOffsetMs?: number; eventTimeMs?: number }
): void {
  const eventTimeMs = timing?.eventTimeMs ?? Date.now();
  const endOffsetMs = timing?.endOffsetMs ?? eventTimeMs;
  const startOffsetMs = timing?.startOffsetMs ?? endOffsetMs;

  const payload = transcriptAttribution.classifySegment({
    text,
    source,
    candidateSpeaker,
    timestampMs: eventTimeMs,
    startOffsetMs,
    endOffsetMs,
  });

  if (!payload) return;
  emitEvent('transcript_segment', payload as unknown as Record<string, unknown>, captureConfidence);
}

// Whisper active flag — when true, suppress Web Speech API transcripts
let whisperActive = false;

// --- Prompt Overlay UI (FR-055 through FR-063) ---

const GLEAMEET_UI_HOST_ID = 'gleameet-ui-host';

function getUiRoot(): ShadowRoot {
  let host = document.getElementById(GLEAMEET_UI_HOST_ID) as HTMLDivElement | null;
  if (!host) {
    host = document.createElement('div');
    host.id = GLEAMEET_UI_HOST_ID;
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.pointerEvents = 'none';
    host.style.zIndex = '2147483647';
    (document.documentElement || document.body).appendChild(host);
  }

  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if (!root.getElementById('gleameet-ui-style')) {
    const style = document.createElement('style');
    style.id = 'gleameet-ui-style';
    style.textContent = `
      :host { all: initial; }
      #gleameet-overlay {
        position: fixed;
        right: 24px;
        bottom: 24px;
        z-index: 2147483647;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      #gleameet-overlay * { pointer-events: auto; box-sizing: border-box; }
      .gleameet-prompt {
        background: rgba(255, 255, 255, 0.96);
        color: #1a1a2e;
        border: 1px solid rgba(0, 102, 204, 0.2);
        border-radius: 12px;
        padding: 14px 18px;
        max-width: 320px;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.18);
        backdrop-filter: blur(12px);
        animation: gleameet-slide-in 0.3s ease-out;
        margin-top: 8px;
      }
      .gleameet-prompt-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
      }
      .gleameet-prompt-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: #0066cc;
      }
      .gleameet-prompt-law-code {
        font-size: 10px;
        font-weight: 700;
        font-family: "SF Mono", Menlo, Consolas, monospace;
        color: #ffffff;
        background: #0066cc;
        border-radius: 4px;
        padding: 1px 6px;
        letter-spacing: 0.3px;
        flex-shrink: 0;
      }
      .gleameet-prompt-dismiss {
        appearance: none;
        border: none;
        background: transparent;
        color: #8b8ba0;
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        padding: 0 2px;
      }
      .gleameet-prompt-text {
        font-size: 15px;
        font-weight: 600;
        line-height: 1.35;
        margin-bottom: 4px;
      }
      .gleameet-prompt-rationale {
        font-size: 12px;
        color: #6b6b80;
        line-height: 1.3;
      }
      .gleameet-status {
        position: fixed;
        top: 12px;
        right: 12px;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 16px;
        font: 500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #1a1a2e;
        background: rgba(255, 255, 255, 0.92);
        backdrop-filter: blur(8px);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
      }
      .gleameet-status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
      }
      .gleameet-status.active .gleameet-status-dot { background: #00804a; }
      .gleameet-status.muted .gleameet-status-dot { background: #cc7a00; }
      .gleameet-status.ready .gleameet-status-dot { background: #0066cc; }
      .gleameet-status.error .gleameet-status-dot { background: #cc0000; }
      @keyframes gleameet-slide-in {
        from { opacity: 0; transform: translateY(12px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
    root.appendChild(style);
  }

  return root;
}

/** Create the prompt overlay container */
function createOverlay(): HTMLDivElement {
  const root = getUiRoot();
  let overlay = root.getElementById('gleameet-overlay') as HTMLDivElement | null;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'gleameet-overlay';
    root.appendChild(overlay);
  }
  return overlay;
}

/** Remove the overlay container */
function removeOverlay(): void {
  const overlay = getUiRoot().getElementById('gleameet-overlay');
  if (overlay) overlay.remove();
}

/** Show a prompt in the overlay (FR-055 through FR-060) */
function showPrompt(prompt: PromptEvent): void {
  // FR-045: At most one prompt at a time — dismiss any existing prompt
  dismissCurrentPrompt();

  state.currentPrompt = prompt;
  const overlay = createOverlay();

  const promptEl = document.createElement('div');
  promptEl.className = 'gleameet-prompt';
  promptEl.setAttribute('data-prompt-id', prompt.prompt_id);

  // Header with label, law code, and dismiss button
  const header = document.createElement('div');
  header.className = 'gleameet-prompt-header';

  const label = document.createElement('span');
  label.className = 'gleameet-prompt-label';
  label.textContent = `Coach \u00b7 ${prompt.prompt_type}`;

  const lawCode = document.createElement('span');
  lawCode.className = 'gleameet-prompt-law-code';
  lawCode.textContent = prompt.law_id;
  lawCode.title = `Law: ${prompt.law_id}`;

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'gleameet-prompt-dismiss';
  dismissBtn.textContent = '\u00d7';
  dismissBtn.title = 'Dismiss';
  dismissBtn.addEventListener('click', () => dismissPrompt(prompt.prompt_id));

  header.appendChild(label);
  header.appendChild(lawCode);
  header.appendChild(dismissBtn);

  // Main prompt text (FR-058: max 12 words)
  const text = document.createElement('div');
  text.className = 'gleameet-prompt-text';
  text.textContent = prompt.short_text;

  promptEl.appendChild(header);
  promptEl.appendChild(text);

  // Optional rationale (FR-059: max 10 words)
  if (prompt.rationale_text) {
    const rationale = document.createElement('div');
    rationale.className = 'gleameet-prompt-rationale';
    rationale.textContent = prompt.rationale_text;
    promptEl.appendChild(rationale);
  }

  overlay.innerHTML = '';
  overlay.appendChild(promptEl);

  // Acknowledge prompt as shown (FR-054)
  ackPrompt(prompt.prompt_id, 'shown');

  // Auto-dismiss after 15 seconds
  state.promptDismissTimer = setTimeout(() => {
    dismissPrompt(prompt.prompt_id);
  }, 15000);
}

/** Dismiss the current prompt */
function dismissCurrentPrompt(): void {
  if (state.currentPrompt) {
    dismissPrompt(state.currentPrompt.prompt_id);
  }
}

/** Dismiss a specific prompt */
function dismissPrompt(promptId: string): void {
  const overlay = getUiRoot().getElementById('gleameet-overlay');
  if (overlay) {
    const el = overlay.querySelector(`[data-prompt-id="${promptId}"]`);
    if (el) el.remove();
  }

  if (state.promptDismissTimer) {
    clearTimeout(state.promptDismissTimer);
    state.promptDismissTimer = null;
  }

  if (state.currentPrompt?.prompt_id === promptId) {
    ackPrompt(promptId, 'dismissed');
    state.currentPrompt = null;
  }
}

/** Acknowledge a prompt action to the backend (FR-054) */
function ackPrompt(promptId: string, action: 'shown' | 'dismissed' | 'muted'): void {
  chrome.runtime.sendMessage({
    type: 'ACK_PROMPT',
    promptId,
    meetingSessionId: state.meetingSessionId,
    action,
  }).catch(() => {});
}

// --- Status Indicator (FR-008) ---

function injectStatusIndicator(): void {
  removeStatusIndicator();
  const root = getUiRoot();

  const indicator = document.createElement('div');
  indicator.id = 'gleameet-status';
  indicator.className = `gleameet-status ${state.status}`;

  const dot = document.createElement('span');
  dot.className = 'gleameet-status-dot';

  const label = document.createElement('span');
  label.textContent = `GleaMeet: ${state.status}`;

  indicator.appendChild(dot);
  indicator.appendChild(label);
  root.appendChild(indicator);
}

function removeStatusIndicator(): void {
  const indicator = getUiRoot().getElementById('gleameet-status');
  if (indicator) indicator.remove();
}

function updateStatusIndicator(): void {
  const indicator = getUiRoot().getElementById('gleameet-status');
  if (indicator) {
    indicator.className = `gleameet-status ${state.status}`;
    const label = indicator.querySelector('span:last-child');
    if (label) label.textContent = `GleaMeet: ${state.status}`;
  }
}

// --- Message Handling ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'STATUS_UPDATE': {
      const previousStatus = state.status;
      state.status = message.status;
      state.meetingDetected = message.meetingDetected ?? state.meetingDetected;
      state.meetingSessionId = message.meetingSessionId;
      state.platform = message.platform ?? state.platform ?? getPlatform();
      state.captureMode = message.captureMode === 'user_voice_only' ? 'user_voice_only' : state.captureMode;
      updateStatusIndicator();
      if (
        (previousStatus === 'active' || previousStatus === 'muted') &&
        (state.status === 'ready' || state.status === 'off' || state.status === 'error')
      ) {
        stopSignalCapture();
      }
      break;
    }

    case 'SHOW_PROMPT':
      if (state.status !== 'muted' && detectMeeting()) {
        state.meetingDetected = true;
        if (state.status !== 'active') {
          state.status = 'active';
          updateStatusIndicator();
        }
        showPrompt(message.prompt);
      } else if (!detectMeeting()) {
        dismissCurrentPrompt();
      }
      break;

    case 'COACHING_STARTED':
      stopSignalCapture();
      state.meetingSessionId = message.meetingSessionId;
      state.userId = message.userId;
      state.platform = message.platform ?? getPlatform();
      state.captureMode = message.captureMode === 'user_voice_only' ? 'user_voice_only' : 'full_meeting';
      state.status = 'active';
      state.meetingDetected = true;
      updateStatusIndicator();
      startSignalCapture();
      break;

    case 'WHISPER_ACTIVE':
      whisperActive = true;
      break;

    case 'AUDIO_TRANSCRIPT_RESULT': {
      whisperActive = true;
      const stream = message.stream as 'mic' | 'tab';
      if (state.captureMode === 'user_voice_only' && stream !== 'mic') {
        break;
      }
      const candidateSpeaker =
        stream === 'mic'
          ? 'user'
          : (state.platform === 'google_meet' && state.userSpeaking ? 'user' : 'other');
      emitTranscriptSegment(
        message.text || '',
        candidateSpeaker,
        stream,
        stream === 'mic' ? 0.85 : (candidateSpeaker === 'user' ? 0.8 : 0.75),
        {
          startOffsetMs: message.startOffsetMs,
          endOffsetMs: message.endOffsetMs,
          eventTimeMs: message.eventTimeMs,
        }
      );
      break;
    }

    case 'DISMISS_ALL_PROMPTS':
      dismissCurrentPrompt();
      break;

    case 'GET_CONTENT_STATUS':
      sendResponse({
        meetingDetected: state.meetingDetected || detectMeeting(),
        platform: state.platform ?? getPlatform(),
        status: state.status,
      });
      return true;
  }
  sendResponse({ ok: true });
  return true;
});

// --- Consent Dialog (FR-012 through FR-015) ---

/** Show consent dialog before coaching begins */
function showConsentDialog(): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.id = 'gleameet-consent-backdrop';
    backdrop.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,0.5); display: flex;
      align-items: center; justify-content: center;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: white; border-radius: 12px; padding: 24px;
      max-width: 420px; width: 90%; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      box-shadow: 0 8px 32px rgba(0,0,0,0.2);
    `;

    dialog.innerHTML = `
      <h2 style="margin: 0 0 12px; font-size: 18px; color: #1a1a2e;">Enable Meeting Coach</h2>
      <p style="margin: 0 0 8px; font-size: 13px; color: #6b6b80; line-height: 1.5;">
        GleaMeet will privately coach you during this meeting. By enabling:
      </p>
      <ul style="margin: 0 0 16px; padding-left: 20px; font-size: 13px; color: #6b6b80; line-height: 1.6;">
        <li>Coaching is <strong>private to you only</strong></li>
        <li>Meeting timing and conversation signals will be captured</li>
        <li>Live prompts may appear during the meeting</li>
        <li>You can mute or stop coaching at any time</li>
        <li>You can delete meeting data after the session</li>
      </ul>
      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button id="gleameet-consent-cancel" style="
          padding: 8px 16px; border: 1px solid #e0e0e8; border-radius: 6px;
          background: white; color: #6b6b80; cursor: pointer; font-size: 13px;
        ">Not Now</button>
        <button id="gleameet-consent-accept" style="
          padding: 8px 16px; border: none; border-radius: 6px;
          background: #0066cc; color: white; cursor: pointer; font-size: 13px; font-weight: 500;
        ">Enable Coaching</button>
      </div>
    `;

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    document.getElementById('gleameet-consent-accept')!.addEventListener('click', () => {
      backdrop.remove();
      resolve(true);
    });

    document.getElementById('gleameet-consent-cancel')!.addEventListener('click', () => {
      backdrop.remove();
      resolve(false);
    });
  });
}

// Expose consent dialog for popup to trigger
(window as any).__gleameet_showConsent = showConsentDialog;

// --- Initialize ---
startMeetingDetection();

// Teams/Zoom use hash/pushState navigation — URL changes don't trigger page reload
let lastUrl = window.location.href;
setInterval(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    state.platform = getPlatform();
  }

  const inMeeting = detectMeeting();
  if (inMeeting && !state.meetingDetected) {
    onMeetingDetected();
  } else if (!inMeeting && state.meetingDetected && !meetingEndDebounceTimer) {
    meetingEndDebounceTimer = setTimeout(() => {
      meetingEndDebounceTimer = null;
      if (!detectMeeting()) onMeetingEnded();
    }, 3000);
  }
}, 1000);
