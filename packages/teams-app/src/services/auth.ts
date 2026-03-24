import * as microsoftTeams from '@microsoft/teams-js';
import { createSession } from './api-client';

export async function getGleameetSession(): Promise<{ sessionToken: string; userId: string }> {
  await microsoftTeams.app.initialize();

  // Get Teams SSO token
  const token = await microsoftTeams.authentication.getAuthToken();

  // Exchange with Gleameet backend (backend accepts any OAuth token and validates via userinfo)
  const result = await createSession(token);

  return { sessionToken: result.session_token, userId: result.user_id };
}
