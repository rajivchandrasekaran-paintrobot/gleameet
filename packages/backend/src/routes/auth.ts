import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthSessionRequest, AuthSessionResponse } from '@gleameet/shared';
import { upsertUser } from '../db/queries';
import { redis } from '../db/redis';

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

    let googleSubjectId: string;
    let email: string;
    let displayName: string;

    try {
      // Verify token with Google
      const tokenInfoUrl = `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${google_id_token}`;
      const fetch = (await import("node-fetch")).default;
      const tokenRes = await fetch(tokenInfoUrl);
      if (!tokenRes.ok) {
        res.status(401).json({ error: "Invalid Google token", code: "AUTH_INVALID_TOKEN" });
        return;
      }
      const tokenInfo = await tokenRes.json() as any;
      if (!tokenInfo.sub) {
        res.status(401).json({ error: "Invalid Google token", code: "AUTH_INVALID_TOKEN" });
        return;
      }
      googleSubjectId = tokenInfo.sub;
      email = tokenInfo.email || `user-${tokenInfo.sub.slice(0, 8)}@gleameet.dev`;
      displayName = tokenInfo.name || `User ${tokenInfo.sub.slice(0, 8)}`;
    } catch (err) {
      console.error("[AUTH] Token verification error:", err);
      res.status(500).json({ error: "Token verification failed", code: "AUTH_ERROR" });
      return;
    }

    // Upsert user in Postgres
    const userId = await upsertUser(googleSubjectId, email, displayName);

    // Create session token and store in Redis (24h TTL)
    const sessionToken = `session:${userId}:${uuidv4()}`;
    await redis.set(`session:${sessionToken}`, userId, 'EX', 86400);

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

    console.log(`[AUTH] Session created for user ${userId}`);
    res.status(200).json(response);
  } catch (err) {
    console.error('[AUTH] Session creation error:', err);
    res.status(500).json({ error: 'Session creation failed', code: 'AUTH_ERROR' });
  }
});
