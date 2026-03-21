"use strict";
(() => {
  // src/utils/event-factory.ts
  function generateUUID() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === "x" ? r : r & 3 | 8;
      return v.toString(16);
    });
  }
  function createEvent(meetingSessionId, userId, eventType, payload, captureConfidence = null) {
    return {
      event_id: generateUUID(),
      meeting_session_id: meetingSessionId,
      user_id: userId,
      platform: "google_meet",
      event_type: eventType,
      event_time_utc: (/* @__PURE__ */ new Date()).toISOString(),
      source: "extension",
      capture_confidence: captureConfidence,
      payload
    };
  }

  // src/content/content-script.ts
  var state = {
    meetingDetected: false,
    meetingSessionId: null,
    userId: null,
    status: "off",
    currentPrompt: null,
    promptDismissTimer: null,
    mutationObserver: null,
    speechObserver: null,
    captionObserver: null,
    userSpeaking: false,
    lastSpeechEmitMs: 0
  };
  var SPEECH_THROTTLE_MS = 500;
  function detectMeeting() {
    const url = window.location.href;
    if (!/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(url)) {
      return false;
    }
    const meetIndicators = [
      "[data-meeting-code]",
      // Meeting code attribute
      "[data-call-id]",
      // Active call ID
      '[jscontroller="kAPMuc"]',
      // Meet call container
      "[data-self-name]",
      // Self-view with user name
      "div[data-allocation-index]"
      // Video grid tiles
    ];
    for (const selector of meetIndicators) {
      if (document.querySelector(selector)) return true;
    }
    const toolbar = document.querySelector('[jscontroller="KnNaaB"]') || document.querySelector('[data-tooltip-id="tt-c9"]');
    return !!toolbar;
  }
  function startMeetingDetection() {
    if (detectMeeting() && !state.meetingDetected) {
      onMeetingDetected();
    }
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
      subtree: true
    });
  }
  function onMeetingDetected() {
    state.meetingDetected = true;
    state.status = "ready";
    chrome.runtime.sendMessage({ type: "MEETING_DETECTED" }).catch(() => {
    });
    injectStatusIndicator();
    console.log("[GleaMeet] Meeting detected");
  }
  function onMeetingEnded() {
    state.meetingDetected = false;
    if (state.status === "active") {
      chrome.runtime.sendMessage({ type: "STOP_COACHING" }).catch(() => {
      });
    }
    state.status = "off";
    state.meetingSessionId = null;
    if (state.speechObserver) {
      state.speechObserver.disconnect();
      state.speechObserver = null;
    }
    if (state.captionObserver) {
      state.captionObserver.disconnect();
      state.captionObserver = null;
    }
    removeOverlay();
    removeStatusIndicator();
    console.log("[GleaMeet] Meeting ended");
  }
  function startSignalCapture() {
    if (!state.meetingSessionId || !state.userId) return;
    observeSpeechIndicators();
    observeCaptions();
    emitEvent("session_state_changed", {
      previous_state: "ready",
      new_state: "active",
      reason: "coaching_enabled"
    });
  }
  function observeSpeechIndicators() {
    if (state.speechObserver) {
      state.speechObserver.disconnect();
    }
    startMicrophoneDetection();
    state.speechObserver = new MutationObserver(() => {
    });
    state.speechObserver.observe(document.body, { childList: true, subtree: false });
  }
  var recognition = null;
  function startMicrophoneDetection() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn("[GleaMeet] SpeechRecognition not available");
      return;
    }
    function startRecognition() {
      recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      recognition.onstart = () => {
        console.log("[GleaMeet] Speech recognition active");
      };
      recognition.onspeechstart = () => {
        const now = Date.now();
        if (!state.userSpeaking && now - state.lastSpeechEmitMs > SPEECH_THROTTLE_MS) {
          state.userSpeaking = true;
          state.lastSpeechEmitMs = now;
          emitEvent("speech_started", { speaker: "user", offset_ms: now }, 0.9);
        }
      };
      recognition.onspeechend = () => {
        const now = Date.now();
        if (state.userSpeaking) {
          state.userSpeaking = false;
          state.lastSpeechEmitMs = now;
          emitEvent("speech_ended", { speaker: "user", offset_ms: now }, 0.9);
        }
      };
      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0].transcript.trim();
          if (!text) continue;
          if (result.isFinal) {
            emitEvent("transcript_segment", {
              text,
              speaker: "user",
              start_offset_ms: Date.now(),
              end_offset_ms: Date.now()
            }, 0.9);
          }
        }
      };
      recognition.onerror = (event) => {
        if (event.error === "no-speech") return;
        console.warn("[GleaMeet] Speech recognition error:", event.error);
      };
      recognition.onend = () => {
        setTimeout(() => {
          try {
            startRecognition();
          } catch (e) {
          }
        }, 500);
      };
      try {
        recognition.start();
      } catch (e) {
        console.warn("[GleaMeet] Could not start speech recognition:", e);
      }
    }
    startRecognition();
  }
  function observeCaptions() {
    if (state.captionObserver) {
      state.captionObserver.disconnect();
    }
    state.captionObserver = new MutationObserver(() => {
      const captionContainers = document.querySelectorAll(
        '[jscontroller="D1tHje"] span, div[class*="iOzk7"] span, [data-speaker-id] span'
        // Speaker-tagged spans
      );
      for (const el of captionContainers) {
        const text = el.textContent?.trim();
        if (text && text.length > 2 && !el.getAttribute("data-gleameet-captured")) {
          el.setAttribute("data-gleameet-captured", "1");
          const speakerEl = el.closest("[data-speaker-id]") || el.closest("[data-self-name]");
          const isSelf = !!el.closest("[data-self-name]");
          const speaker = isSelf ? "user" : "other";
          emitEvent("transcript_segment", {
            text,
            speaker,
            start_offset_ms: Date.now(),
            end_offset_ms: Date.now()
          }, 0.6);
        }
      }
    });
    state.captionObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }
  function emitEvent(eventType, payload, captureConfidence = null) {
    if (!state.meetingSessionId || !state.userId) return;
    const event = createEvent(
      state.meetingSessionId,
      state.userId,
      eventType,
      payload,
      captureConfidence
    );
    chrome.runtime.sendMessage({ type: "INGEST_EVENT", event }).catch(() => {
    });
  }
  function createOverlay() {
    let overlay = document.getElementById("gleameet-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "gleameet-overlay";
      document.body.appendChild(overlay);
    }
    return overlay;
  }
  function removeOverlay() {
    const overlay = document.getElementById("gleameet-overlay");
    if (overlay) overlay.remove();
  }
  function showPrompt(prompt) {
    dismissCurrentPrompt();
    state.currentPrompt = prompt;
    const overlay = createOverlay();
    const promptEl = document.createElement("div");
    promptEl.className = "gleameet-prompt";
    promptEl.setAttribute("data-prompt-id", prompt.prompt_id);
    const header = document.createElement("div");
    header.className = "gleameet-prompt-header";
    const label = document.createElement("span");
    label.className = "gleameet-prompt-label";
    label.textContent = `Coach \xB7 ${prompt.prompt_type}`;
    const dismissBtn = document.createElement("button");
    dismissBtn.className = "gleameet-prompt-dismiss";
    dismissBtn.textContent = "\xD7";
    dismissBtn.title = "Dismiss";
    dismissBtn.addEventListener("click", () => dismissPrompt(prompt.prompt_id));
    header.appendChild(label);
    header.appendChild(dismissBtn);
    const text = document.createElement("div");
    text.className = "gleameet-prompt-text";
    text.textContent = prompt.short_text;
    promptEl.appendChild(header);
    promptEl.appendChild(text);
    if (prompt.rationale_text) {
      const rationale = document.createElement("div");
      rationale.className = "gleameet-prompt-rationale";
      rationale.textContent = prompt.rationale_text;
      promptEl.appendChild(rationale);
    }
    overlay.innerHTML = "";
    overlay.appendChild(promptEl);
    ackPrompt(prompt.prompt_id, "shown");
    state.promptDismissTimer = setTimeout(() => {
      dismissPrompt(prompt.prompt_id);
    }, 15e3);
  }
  function dismissCurrentPrompt() {
    if (state.currentPrompt) {
      dismissPrompt(state.currentPrompt.prompt_id);
    }
  }
  function dismissPrompt(promptId) {
    const overlay = document.getElementById("gleameet-overlay");
    if (overlay) {
      const el = overlay.querySelector(`[data-prompt-id="${promptId}"]`);
      if (el) el.remove();
    }
    if (state.promptDismissTimer) {
      clearTimeout(state.promptDismissTimer);
      state.promptDismissTimer = null;
    }
    if (state.currentPrompt?.prompt_id === promptId) {
      ackPrompt(promptId, "dismissed");
      state.currentPrompt = null;
    }
  }
  function ackPrompt(promptId, action) {
    chrome.runtime.sendMessage({
      type: "ACK_PROMPT",
      promptId,
      meetingSessionId: state.meetingSessionId,
      action
    }).catch(() => {
    });
  }
  function injectStatusIndicator() {
    removeStatusIndicator();
    const indicator = document.createElement("div");
    indicator.id = "gleameet-status";
    indicator.className = `gleameet-status ${state.status}`;
    const dot = document.createElement("span");
    dot.className = "gleameet-status-dot";
    const label = document.createElement("span");
    label.textContent = `GleaMeet: ${state.status}`;
    indicator.appendChild(dot);
    indicator.appendChild(label);
    document.body.appendChild(indicator);
  }
  function removeStatusIndicator() {
    const indicator = document.getElementById("gleameet-status");
    if (indicator) indicator.remove();
  }
  function updateStatusIndicator() {
    const indicator = document.getElementById("gleameet-status");
    if (indicator) {
      indicator.className = `gleameet-status ${state.status}`;
      const label = indicator.querySelector("span:last-child");
      if (label) label.textContent = `GleaMeet: ${state.status}`;
    }
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case "STATUS_UPDATE":
        state.status = message.status;
        state.meetingSessionId = message.meetingSessionId;
        updateStatusIndicator();
        break;
      case "SHOW_PROMPT":
        if (state.status === "active") {
          showPrompt(message.prompt);
        }
        break;
      case "COACHING_STARTED":
        state.meetingSessionId = message.meetingSessionId;
        state.userId = message.userId;
        state.status = "active";
        updateStatusIndicator();
        startSignalCapture();
        break;
      case "DISMISS_ALL_PROMPTS":
        dismissCurrentPrompt();
        break;
    }
    sendResponse({ ok: true });
    return true;
  });
  function showConsentDialog() {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.id = "gleameet-consent-backdrop";
      backdrop.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,0.5); display: flex;
      align-items: center; justify-content: center;
    `;
      const dialog = document.createElement("div");
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
      document.getElementById("gleameet-consent-accept").addEventListener("click", () => {
        backdrop.remove();
        resolve(true);
      });
      document.getElementById("gleameet-consent-cancel").addEventListener("click", () => {
        backdrop.remove();
        resolve(false);
      });
    });
  }
  window.__gleameet_showConsent = showConsentDialog;
  startMeetingDetection();
})();
