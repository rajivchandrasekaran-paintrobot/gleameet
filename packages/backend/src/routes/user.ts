import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { DeleteUserDataResponse } from '@gleameet/shared';
import { AuthenticatedRequest } from '../middleware/auth';
import { deleteAllUserData } from '../db/queries';
import { redis } from '../db/redis';

export const userRouter = Router();

/**
 * DELETE /user/data
 * Delete all user data (FR-078)
 */
userRouter.delete('/data', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;

    // Delete all user data from Postgres and create audit record
    const deletionAuditId = await deleteAllUserData(userId);

    // Clean up all Redis state for user's sessions
    const keys = await redis.keys(`gleameet:meeting:*`);
    for (const key of keys) {
      const stateStr = await redis.get(key.replace(/^gleameet:/, ''));
      if (stateStr) {
        try {
          const state = JSON.parse(stateStr);
          if (state.user_id === userId) {
            // Delete all keys for this session
            const sessionKeys = await redis.keys(`gleameet:meeting:${state.meeting_session_id}:*`);
            if (sessionKeys.length > 0) {
              await redis.del(...sessionKeys.map(k => k.replace(/^gleameet:/, '')));
            }
          }
        } catch { /* skip non-JSON keys */ }
      }
    }

    // Invalidate session token
    const sessionToken = req.sessionToken;
    if (sessionToken) {
      await redis.del(`session:${sessionToken}`);
    }

    console.log(`[USER] Full data deletion completed for user ${userId}`);

    const response: DeleteUserDataResponse = {
      deletion_audit_id: deletionAuditId,
      status: 'completed',
    };

    res.status(200).json(response);
  } catch (err) {
    console.error('[USER] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete user data', code: 'DELETE_ERROR' });
  }
});
