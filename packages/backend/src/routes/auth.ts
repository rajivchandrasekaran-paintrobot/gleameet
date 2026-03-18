import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthSessionRequest, AuthSessionResponse } from '@gleameet/shared';

export const authRouter = Router();

/**
 * POST /auth/session
 * Establish authenticated session for extension (FR-001 through FR-004)
 */
authRouter.post('/session', async (req: Request, res: Response) => {
  try {
    const { google_id_token } = req.body as AuthSessionRequest;

    if (!google_id_token) {
      res.status(400).json({ error: 'Missing google_id_token', code: 'INVALID_REQUEST' });
      return;
    }

    // TODO: Verify Google ID token with Google's OAuth2 API
    // For scaffold, create a mock session
    const userId = uuidv4();
    const sessionToken = `session:${userId}:${uuidv4()}`;

    const response: AuthSessionResponse = {
      session_token: sessionToken,
      user_id: userId,
      preferences: {
        coaching_intensity: 'standard',
        enabled_prompt_categories: ['pause', 'acknowledge', 'ask', 'frame', 'close'],
        retention: {
          raw_transcript_days: 7,
          derived_features_days: 30,
          prompts_days: 90,
          reports_days: 365,
        },
        global_cooldown_seconds: 60,
      },
    };

    res.status(200).json(response);
  } catch (err) {
    console.error('[AUTH] Session creation error:', err);
    res.status(500).json({ error: 'Session creation failed', code: 'AUTH_ERROR' });
  }
});
