import type { Platform } from '@gleameet/shared';

export interface PlatformCapabilities {
  supportsDomSpeechSignals: boolean;
  supportsDomCaptions: boolean;
  supportsMicSpeechDetection: boolean;
  supportsTabAudioCapture: boolean;
}

export const MEETING_TAB_URL_PATTERNS = [
  'https://meet.google.com/*',
  'https://teams.microsoft.com/*',
  'https://teams.live.com/*',
  'https://zoom.us/wc/*',
  'https://app.zoom.us/wc/*',
] as const;

export function detectPlatformFromUrl(url: string): Platform | null {
  if (url.includes('meet.google.com')) return 'google_meet';
  if (url.includes('teams.microsoft.com') || url.includes('teams.live.com')) return 'teams';
  if (url.includes('zoom.us') || url.includes('app.zoom.us')) return 'zoom';
  return null;
}

export function getPlatformCapabilities(platform: Platform): PlatformCapabilities {
  switch (platform) {
    case 'google_meet':
      return {
        supportsDomSpeechSignals: true,
        supportsDomCaptions: true,
        supportsMicSpeechDetection: true,
        supportsTabAudioCapture: true,
      };
    case 'teams':
    case 'zoom':
      return {
        supportsDomSpeechSignals: false,
        supportsDomCaptions: false,
        supportsMicSpeechDetection: true,
        supportsTabAudioCapture: true,
      };
    default:
      return {
        supportsDomSpeechSignals: false,
        supportsDomCaptions: false,
        supportsMicSpeechDetection: false,
        supportsTabAudioCapture: false,
      };
  }
}

export function getPlatformDisplayName(platform: Platform | null): string {
  switch (platform) {
    case 'google_meet':
      return 'Google Meet';
    case 'teams':
      return 'Microsoft Teams';
    case 'zoom':
      return 'Zoom';
    case 'slack':
      return 'Slack';
    default:
      return 'meeting';
  }
}
