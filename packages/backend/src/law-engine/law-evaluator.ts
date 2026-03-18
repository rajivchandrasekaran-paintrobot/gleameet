import { LawRegistryEntry, LawTrigger, TriggerCondition, TriggerLogic } from '@gleameet/shared';
import { loadActiveLaws } from '@gleameet/law-registry';
import { FeatureSnapshot } from '../features/feature-engine';
import { MeetingState, isLawOnCooldown, setLawCooldown } from '../db/redis';
import { v4 as uuidv4 } from 'uuid';

/**
 * Evaluate all active laws against current feature state.
 * Returns law trigger candidates (FR-037 through FR-043).
 */
export async function evaluateLaws(
  meetingSessionId: string,
  features: FeatureSnapshot,
  state: MeetingState
): Promise<LawTrigger[]> {
  const activeLaws = loadActiveLaws();
  const triggers: LawTrigger[] = [];

  for (const law of activeLaws) {
    const trigger = await evaluateSingleLaw(law, meetingSessionId, features, state);
    if (trigger) {
      triggers.push(trigger);
    }
  }

  return triggers;
}

/**
 * Evaluate a single law against current features.
 * Returns a LawTrigger if conditions are met, null otherwise.
 */
async function evaluateSingleLaw(
  law: LawRegistryEntry,
  meetingSessionId: string,
  features: FeatureSnapshot,
  state: MeetingState
): Promise<LawTrigger | null> {
  // FR-042: Check cooldown at the law level
  const onCooldown = await isLawOnCooldown(meetingSessionId, law.law_id);
  if (onCooldown) {
    return null;
  }

  // FR-041: Check disconfirming logic first — suppress if disconfirming conditions are met
  if (evaluateLogic(law.disconfirming_logic, features)) {
    return null;
  }

  // Evaluate trigger logic
  if (!evaluateLogic(law.trigger_logic, features)) {
    return null;
  }

  // Compute trigger confidence based on feature availability and strength
  const confidence = computeTriggerConfidence(law, features);

  // FR-043: Do not trigger if confidence is below threshold
  if (confidence < law.confidence_threshold) {
    return null;
  }

  // Build evidence refs from features that contributed to the trigger
  const evidenceRefs = law.observable_inputs.map(input => ({
    event_id: meetingSessionId,
    feature_name: input,
    description: `Feature ${input} = ${features[input]}`,
  }));

  // Build feature snapshot for the trigger
  const featureSnapshot: Record<string, number | boolean> = {};
  for (const input of law.observable_inputs) {
    if (features[input] !== undefined) {
      featureSnapshot[input] = features[input] as number | boolean;
    }
  }

  // Set cooldown for this law (FR-042)
  await setLawCooldown(meetingSessionId, law.law_id, law.cooldown_seconds);

  const trigger: LawTrigger = {
    trigger_id: uuidv4(),
    meeting_session_id: meetingSessionId,
    law_id: law.law_id,
    law_version: law.version,
    triggered_at: new Date().toISOString(),
    trigger_confidence: confidence,
    evidence_refs_json: evidenceRefs,
    feature_snapshot_json: featureSnapshot,
    suppressed_reason: null,
  };

  console.log(`[LAW] Triggered ${law.law_id} (${law.law_name}) with confidence ${confidence.toFixed(3)}`);
  return trigger;
}

/**
 * Evaluate trigger or disconfirming logic against feature values.
 * Supports both "all" (AND) and "any" (OR) combinators.
 */
function evaluateLogic(logic: TriggerLogic, features: FeatureSnapshot): boolean {
  if (logic.all) {
    return logic.all.every(cond => evaluateCondition(cond, features));
  }
  if (logic.any) {
    return logic.any.some(cond => evaluateCondition(cond, features));
  }
  return false;
}

/** Evaluate a single feature condition */
function evaluateCondition(cond: TriggerCondition, features: FeatureSnapshot): boolean {
  const value = features[cond.feature];

  // If the required feature is missing, condition fails (FR-043)
  if (value === undefined) {
    return false;
  }

  switch (cond.op) {
    case 'eq':  return value === cond.value;
    case 'ne':  return value !== cond.value;
    case 'gt':  return (value as number) > (cond.value as number);
    case 'lt':  return (value as number) < (cond.value as number);
    case 'gte': return (value as number) >= (cond.value as number);
    case 'lte': return (value as number) <= (cond.value as number);
    default:    return false;
  }
}

/**
 * Compute trigger confidence based on feature availability and strength.
 * Returns a value between 0 and 1.
 */
function computeTriggerConfidence(law: LawRegistryEntry, features: FeatureSnapshot): number {
  const inputs = law.observable_inputs;
  let availableCount = 0;
  let totalStrength = 0;

  for (const input of inputs) {
    if (features[input] !== undefined) {
      availableCount++;

      // For boolean features, full strength if true
      const val = features[input];
      if (typeof val === 'boolean') {
        totalStrength += val ? 1.0 : 0.0;
      } else {
        // For numeric features, normalize to 0-1 range (capped)
        totalStrength += Math.min(Math.abs(val as number), 1.0);
      }
    }
  }

  if (inputs.length === 0) return 0;

  // Confidence = (availability_ratio * 0.4) + (mean_strength * 0.6)
  const availabilityRatio = availableCount / inputs.length;
  const meanStrength = availableCount > 0 ? totalStrength / availableCount : 0;

  return (availabilityRatio * 0.4) + (meanStrength * 0.6);
}
