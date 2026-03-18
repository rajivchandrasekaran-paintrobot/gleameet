import { Request, Response, NextFunction } from 'express';

/** Authenticated request with user context */
export interface AuthenticatedRequest extends Request {
  userId?: string;
  sessionToken?: string;
}

/**
 * Authentication middleware.
 * In production, validates JWT/session token against the session store.
 * For v1 scaffold, extracts user_id from Authorization header.
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

  // TODO: Validate token against session store / JWT verification
  // For scaffold, we decode a simple session token format
  req.sessionToken = token;
  req.userId = extractUserIdFromToken(token);

  if (!req.userId) {
    res.status(401).json({ error: 'Invalid session token', code: 'AUTH_INVALID' });
    return;
  }

  next();
}

function extractUserIdFromToken(token: string): string | undefined {
  // Placeholder: in production, verify JWT or look up session in Redis
  // For now, accept tokens in format "session:<user_id>:<random>"
  const parts = token.split(':');
  if (parts.length >= 2 && parts[0] === 'session') {
    return parts[1];
  }
  return undefined;
}
