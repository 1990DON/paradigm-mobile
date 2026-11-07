import {
  ActivityCategory,
  ActivitySessionId,
  CanonicalEventId,
  EconomyVersion,
  UserId,
  XPEntry,
  XPEntryId,
  parseXPEntryId,
} from './canonicalDomain';
import { calculateWalkingXp, WALK_XP_PER_KM } from './stage6Simulation';
import { SessionProcessor } from './sessionProcessor';

export type ScoringStatus =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'DEFERRED'
  | 'IDEMPOTENT_REPLAY'
  | 'CONFLICT';

export type ScoringPolicyId =
  | 'stage6-baseline-walking-v1'
  | 'undefined-presence-v1'
  | 'undefined-participation-v1';

export type ScoringPolicySelection = {
  policyId: ScoringPolicyId;
  economyVersion: EconomyVersion;
};

export interface ScoringPolicy {
  readonly policyId: ScoringPolicyId;
  readonly category: ActivityCategory;
  readonly economyVersion: EconomyVersion;
  readonly enabled: boolean;
}

export const STAGE6_BASELINE_WALKING_POLICY: ScoringPolicy = {
  policyId: 'stage6-baseline-walking-v1',
  category: 'walking',
  economyVersion: {
    scope: 'live',
    version: 'stage6-baseline-walking-v1',
  },
  enabled: true,
};

export const UNDEFINED_PRESENCE_POLICY: ScoringPolicy = {
  policyId: 'undefined-presence-v1',
  category: 'presence',
  economyVersion: {
    scope: 'live',
    version: 'undefined-presence-v1',
  },
  enabled: false,
};

export const UNDEFINED_PARTICIPATION_POLICY: ScoringPolicy = {
  policyId: 'undefined-participation-v1',
  category: 'participation',
  economyVersion: {
    scope: 'live',
    version: 'undefined-participation-v1',
  },
  enabled: false,
};

export type ScoreActivityInput = {
  userId: UserId;
  sessionId: ActivitySessionId;
  eventId: CanonicalEventId;
  policy: ScoringPolicy;
};

export type ScoringResult =
  | { status: 'ACCEPTED'; award: XPEntry; reason?: never }
  | { status: 'IDEMPOTENT_REPLAY'; award: XPEntry; reason?: never }
  | { status: 'REJECTED'; errors: readonly string[]; reason?: never }
  | { status: 'DEFERRED'; reason: string; errors?: never }
  | { status: 'CONFLICT'; errors: readonly string[]; reason?: never };

function sameEconomy(first: EconomyVersion, second: EconomyVersion): boolean {
  return (
    first.scope === second.scope &&
    first.version === second.version &&
    (first.scope !== 'simulation' ||
      second.scope !== 'simulation' ||
      first.candidateId === second.candidateId)
  );
}

function sameAward(first: XPEntry, second: XPEntry): boolean {
  return (
    first.id === second.id &&
    first.idempotencyKey === second.idempotencyKey &&
    first.userId === second.userId &&
    first.source.activitySessionId === second.source.activitySessionId &&
    first.source.evidence?.eventId === second.source.evidence?.eventId &&
    first.category === second.category &&
    first.amount === second.amount &&
    first.awardedAt === second.awardedAt &&
    sameEconomy(first.economyVersion, second.economyVersion) &&
    (
      first.source.evidence?.observationIds.length ===
      second.source.evidence?.observationIds.length &&
      (first.source.evidence?.observationIds.every(
        (observationId, index) =>
          observationId === second.source.evidence?.observationIds[index],
      ) ?? true)
    )
  );
}

function roundStage6WalkingXp(distanceMeters: number): number {
  const distanceKm = distanceMeters / 1000;
  const amount = calculateWalkingXp(distanceKm, WALK_XP_PER_KM);
  const precision = 1000000;
  return Math.round((amount + Number.EPSILON) * precision) / precision;
}

export class ScoringPipeline {
  constructor(private readonly processor: SessionProcessor) {}

