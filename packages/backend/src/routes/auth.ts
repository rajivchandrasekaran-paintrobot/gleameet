import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthSessionRequest, AuthSessionResponse } from '@gleameet/shared';
import { upsertUser } from '../db/queries';
import { redis } from '../db/redis';
import { pool } from '../db/pool';

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
      const nodeFetch = (await import('node-fetch')).default;
      const tokenPrefix = google_id_token.substring(0, 10);
      console.log(`[AUTH] Verifying token (prefix: ${tokenPrefix}..., length: ${google_id_token.length})`);

      // Try userinfo endpoint first
      const userInfoRes = await nodeFetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${google_id_token}` }
      });
      const userInfoBody = await userInfoRes.text();
      console.log(`[AUTH] userinfo status: ${userInfoRes.status}, body: ${userInfoBody.slice(0, 200)}`);

      let parsed: any = {};
      try { parsed = JSON.parse(userInfoBody); } catch (_) {}

      if (userInfoRes.ok && parsed.sub) {
        googleSubjectId = parsed.sub;
        email = parsed.email || `user-${parsed.sub.slice(0, 8)}@gleameet.dev`;
        displayName = parsed.name || email;
        console.log(`[AUTH] Verified via userinfo: ${email}`);
      } else {
        // Fall back to tokeninfo
        const tokenInfoRes = await nodeFetch(
          `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${google_id_token}`
        );
        const tokenInfoBody = await tokenInfoRes.text();
        console.log(`[AUTH] tokeninfo status: ${tokenInfoRes.status}, body: ${tokenInfoBody.slice(0, 200)}`);

        let tokenParsed: any = {};
        try { tokenParsed = JSON.parse(tokenInfoBody); } catch (_) {}

        if (!tokenInfoRes.ok || !tokenParsed.sub) {
          res.status(401).json({ error: `Invalid Google token (userinfo: ${userInfoRes.status}, tokeninfo: ${tokenInfoRes.status})`, code: 'AUTH_INVALID_TOKEN' });
          return;
        }
        googleSubjectId = tokenParsed.sub;
        email = tokenParsed.email || `user-${tokenParsed.sub.slice(0, 8)}@gleameet.dev`;
        displayName = tokenParsed.name || email;
        console.log(`[AUTH] Verified via tokeninfo: ${email}`);
      }
    } catch (err) {
      console.error('[AUTH] Token verification error:', err);
      res.status(500).json({ error: 'Token verification failed', code: 'AUTH_ERROR' });
      return;
    }

    // Upsert user in Postgres
    const userId = await upsertUser(googleSubjectId, email, displayName);

    // Create session token — store in Redis (fast) AND Postgres (survives restarts)
    const sessionToken = `session:${userId}:${uuidv4()}`;
    const SESSION_TTL_SECONDS = 86400 * 30; // 30 days
    await redis.set(`session:${sessionToken}`, userId, 'EX', SESSION_TTL_SECONDS);
    await pool.query(
      `INSERT INTO user_sessions (session_token, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')
       ON CONFLICT (session_token) DO UPDATE SET last_used_at = NOW()`,
      [sessionToken, userId]
    );

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
