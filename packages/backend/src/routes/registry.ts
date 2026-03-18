import { Router, Response } from 'express';
import { RegistryActiveResponse } from '@gleameet/shared';
import { AuthenticatedRequest } from '../middleware/auth';
import { loadActiveLaws, getRegistryVersion } from '@gleameet/law-registry';

export const registryRouter = Router();

/**
 * GET /registry/active
 * Fetch active registry entries (FR-030 through FR-036)
 */
registryRouter.get('/active', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const laws = loadActiveLaws();
    const registryVersion = getRegistryVersion();

    const response: RegistryActiveResponse = {
      laws,
      registry_version: registryVersion,
    };

    res.status(200).json(response);
  } catch (err) {
    console.error('[REGISTRY] Fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch registry', code: 'REGISTRY_ERROR' });
  }
});
