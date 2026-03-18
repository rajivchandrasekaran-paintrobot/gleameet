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
}

const state: ContentState = {
  meetingDetected: false,
  meetingSessionId: null,
  userId: null,
  status: 'off',
  currentPrompt: null,
  promptDismissTimer: null,
  mutationObserver: null,
};

// --- Meeting Detection (FR-005, FR-006) ---

/** Detect if we're in an active Google Meet session */
function detectMeeting(): boolean {
  // Google Meet uses specific DOM patterns for active meetings
  const meetIndicators = [
    '[data-meeting-code]',
    '[data-call-id]',
    '[jscontroller="kAPMuc"]', // Meet call container
  ];

  for (const selector of meetIndicators) {
    if (document.querySelector(selector)) return true;
  }

  // Fallback: check URL pattern for active meeting
  const url = window.location.href;
  return /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(url);
}

/** Start observing the DOM for meeting lifecycle changes */
function startMeetingDetection(): void {
  // Initial check
  if (detectMeeting() && !state.meetingDetected) {
    onMeetingDetected();
  }

  // Observe DOM changes for meeting start/end
  state.mutationObserver = new MutationObserver(() => {
    const inMeeting = detectMeeting();
    if (inMeeting && !state.meetingDetected) {
      onMeetingDetected();
    } else if (!inMeeting && state.meetingDetected) {
      onMeetingEnded();
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

  // Emit session state change event
  emitEvent('session_state_changed', {
    previous_state: 'ready',
    new_state: 'active',
    reason: 'coaching_enabled',
  });
}

/** Observe Google Meet DOM for speech/participant indicators */
function observeSpeechIndicators(): void {
  // Google Meet shows visual indicators when participants speak
  // This observer watches for those changes
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      // Detect speaking indicators (blue border, audio wave animations)
      if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
        const target = mutation.target as HTMLElement;
        checkSpeechState(target);
      }
    }
  });

  observer.observe(document.body, {
    attributes: true,
    subtree: true,
    attributeFilter: ['class', 'data-self-name'],
  });
}

/** Check if a DOM change indicates speech activity */
function checkSpeechState(element: HTMLElement): void {
  // Heuristic: Google Meet uses specific CSS classes for speaking indicators
  const classes = element.className || '';

  // Detect user speaking (self-view with active audio indicator)
  if (classes.includes('IisKdb') || classes.includes('gLhFNb')) {
    emitEvent('speech_started', { speaker: 'user', offset_ms: Date.now() }, 0.7);
  }
}

/** Emit a normalized event to the background service worker */
function emitEvent(
  eventType: string,
  payload: Record<string, unknown>,
  captureConfidence: number | null = null
): void {
  if (!state.meetingSessionId || !state.userId) return;

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

  // Header with label and dismiss button
  const header = document.createElement('div');
  header.className = 'gleameet-prompt-header';

  const label = document.createElement('span');
  label.className = 'gleameet-prompt-label';
  label.textContent = `Coach \u00b7 ${prompt.prompt_type}`;

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'gleameet-prompt-dismiss';
  dismissBtn.textContent = '\u00d7';
  dismissBtn.title = 'Dismiss';
  dismissBtn.addEventListener('click', () => dismissPrompt(prompt.prompt_id));

  header.appendChild(label);
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
