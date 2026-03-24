import zoomSdk from '@zoom/appssdk';
import { createSession } from './api-client';

export async function getGleameetSession(): Promise<{ sessionToken: string; userId: string }> {
  // Initialize Zoom Apps SDK with required capabilities
  await zoomSdk.config({
    capabilities: ['getRunningContext', 'getMeetingUUID', 'getUserContext'],
  });

  // Get user context from Zoom
  // NOTE: Full Zoom OAuth token exchange requires Zoom developer credentials.
  // For now, we use getUserContext as a stub. When Zoom dev credentials are
  // available, this should be replaced with a proper OAuth code flow:
  //   1. zoomSdk.authorize() to get authorization code
  //   2. Exchange code for access token via backend
  //   3. Pass access token to createSession()
  const ctx = await zoomSdk.getUserContext();
  const token = ctx.screenName; // placeholder — actual token from Zoom OAuth flow

  // Exchange with Gleameet backend
  const result = await createSession(token);

  return { sessionToken: result.session_token, userId: result.user_id };
}
