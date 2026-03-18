import * as fs from 'fs';
import * as path from 'path';
import { LawRegistryEntry, LawStatus } from '@gleameet/shared';

const LAWS_DIR = path.resolve(__dirname, '..', 'laws');

/** Load all law definitions from the laws/ directory */
export function loadAllLaws(): LawRegistryEntry[] {
  const files = fs.readdirSync(LAWS_DIR).filter(f => f.endsWith('.json'));
  return files.map(file => {
    const content = fs.readFileSync(path.join(LAWS_DIR, file), 'utf-8');
    return JSON.parse(content) as LawRegistryEntry;
  });
}

/** Load only laws with the given status */
export function loadLawsByStatus(status: LawStatus): LawRegistryEntry[] {
  return loadAllLaws().filter(law => law.status === status);
}

/** Load only active laws (FR-033: only active laws may generate prompts) */
export function loadActiveLaws(): LawRegistryEntry[] {
  return loadLawsByStatus('active');
}

/** Load a single law by ID */
export function loadLawById(lawId: string): LawRegistryEntry | undefined {
  return loadAllLaws().find(law => law.law_id === lawId);
}

/** Get a registry version hash based on all active law versions */
export function getRegistryVersion(): string {
  const laws = loadActiveLaws();
  const versionString = laws
    .sort((a, b) => a.law_id.localeCompare(b.law_id))
    .map(l => `${l.law_id}:${l.version}`)
    .join('|');
  // Simple hash for version tracking
  let hash = 0;
  for (let i = 0; i < versionString.length; i++) {
    const chr = versionString.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return `v1-${Math.abs(hash).toString(36)}`;
}
