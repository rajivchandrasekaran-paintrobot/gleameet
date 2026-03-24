/**
 * GleaMeet Content Script
 * Injected into Google Meet pages. Handles:
 * - Meeting detection (FR-005, FR-006)
 * - Signal capture (FR-016 through FR-022)
 * - Prompt overlay rendering (FR-055 through FR-063)
 * - Status indicator (FR-008)
 */

import { createEvent } from '../utils/event-factory';
import type { PromptEvent } from '@gleameet/shared';

/** Session context maintained by the content script */
interface ContentState {
  meetingDetected: boolean;
  meetingSessionId: string | null;
  userId: string | null;
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
}

const state: ContentState = {
  meetingDetected: false,
  meetingSessionId: null,
  userId: null,
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

// --- Meeting Detection (FR-005, FR-006) ---

/** Detect if we're in an active Google Meet session */
function detectMeeting(): boolean {
  // URL is the most reliable signal — if we're on a meet.google.com/<code> page, we're in a meeting.
  // Meet's DOM attributes and jscontroller values change frequently; don't rely on them.
  const url = window.location.href;
  if (!/meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/i.test(url)) {
    return false;
  }

  // Confirm the page has actually loaded (not just the lobby pre-join screen)
  // Look for any video element (self-view always present once joined) or the leave button
  const hasVideo = !!document.querySelector('video');
  const hasLeaveBtn = !!document.querySelector('[data-is-muted]') ||
                      !!document.querySelector('[aria-label*="Leave"]') ||
                      !!document.querySelector('[aria-label*="leave"]');

  return hasVideo || hasLeaveBtn;
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
  state.meetingDetected = true;
  state.status = 'ready';

  // Notify background service worker (FR-006)
  chrome.runtime.sendMessage({ type: 'MEETING_DETECTED' }).catch(() => {});

  // Create and inject status indicator (FR-008)
  injectStatusIndicator();

  console.log('[GleaMeet] Meeting detected');
}

function onMeetingEnded(): void {
  state.meetingDetected = false;

  // Notify background to stop coaching
  if (state.status === 'active') {
    chrome.runtime.sendMessage({ type: 'STOP_COACHING' }).catch(() => {});
  }

  state.status = 'off';
  state.meetingSessionId = null;

  // Clean up observers
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

  // Clean up UI
  removeOverlay();
  removeStatusIndicator();

  console.log('[GleaMeet] Meeting ended');
}

// --- Signal Capture (FR-016 through FR-022) ---

/** Start capturing meeting signals */
function startSignalCapture(): void {
  if (!state.meetingSessionId || !state.userId) return;

  // Observe DOM for speech indicators
  observeSpeechIndicators();

  // Observe captions for transcript capture
  observeCaptions();

  // Emit session state change event
  emitEvent('session_state_changed', {
    previous_state: 'ready',
    new_state: 'active',
    reason: 'coaching_enabled',
  });

  // Diagnostic log every 10s
  state.diagnosticInterval = setInterval(() => {
    const captionEls = CAPTION_SELECTORS.flatMap(sel => Array.from(document.querySelectorAll(sel)));
    console.log(`[GleaMeet] Diagnostics: events_emitted=${state.eventsEmitted}, speech_active=${state.userSpeaking}, recognition_running=${!!recognition}, caption_elements_found=${captionEls.length}`);
  }, 10000);
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

let micCheckInterval: ReturnType<typeof setInterval> | null = null;
let recognition: any = null;

/** Use Web Speech API for speech detection + transcript (no extra mic permission needed) */
function startMicrophoneDetection(): void {
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn('[GleaMeet] SpeechRecognition not available');
    return;
  }

  function startRecognition() {
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

        if (result.isFinal) {
          emitEvent('transcript_segment', {
            text,
            speaker: 'user',
            start_offset_ms: Date.now(),
            end_offset_ms: Date.now(),
          }, 0.9);
        }
      }
    };

    recognition.onerror = (event: any) => {
      if (event.error === 'no-speech') return; // ignore, auto-restarts
      console.warn('[GleaMeet] Speech recognition error:', event.error);
      // Restart on recoverable errors
      if (['audio-capture', 'network', 'aborted'].includes(event.error)) {
        setTimeout(() => { try { startRecognition(); } catch(e) {} }, 1000);
      }
    };

    recognition.onend = () => {
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

      // Speaker detection — check for "You" label in parent container
      const container = el.closest('[class]');
      const containerText = container?.previousElementSibling?.textContent?.trim() || '';
      const isSelf = containerText === 'You' ||
                     !!el.closest('[data-self-name]') ||
                     !!el.closest('[data-is-self="true"]');
      const speaker = isSelf ? 'user' : 'other';

      console.log(`[GleaMeet] Caption captured (${speaker}): ${text.slice(0, 80)}`);
      emitEvent('transcript_segment', {
        text,
        speaker,
        start_offset_ms: Date.now(),
        end_offset_ms: Date.now(),
      }, 0.3);
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

  // Detect turn changes (other participant starts speaking)
  if (isSpeakingIndicator && !isSelfView) {
    if (state.userSpeaking) {
      // User was speaking, now someone else is — turn change
      emitEvent('turn_change', {
        from_speaker: 'user',
        to_speaker: 'other',
        gap_ms: 0,
      }, 0.5);
    }
  }
}

/** Emit a normalized event to the background service worker */
function emitEvent(
  eventType: string,
  payload: Record<string, unknown>,
  captureConfidence: number | null = null
): void {
  if (!state.meetingSessionId || !state.userId) return;

  state.eventsEmitted++;

  const event = createEvent(
    state.meetingSessionId,
    state.userId,
    eventType as any,
    payload,
    captureConfidence
  );

  chrome.runtime.sendMessage({ type: 'INGEST_EVENT', event }).catch(() => {});
}

// --- Prompt Overlay UI (FR-055 through FR-063) ---

/** Create the prompt overlay container */
function createOverlay(): HTMLDivElement {
  let overlay = document.getElementById('gleameet-overlay') as HTMLDivElement;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'gleameet-overlay';
    document.body.appendChild(overlay);
  }
  return overlay;
}

