import { Request, Response, NextFunction } from 'express';
import { redis } from '../db/redis';
import { pool } from '../db/pool';

/** Authenticated request with user context */
export interface AuthenticatedRequest extends Request {
  userId?: string;
  sessionToken?: string;
}

/**
 * Authentication middleware.
 * Validates session token against Redis (fast) with Postgres fallback (survives restarts).
 */
export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header', code: 'AUTH_REQUIRED' });
    return;
  }

  const token = authHeader.slice(7);
  if (!token) {
    res.status(401).json({ error: 'Empty token', code: 'AUTH_REQUIRED' });
    return;
  }

  req.sessionToken = token;

  // Validate async: Redis first, Postgres fallback
  validateSession(token).then(userId => {
    if (!userId) {
      res.status(401).json({ error: 'Invalid session token', code: 'AUTH_INVALID' });
      return;
    }
    req.userId = userId;
    next();
  }).catch(err => {
    console.error('[AUTH] Session validation error:', err.message);
    res.status(500).json({ error: 'Auth validation failed', code: 'AUTH_ERROR' });
  });
}

async function validateSession(token: string): Promise<string | null> {
  // 1. Check Redis (fast path)
  try {
    const userId = await redis.get(`session:${token}`);
    if (userId) return userId;
  } catch (err) {
    console.warn('[AUTH] Redis check failed, falling back to Postgres:', (err as Error).message);
  }

  // 2. Postgres fallback (survives Redis restarts)
  try {
    const result = await pool.query(
      `SELECT user_id FROM user_sessions
       WHERE session_token = $1 AND expires_at > NOW()`,
      [token]
    );
    if (result.rows[0]) {
      const userId = result.rows[0].user_id;
      // Restore to Redis for future fast lookups (30 days)
      redis.set(`session:${token}`, userId, 'EX', 86400 * 30).catch(() => {});
      // Update last_used_at
      pool.query(
        'UPDATE user_sessions SET last_used_at = NOW() WHERE session_token = $1',
        [token]
      ).catch(() => {});
      return userId;
    }
  } catch (err) {
    console.error('[AUTH] Postgres session lookup failed:', (err as Error).message);
  }

  return null;
}
