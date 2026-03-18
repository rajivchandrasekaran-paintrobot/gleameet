import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { DeleteUserDataResponse } from '@gleameet/shared';
import { AuthenticatedRequest } from '../middleware/auth';

export const userRouter = Router();

/**
 * DELETE /user/data
 * Delete all user data (FR-078)
 */
userRouter.delete('/data', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;

    // TODO: Delete all user data from Postgres (cascading from users table)
    // TODO: Clean up all Redis state for user's sessions
    // TODO: Create deletion audit record
    const deletionAuditId = uuidv4();

    console.log(`[USER] Full data deletion requested for user ${userId}`);

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
