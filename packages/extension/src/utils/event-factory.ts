import type { RawEvent, EventType, Platform } from '@gleameet/shared';

/** Generate a UUID v4 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Create a normalized raw event per FR-020 */
export function createEvent(
  meetingSessionId: string,
  userId: string,
  eventType: EventType,
  payload: Record<string, unknown>,
  captureConfidence: number | null = null
): RawEvent {
  return {
    event_id: generateUUID(),
    meeting_session_id: meetingSessionId,
    user_id: userId,
    platform: 'google_meet' as Platform,
    event_type: eventType,
    event_time_utc: new Date().toISOString(),
    source: 'extension',
    capture_confidence: captureConfidence,
    payload,
  };
}