  evaluate(input: ScoreActivityInput): ScoringResult {
    if (
      input.policy.category === 'walking' &&
      (
        input.policy.economyVersion.scope !==
          STAGE6_BASELINE_WALKING_POLICY.economyVersion.scope ||
        input.policy.economyVersion.version !==
          STAGE6_BASELINE_WALKING_POLICY.economyVersion.version ||
        (
          STAGE6_BASELINE_WALKING_POLICY.economyVersion.scope === 'simulation' &&
          input.policy.economyVersion.scope === 'simulation' &&
          input.policy.economyVersion.candidateId !==
            STAGE6_BASELINE_WALKING_POLICY.economyVersion.candidateId
        )
      )
    ) {
      return {
        status: 'CONFLICT',
        errors: ['Walking policy economyVersion must exactly match the live Stage 6 baseline policy.'],
      };
    }
    if (
      input.policy.category === 'walking' &&
      input.policy.policyId !== STAGE6_BASELINE_WALKING_POLICY.policyId
    ) {
      return {
        status: 'CONFLICT',
        errors: ['Walking policy selection conflicts with the policy category.'],
      };
    }
    if (
      input.policy.category === 'presence' &&
      input.policy.policyId !== UNDEFINED_PRESENCE_POLICY.policyId
    ) {
      return {
        status: 'CONFLICT',
        errors: ['Presence policy selection conflicts with the policy category.'],
      };
    }
    if (
      input.policy.category === 'participation' &&
      input.policy.policyId !== UNDEFINED_PARTICIPATION_POLICY.policyId
    ) {
      return {
        status: 'CONFLICT',
        errors: ['Participation policy selection conflicts with the policy category.'],
      };
    }

    const preliminaryHistory = this.processor.getHistory(input.userId);
    const preliminarySession = preliminaryHistory.sessions.find(
      (item) => item.activity.id === input.sessionId,
    );
    if (
      preliminarySession &&
      preliminarySession.activity.activityType !== input.policy.category
    ) {
      return {
        status: 'CONFLICT',
        errors: ['Scoring policy category does not match the activity session category.'],
      };
    }

    if (!input.policy.enabled) {
      return {
        status: 'DEFERRED',
        reason: `${input.policy.category} reward policy is undefined; no award was created.`,
      };
    }

    const history = this.processor.getHistory(input.userId);
    const sessionRecord = history.sessions.find(
      (item) => item.activity.id === input.sessionId,
    );
    if (!sessionRecord) {
      return { status: 'REJECTED', errors: ['Session does not exist for this user.'] };
    }
    if (sessionRecord.lifecycle !== 'completed') {
      return { status: 'REJECTED', errors: ['Activity must be completed before scoring.'] };
    }

    const event = history.events.find((item) => item.id === input.eventId);
    if (!event) {
      return { status: 'REJECTED', errors: ['Accepted canonical event does not exist.'] };
    }
    if (event.userId !== input.userId || event.sessionId !== input.sessionId) {
      return { status: 'REJECTED', errors: ['Event is contaminated by another user or session.'] };
    }
    if (event.evidenceStatus !== 'verified') {
      return { status: 'REJECTED', errors: ['Live walking evidence must be verified.'] };
    }

    const session = sessionRecord.activity;
    if (session.activityType !== 'walking' || input.policy.category !== 'walking') {
      return {
        status: 'REJECTED',
        errors: ['Walking policy requires a completed walking session and event category.'],
      };
    }
    if (event.kind !== 'walking_observation') {
      return { status: 'REJECTED', errors: ['Event category is not walking.'] };
    }
    if (session.evidence.distanceSource !== 'measured') {
      return {
        status: 'REJECTED',
        errors: ['Walking distance must come from measured validated evidence.'],
      };
    }
    if (
      !Number.isFinite(session.evidence.distanceMeters) ||
      session.evidence.distanceMeters <= 0
    ) {
      return { status: 'REJECTED', errors: ['Walking distance is invalid or unavailable.'] };
    }

    const observations = event.observationIds.map((observationId) =>
      history.observations.find((observation) => observation.id === observationId),
    );
    if (observations.some((observation) => observation === undefined)) {
      return { status: 'REJECTED', errors: ['Event contains unknown observation evidence.'] };
    }
    const validObservations = observations.filter(
      (observation): observation is NonNullable<typeof observation> =>
        observation !== undefined,
    );
    if (validObservations.some((observation) =>
      observation.userId !== input.userId ||
      observation.sessionId !== input.sessionId ||
      observation.kind !== 'walking' ||
      observation.evidenceStatus !== 'verified' ||
      observation.source === 'simulation' ||
      observation.source === 'simulated'
    )) {
      return {
        status: 'REJECTED',
        errors: ['Walking event contains simulated, unverified, or unrelated evidence.'],
      };
    }

    const sameSessionWalkingEvents = history.events.filter((item) =>
      item.sessionId === input.sessionId &&
      item.kind === 'walking_observation',
    );
    if (sameSessionWalkingEvents.length !== 1 || sameSessionWalkingEvents[0].id !== event.id) {
      return {
        status: 'REJECTED',
        errors: ['Overlapping or duplicate walking events cannot be scored twice.'],
      };
    }
    const observationIds = [...new Set(validObservations.map((observation) => observation.id))];
    if (observationIds.length !== validObservations.length) {
      return { status: 'REJECTED', errors: ['Duplicate walking observation evidence.'] };
    }
    if (
      event.observationIds.length !== observationIds.length ||
      observationIds.some(
        (observationId, index) =>
          observationId !== event.observationIds[index],
      )
    ) {
      return {
        status: 'REJECTED',
        errors: ['Walking award evidence must match the complete canonical event observation set.'],
      };
    }
    const sessionWalkingObservations = history.observations.filter((observation) =>
      observation.sessionId === input.sessionId &&
      observation.kind === 'walking',
    );
    if (
      sessionWalkingObservations.length !== observationIds.length ||
      sessionWalkingObservations.some((observation) =>
        !observationIds.includes(observation.id),
      )
    ) {
      return {
        status: 'REJECTED',
        errors: ['Session has unaccounted or overlapping walking observations.'],
      };
    }

    const amount = roundStage6WalkingXp(session.evidence.distanceMeters);
    if (!Number.isFinite(amount) || amount < 0) {
      return { status: 'REJECTED', errors: ['Scoring calculation produced an invalid XP amount.'] };
    }

    const awardIdValue = `xp:${input.sessionId}:walking:${input.policy.policyId}`;
    const awardId = parseXPEntryId(awardIdValue);
    if (!awardId) {
      return { status: 'REJECTED', errors: ['Could not create a stable award identity.'] };
    }
    const idempotencyKey =
      `award:${input.sessionId}:walking:${input.policy.policyId}:${input.policy.economyVersion.version}`;
    const candidate: XPEntry = {
      id: awardId as XPEntryId,
      idempotencyKey,
      userId: input.userId,
      source: {
        activitySessionId: input.sessionId,
        evidence: {
          eventId: input.eventId,
          observationIds,
        },
      },
      category: 'walking',
      amount,
      economyVersion: input.policy.economyVersion,
      awardedAt: sessionRecord.activity.status === 'completed'
        ? sessionRecord.activity.completedAt
        : sessionRecord.activity.startedAt,
    };

    const existing = history.xpEntries.find((entry) =>
      entry.id === candidate.id || entry.idempotencyKey === candidate.idempotencyKey,
    );
    if (existing) {
      if (sameAward(existing, candidate)) {
        return { status: 'IDEMPOTENT_REPLAY', award: existing };
      }
      return {
        status: 'CONFLICT',
        errors: ['Award identity or idempotency key conflicts with an existing award.'],
      };
    }

    const accepted = this.processor.recordAward(candidate);
    if (!accepted.accepted) {
      return { status: 'REJECTED', errors: accepted.errors };
    }
    const saved = this.processor.getHistory(input.userId).xpEntries.find(
      (entry) => entry.id === candidate.id,
    );
    return { status: 'ACCEPTED', award: saved ?? accepted.value };
  }
}