/** Remove the overlay container */
function removeOverlay(): void {
  const overlay = document.getElementById('gleameet-overlay');
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
  const overlay = document.getElementById('gleameet-overlay');
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

  const indicator = document.createElement('div');
  indicator.id = 'gleameet-status';
  indicator.className = `gleameet-status ${state.status}`;

  const dot = document.createElement('span');
  dot.className = 'gleameet-status-dot';

  const label = document.createElement('span');
  label.textContent = `GleaMeet: ${state.status}`;

  indicator.appendChild(dot);
  indicator.appendChild(label);
  document.body.appendChild(indicator);
}

function removeStatusIndicator(): void {
  const indicator = document.getElementById('gleameet-status');
  if (indicator) indicator.remove();
}

function updateStatusIndicator(): void {
  const indicator = document.getElementById('gleameet-status');
  if (indicator) {
    indicator.className = `gleameet-status ${state.status}`;
    const label = indicator.querySelector('span:last-child');
    if (label) label.textContent = `GleaMeet: ${state.status}`;
  }
}

// --- Message Handling ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'STATUS_UPDATE':
      state.status = message.status;
      state.meetingSessionId = message.meetingSessionId;
      updateStatusIndicator();
      break;

    case 'SHOW_PROMPT':
      if (state.status === 'active') {
        showPrompt(message.prompt);
      }
      break;

    case 'COACHING_STARTED':
      state.meetingSessionId = message.meetingSessionId;
      state.userId = message.userId;
      state.status = 'active';
      updateStatusIndicator();
      startSignalCapture();
      break;

    case 'DISMISS_ALL_PROMPTS':
      dismissCurrentPrompt();
      break;
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
