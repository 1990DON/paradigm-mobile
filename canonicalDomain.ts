import {
  BehavioralSignals,
  CompletedSession,
  deriveBehavioralSignals,
} from './behavioralSignals';

declare const userIdBrand: unique symbol;
declare const nodeIdBrand: unique symbol;
declare const activitySessionIdBrand: unique symbol;
declare const xpEntryIdBrand: unique symbol;

export type UserId = string & { readonly [userIdBrand]: true };
export type NodeId = string & { readonly [nodeIdBrand]: true };
export type ActivitySessionId = string & {
  readonly [activitySessionIdBrand]: true;
};
export type XPEntryId = string & { readonly [xpEntryIdBrand]: true };

function parseId<Id extends string>(
  value: string,
): Id | null {
  return value.trim().length > 0 ? (value as Id) : null;
}

export const parseUserId = (value: string): UserId | null =>
  parseId<UserId>(value);
export const parseNodeId = (value: string): NodeId | null =>
  parseId<NodeId>(value);
export const parseActivitySessionId = (
  value: string,
): ActivitySessionId | null => parseId<ActivitySessionId>(value);
export const parseXPEntryId = (value: string): XPEntryId | null =>
  parseId<XPEntryId>(value);

export type UserRecord = {
  id: UserId;
  createdAt: number;
  updatedAt: number;
};

export type GeographicLocation = {
  latitude: number;
  longitude: number;
};

export type NodeGeography =
  | { verification: 'unverified' }
  | {
      verification: 'verified';
      location: GeographicLocation;
      boundary: readonly GeographicLocation[];
    };

export type NodeRecord = {
  id: NodeId;
  name: string;
  geography: NodeGeography;
};

export const EXISTING_NODE_IDS = [
  'court',
  'bodega',
  'transit',
  'park',
] as const;

export const EXISTING_NODE_RECORDS: readonly NodeRecord[] = [
  {
    id: parseNodeId('court')!,
    name: 'Basketball Court',
    geography: { verification: 'unverified' },
  },
  {
    id: parseNodeId('bodega')!,
    name: 'Neighborhood Bodega',
    geography: { verification: 'unverified' },
  },
  {
    id: parseNodeId('transit')!,
    name: 'Transit Zone',
    geography: { verification: 'unverified' },
  },
  {
    id: parseNodeId('park')!,
    name: 'Park',
    geography: { verification: 'unverified' },
  },
];

export type ActivityCategory =
  | 'walking'
  | 'presence'
  | 'participation';

export type WalkingDistanceSource =
  | 'simulated'
  | 'manual'
  | 'measured';

export type GpsPresenceFix = {
  sessionId: ActivitySessionId;
  nodeId: NodeId;
  observedAt: number;
  location: GeographicLocation;
  accuracyMeters: number;
};

export type PresenceVerification =
  | { status: 'observed' }
  | {
      status: 'verified';
      method: 'gps';
      verifiedAt: number;
      evidence: readonly GpsPresenceFix[];
    };

export type ActivityLifecycle =
  | { status: 'in_progress'; completedAt?: never }
  | { status: 'completed'; completedAt: number }
  | { status: 'cancelled'; completedAt?: never };

type ActivitySessionBase = {
  id: ActivitySessionId;
  userId: UserId;
  startedAt: number;
};

export type WalkingSession = ActivitySessionBase &
  ActivityLifecycle & {
    activityType: 'walking';
    nodeId?: NodeId;
    evidence: {
      distanceMeters: number;
      distanceSource: WalkingDistanceSource;
    };
  };

export type PresenceSession = ActivitySessionBase &
  ActivityLifecycle & {
    activityType: 'presence';
    nodeId: NodeId;
    evidence: {
      verification: PresenceVerification;
    };
  };

export type ParticipationSession = ActivitySessionBase &
  ActivityLifecycle & {
    activityType: 'participation';
    nodeId: NodeId;
    evidence: {
      activityName: string;
      source: 'self_reported' | 'organized';
    };
  };

export type ActivitySession =
  | WalkingSession
  | PresenceSession
  | ParticipationSession;

export type EconomyVersion =
  | { scope: 'live'; version: string }
  | {
      scope: 'simulation';
      version: string;
      candidateId?: string;
    };

export type XPEntry = {
  id: XPEntryId;
  userId: UserId;
  source: {
    activitySessionId: ActivitySessionId;
  };
  category: ActivityCategory;
  amount: number;
  economyVersion: EconomyVersion;
  awardedAt: number;
  idempotencyKey: string;
};

export type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidLocation(value: unknown): value is GeographicLocation {
  if (!isRecord(value)) return false;
  return (
    typeof value.latitude === 'number' &&
    Number.isFinite(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    typeof value.longitude === 'number' &&
    Number.isFinite(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180
  );
}

function isValidBoundary(value: unknown): value is readonly GeographicLocation[] {
  if (!Array.isArray(value) || value.length < 3 || !value.every(isValidLocation)) {
    return false;
  }

  const distinctPoints = new Set(
    value.map((point) => `${point.latitude},${point.longitude}`),
  );
  if (distinctPoints.size < 3) return false;

  const origin = value[0];
  const second = value[1];
  const hasArea = value.slice(2).some(
    (point) =>
      (second.longitude - origin.longitude) *
        (point.latitude - origin.latitude) -
        (second.latitude - origin.latitude) *
          (point.longitude - origin.longitude) !==
      0,
  );
  if (!hasArea) return false;

  for (let index = 0; index < value.length; index += 1) {
    const point = value[index];
    const next = value[(index + 1) % value.length];
    if (
      (point.latitude === next.latitude &&
        point.longitude === next.longitude) ||
      Math.abs(point.longitude - next.longitude) > 180
    ) {
      return false;
    }

    for (let otherIndex = index + 1; otherIndex < value.length; otherIndex += 1) {
      if (
        otherIndex === index + 1 ||
        (index === 0 && otherIndex === value.length - 1)
      ) {
        continue;
      }
      if (
        segmentsIntersect(
          point,
          next,
          value[otherIndex],
          value[(otherIndex + 1) % value.length],
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

function orientation(
  first: GeographicLocation,
  second: GeographicLocation,
  third: GeographicLocation,
): number {
  return (
    (second.longitude - first.longitude) *
      (third.latitude - first.latitude) -
    (second.latitude - first.latitude) *
      (third.longitude - first.longitude)
  );
}

function isPointOnSegment(
  point: GeographicLocation,
  start: GeographicLocation,
  end: GeographicLocation,
): boolean {
  return (
    orientation(start, end, point) === 0 &&
    point.longitude >= Math.min(start.longitude, end.longitude) &&
    point.longitude <= Math.max(start.longitude, end.longitude) &&
    point.latitude >= Math.min(start.latitude, end.latitude) &&
    point.latitude <= Math.max(start.latitude, end.latitude)
  );
}

function segmentsIntersect(
  firstStart: GeographicLocation,
  firstEnd: GeographicLocation,
  secondStart: GeographicLocation,
  secondEnd: GeographicLocation,
): boolean {
  const firstOrientation = orientation(
    firstStart,
    firstEnd,
    secondStart,
  );
  const secondOrientation = orientation(firstStart, firstEnd, secondEnd);
  const thirdOrientation = orientation(
    secondStart,
    secondEnd,
    firstStart,
  );
  const fourthOrientation = orientation(secondStart, secondEnd, firstEnd);

  if (
    firstOrientation * secondOrientation < 0 &&
    thirdOrientation * fourthOrientation < 0
  ) {
    return true;
  }

  return (
    (firstOrientation === 0 &&
      isPointOnSegment(secondStart, firstStart, firstEnd)) ||
    (secondOrientation === 0 &&
      isPointOnSegment(secondEnd, firstStart, firstEnd)) ||
    (thirdOrientation === 0 &&
      isPointOnSegment(firstStart, secondStart, secondEnd)) ||
    (fourthOrientation === 0 &&
      isPointOnSegment(firstEnd, secondStart, secondEnd))
  );
}

function isInsideBoundary(
  point: GeographicLocation,
  boundary: readonly GeographicLocation[],
): boolean {
  let inside = false;
  for (
    let index = 0, previous = boundary.length - 1;
    index < boundary.length;
    previous = index++
  ) {
    const start = boundary[previous];
    const end = boundary[index];
    if (isPointOnSegment(point, start, end)) return true;

    const crossesLatitude =
      (start.latitude > point.latitude) !== (end.latitude > point.latitude);
    if (
      crossesLatitude &&
      point.longitude <
        ((end.longitude - start.longitude) *
          (point.latitude - start.latitude)) /
          (end.latitude - start.latitude) +
          start.longitude
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function validateUserRecord(value: unknown): ValidationResult<UserRecord> {
  if (!isRecord(value)) {
    return { valid: false, errors: ['User record must be an object.'] };
  }

  const errors: string[] = [];
  if (!isNonEmptyString(value.id)) errors.push('User id is required.');
  if (!isFiniteNonNegative(value.createdAt)) {
    errors.push('User createdAt must be a non-negative millisecond timestamp.');
  }
  if (!isFiniteNonNegative(value.updatedAt)) {
    errors.push('User updatedAt must be a non-negative millisecond timestamp.');
  }
  if (
    isFiniteNonNegative(value.createdAt) &&
    isFiniteNonNegative(value.updatedAt) &&
    value.updatedAt < value.createdAt
  ) {
    errors.push('User updatedAt cannot precede createdAt.');
  }

  return errors.length > 0
    ? { valid: false, errors }
    : {
        valid: true,
        value: value as unknown as UserRecord,
      };
}

export function validateNodeRecord(value: unknown): ValidationResult<NodeRecord> {
  if (!isRecord(value)) {
    return { valid: false, errors: ['Node record must be an object.'] };
  }

  const errors: string[] = [];
  if (!isNonEmptyString(value.id)) errors.push('Node id is required.');
  if (!isNonEmptyString(value.name)) errors.push('Node name is required.');

  const geography = value.geography;
  if (!isRecord(geography)) {
    errors.push('Node geography verification state is required.');
  } else if (geography.verification === 'verified') {
    if (!isValidLocation(geography.location)) {
      errors.push('Verified node geography requires a valid location.');
    }
    if (!isValidBoundary(geography.boundary)) {
      errors.push('Verified node geography requires a valid geographic boundary.');
    } else if (
      isValidLocation(geography.location) &&
      !isInsideBoundary(geography.location, geography.boundary)
    ) {
      errors.push('Verified node location must be within its geographic boundary.');
    }
  } else if (geography.verification !== 'unverified') {
    errors.push('Node geography verification state is invalid.');
  }

  return errors.length > 0
    ? { valid: false, errors }
    : { valid: true, value: value as unknown as NodeRecord };
}

function validatePresenceVerification(
  value: unknown,
  session: {
    id: unknown;
    nodeId: unknown;
    startedAt: unknown;
    completedAt: unknown;
  },
): string[] {
  if (!isRecord(value)) return ['Presence verification evidence is required.'];
  if (value.status === 'observed') return [];
  if (value.status !== 'verified' || value.method !== 'gps') {
    return ['Presence verification state is invalid.'];
  }

  const errors: string[] = [];
  if (!isFiniteNonNegative(value.verifiedAt)) {
    errors.push('GPS verification timestamp is invalid.');
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    errors.push('GPS verification requires at least one evidence fix.');
  } else {
    value.evidence.forEach((fix, index) => {
      if (
        !isRecord(fix) ||
        !isNonEmptyString(fix.sessionId) ||
        fix.sessionId !== session.id ||
        !isNonEmptyString(fix.nodeId) ||
        fix.nodeId !== session.nodeId ||
        !isFiniteNonNegative(fix.observedAt) ||
        !isValidLocation(fix.location) ||
        !isFiniteNonNegative(fix.accuracyMeters)
      ) {
        errors.push(
          `GPS evidence fix ${index} is invalid or is not bound to this session and node.`,
        );
      } else if (
        !isFiniteNonNegative(session.startedAt) ||
        !isFiniteNonNegative(session.completedAt) ||
        session.completedAt < session.startedAt ||
        fix.observedAt < session.startedAt ||
        fix.observedAt > session.completedAt
      ) {
        errors.push(
          `GPS evidence fix ${index} falls outside the completed session interval.`,
        );
      }
    });
  }
  return errors;
}

export function validateActivitySession(
  value: unknown,
  nodes: readonly NodeRecord[],
): ValidationResult<ActivitySession> {
  if (!isRecord(value)) {
    return { valid: false, errors: ['Activity session must be an object.'] };
  }

  const errors: string[] = [];
  if (!isNonEmptyString(value.id)) errors.push('Session id is required.');
  if (!isNonEmptyString(value.userId)) errors.push('Session userId is required.');
  if (!isFiniteNonNegative(value.startedAt)) {
    errors.push('Session startedAt must be a non-negative millisecond timestamp.');
  }
  if (
    value.status !== 'in_progress' &&
    value.status !== 'completed' &&
    value.status !== 'cancelled'
  ) {
    errors.push('Session status is invalid.');
  }
  if (value.status === 'completed') {
    if (!isFiniteNonNegative(value.completedAt)) {
      errors.push('Completed session requires a valid completedAt timestamp.');
    } else if (
      isFiniteNonNegative(value.startedAt) &&
      value.completedAt < value.startedAt
    ) {
      errors.push('Session completedAt cannot precede startedAt.');
    }
  } else if (value.completedAt !== undefined) {
    errors.push('Only completed sessions may have completedAt.');
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  if (value.activityType === 'walking') {
    if (
      value.nodeId !== undefined &&
      (!isNonEmptyString(value.nodeId) || !nodeIds.has(value.nodeId as NodeId))
    ) {
      errors.push('Walking session references an unknown node.');
    }
    if (!isRecord(value.evidence)) {
      errors.push('Walking session evidence is required.');
    } else {
      if (!isFiniteNonNegative(value.evidence.distanceMeters)) {
        errors.push('Walking distance must be a non-negative meter value.');
      }
      if (
        value.evidence.distanceSource !== 'simulated' &&
        value.evidence.distanceSource !== 'manual' &&
        value.evidence.distanceSource !== 'measured'
      ) {
        errors.push('Walking distance source is invalid.');
      }
    }
  } else if (value.activityType === 'presence') {
    if (!isNonEmptyString(value.nodeId) || !nodeIds.has(value.nodeId as NodeId)) {
      errors.push('Presence session requires a known node.');
    }
    if (!isRecord(value.evidence)) {
      errors.push('Presence session evidence is required.');
    } else {
      errors.push(
        ...validatePresenceVerification(value.evidence.verification, {
          id: value.id,
          nodeId: value.nodeId,
          startedAt: value.startedAt,
          completedAt: value.completedAt,
        }),
      );
    }
  } else if (value.activityType === 'participation') {
    if (!isNonEmptyString(value.nodeId) || !nodeIds.has(value.nodeId as NodeId)) {
      errors.push('Participation session requires a known node.');
    }
    if (
      !isRecord(value.evidence) ||
      !isNonEmptyString(value.evidence.activityName) ||
      (value.evidence.source !== 'self_reported' &&
        value.evidence.source !== 'organized')
    ) {
      errors.push('Participation activity evidence is invalid.');
    }
  } else {
    errors.push('Activity category is invalid.');
  }

  return errors.length > 0
    ? { valid: false, errors }
    : { valid: true, value: value as unknown as ActivitySession };
}

export type GpsPresenceEligibility =
  | { status: 'eligible' }
  | { status: 'ineligible'; reason: string }
  | { status: 'indeterminate'; reason: string };

export function canQualifyForGpsVerifiedPresence(
  session: ActivitySession,
  node: NodeRecord,
): GpsPresenceEligibility {
  if (session.activityType !== 'presence' || session.status !== 'completed') {
    return {
      status: 'ineligible',
      reason: 'GPS-verified presence requires a completed presence session.',
    };
  }

  const sessionValidation = validateActivitySession(session, [node]);
  if (!sessionValidation.valid) {
    return {
      status: 'ineligible',
      reason: sessionValidation.errors.join(' '),
    };
  }

  const nodeValidation = validateNodeRecord(node);
  if (!nodeValidation.valid) {
    return {
      status: 'indeterminate',
      reason: nodeValidation.errors.join(' '),
    };
  }

  if (node.geography.verification !== 'verified') {
    return {
      status: 'indeterminate',
      reason: 'Node geography has not been verified.',
    };
  }

  const verification = session.evidence.verification;
  if (verification.status !== 'verified' || verification.method !== 'gps') {
    return {
      status: 'ineligible',
      reason: 'Presence has not been verified by GPS.',
    };
  }

  const boundary = node.geography.boundary;
  if (
    verification.evidence.some(
      (fix) => !isInsideBoundary(fix.location, boundary),
    )
  ) {
    return {
      status: 'ineligible',
      reason: 'GPS evidence falls outside the verified node boundary.',
    };
  }

  return { status: 'eligible' };
}

export type CompleteSessionResult =
  | { completed: true; session: ActivitySession }
  | { completed: false; errors: string[] };

export function completeActivitySession(
  session: ActivitySession,
  completedAt: number,
  nodes: readonly NodeRecord[],
): CompleteSessionResult {
  if (session.status !== 'in_progress') {
    return {
      completed: false,
      errors: ['Only an in-progress session can be completed.'],
    };
  }
  if (!isFiniteNonNegative(completedAt)) {
    return {
      completed: false,
      errors: ['completedAt must be a non-negative millisecond timestamp.'],
    };
  }
  if (completedAt < session.startedAt) {
    return {
      completed: false,
      errors: ['Session completedAt cannot precede startedAt.'],
    };
  }

  const result = validateActivitySession(
    { ...session, status: 'completed', completedAt },
    nodes,
  );
  return result.valid
    ? { completed: true, session: result.value }
    : { completed: false, errors: result.errors };
}

export function sessionDurationMs(session: ActivitySession): number | null {
  if (
    session.status !== 'completed' ||
    !Number.isFinite(session.startedAt) ||
    !Number.isFinite(session.completedAt) ||
    session.completedAt < session.startedAt
  ) {
    return null;
  }
  return session.completedAt - session.startedAt;
}

export function validateXPEntry(
  value: unknown,
  sessions: readonly ActivitySession[],
  nodes: readonly NodeRecord[],
): ValidationResult<XPEntry> {
  if (!isRecord(value)) {
    return { valid: false, errors: ['XP entry must be an object.'] };
  }

  const errors: string[] = [];
  if (!isNonEmptyString(value.id)) errors.push('XP entry id is required.');
  if (!isNonEmptyString(value.userId)) errors.push('XP entry userId is required.');
  if (!isRecord(value.source) || !isNonEmptyString(value.source.activitySessionId)) {
    errors.push('XP entry must reference a source activity session.');
  }
  if (
    value.category !== 'walking' &&
    value.category !== 'presence' &&
    value.category !== 'participation'
  ) {
    errors.push('XP category is invalid.');
  }
  if (!isFiniteNonNegative(value.amount)) {
    errors.push('XP amount must be a non-negative finite number.');
  }
  if (!isFiniteNonNegative(value.awardedAt)) {
    errors.push('XP awardedAt must be a non-negative millisecond timestamp.');
  }
  if (!isNonEmptyString(value.idempotencyKey)) {
    errors.push('XP idempotencyKey is required.');
  }
  if (
    !isRecord(value.economyVersion) ||
    (value.economyVersion.scope !== 'live' &&
      value.economyVersion.scope !== 'simulation') ||
    !isNonEmptyString(value.economyVersion.version) ||
    (value.economyVersion.scope === 'simulation' &&
      value.economyVersion.candidateId !== undefined &&
      !isNonEmptyString(value.economyVersion.candidateId))
  ) {
    errors.push('XP economyVersion must identify its live or simulation rules.');
  }

  const sourceId =
    isRecord(value.source) && isNonEmptyString(value.source.activitySessionId)
      ? value.source.activitySessionId
      : null;
  const sourceSession = sourceId
    ? sessions.find((session) => session.id === sourceId)
    : undefined;
  if (!sourceSession) {
    errors.push('XP entry source session does not exist.');
  } else {
    const validatedSession = validateActivitySession(sourceSession, nodes);
    if (!validatedSession.valid) {
      errors.push('XP entry source session is invalid.');
    } else {
      const session = validatedSession.value;
      if (session.status !== 'completed') {
        errors.push('XP entry source session must be completed.');
      }
      if (session.userId !== value.userId) {
        errors.push('XP entry userId must match its source session.');
      }
      if (session.activityType !== value.category) {
        errors.push('XP category must match its source activity.');
      }
      if (
        session.activityType === 'walking' &&
        session.evidence.distanceSource === 'simulated' &&
        isRecord(value.economyVersion) &&
        value.economyVersion.scope === 'live'
      ) {
        errors.push('Simulated walking cannot qualify for live XP.');
      }
      if (
        session.activityType === 'presence' &&
        session.status === 'completed'
      ) {
        const node = nodes.find((candidate) => candidate.id === session.nodeId);
        const eligibility = node
          ? canQualifyForGpsVerifiedPresence(session, node)
          : {
              status: 'indeterminate' as const,
              reason: 'Presence node is unavailable.',
            };
        if (eligibility.status !== 'eligible') {
          errors.push(
            `Presence XP is ${eligibility.status}: ${eligibility.reason}`,
          );
        }
      }
    }
  }

  return errors.length > 0
    ? { valid: false, errors }
    : { valid: true, value: value as unknown as XPEntry };
}

function sameEconomyVersion(
  first: EconomyVersion,
  second: EconomyVersion,
): boolean {
  return (
    first.scope === second.scope &&
    first.version === second.version &&
    (first.scope !== 'simulation' ||
      second.scope !== 'simulation' ||
      first.candidateId === second.candidateId)
  );
}

function sameAwardPayload(first: XPEntry, second: XPEntry): boolean {
  return (
    first.userId === second.userId &&
    first.source.activitySessionId === second.source.activitySessionId &&
    first.category === second.category &&
    first.amount === second.amount &&
    sameEconomyVersion(first.economyVersion, second.economyVersion)
  );
}

export type RecordXPResult =
  | { status: 'added'; entries: readonly XPEntry[]; entry: XPEntry }
  | { status: 'duplicate'; entries: readonly XPEntry[]; entry: XPEntry }
  | { status: 'conflict'; entries: readonly XPEntry[]; errors: string[] };

export function recordXPEntry(
  entries: readonly XPEntry[],
  candidate: XPEntry,
): RecordXPResult {
  const sameKey = entries.find(
    (entry) => entry.idempotencyKey === candidate.idempotencyKey,
  );
  if (sameKey) {
    return sameAwardPayload(sameKey, candidate)
      ? { status: 'duplicate', entries, entry: sameKey }
      : {
          status: 'conflict',
          entries,
          errors: [
            'Idempotency key already belongs to a different XP award.',
          ],
        };
  }

  const sameId = entries.find((entry) => entry.id === candidate.id);
  if (sameId) {
    return {
      status: 'conflict',
      entries,
      errors: ['XP entry id already belongs to a different idempotency key.'],
    };
  }

  const nextEntries = [...entries, candidate];
  return { status: 'added', entries: nextEntries, entry: candidate };
}

export type XPProjections = {
  totalXp: number;
  byCategory: Record<ActivityCategory, number>;
  byNode: Record<string, number>;
};

export function deriveXPProjections(
  userId: UserId,
  entries: readonly XPEntry[],
  sessions: readonly ActivitySession[],
  nodes: readonly NodeRecord[],
): ValidationResult<XPProjections> {
  let totalXp = 0;
  const byCategory: Record<ActivityCategory, number> = {
    walking: 0,
    presence: 0,
    participation: 0,
  };
  const byNode = new Map<string, number>();
  const accepted: XPEntry[] = [];

  for (const entry of entries) {
    if (entry.userId !== userId) continue;
    const validation = validateXPEntry(entry, sessions, nodes);
    if (!validation.valid) {
      return {
        valid: false,
        errors: [`XP entry ${entry.id}: ${validation.errors.join(' ')}`],
      };
    }

    const recorded = recordXPEntry(accepted, validation.value);
    if (recorded.status === 'conflict') {
      return { valid: false, errors: recorded.errors };
    }
    if (recorded.status === 'duplicate') continue;

    accepted.push(validation.value);
    totalXp += validation.value.amount;
    byCategory[validation.value.category] += validation.value.amount;

    const sourceSession = sessions.find(
      (session) =>
        session.id === validation.value.source.activitySessionId,
    );
    if (sourceSession?.nodeId !== undefined) {
      byNode.set(
        sourceSession.nodeId,
        (byNode.get(sourceSession.nodeId) ?? 0) + validation.value.amount,
      );
    }
  }

  return {
    valid: true,
    value: {
      totalXp,
      byCategory,
      byNode: Object.fromEntries(
        [...byNode.entries()].sort(([first], [second]) =>
          first < second ? -1 : first > second ? 1 : 0,
        ),
      ),
    },
  };
}

function compareStrings(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

export function deriveActivityHistory(
  sessions: readonly ActivitySession[],
  userId?: UserId,
): ActivitySession[] {
  return sessions
    .filter((session) => userId === undefined || session.userId === userId)
    .slice()
    .sort(
      (first, second) =>
        first.startedAt - second.startedAt ||
        (first.completedAt ?? Number.POSITIVE_INFINITY) -
          (second.completedAt ?? Number.POSITIVE_INFINITY) ||
        compareStrings(first.id, second.id),
    );
}

export function deriveMovementHistory(
  sessions: readonly ActivitySession[],
  userId?: UserId,
): WalkingSession[] {
  return deriveActivityHistory(sessions, userId).filter(
    (session): session is WalkingSession =>
      session.activityType === 'walking',
  );
}

export function derivePresenceHistory(
  sessions: readonly ActivitySession[],
  userId?: UserId,
): PresenceSession[] {
  return deriveActivityHistory(sessions, userId).filter(
    (session): session is PresenceSession =>
      session.activityType === 'presence',
  );
}

export function deriveNodeHistory(
  sessions: readonly ActivitySession[],
  nodeId: NodeId,
  userId?: UserId,
): ActivitySession[] {
  return deriveActivityHistory(sessions, userId).filter(
    (session) => session.nodeId === nodeId,
  );
}

export function deriveCompletedSessionProjection(
  sessions: readonly ActivitySession[],
  entries: readonly XPEntry[],
  nodes: readonly NodeRecord[],
  userId?: UserId,
): ValidationResult<CompletedSession[]> {
  const completedAwards = new Map<ActivitySessionId, number>();
  const acceptedEntries: XPEntry[] = [];
  for (const entry of entries) {
    if (userId !== undefined && entry.userId !== userId) continue;
    const validation = validateXPEntry(entry, sessions, nodes);
    if (!validation.valid) {
      return {
        valid: false,
        errors: [`XP entry ${entry.id}: ${validation.errors.join(' ')}`],
      };
    }
    const recorded = recordXPEntry(acceptedEntries, validation.value);
    if (recorded.status === 'conflict') {
      return { valid: false, errors: recorded.errors };
    }
    if (recorded.status === 'duplicate') continue;
    acceptedEntries.push(validation.value);
    if (entry.category === 'participation') {
      completedAwards.set(
        entry.source.activitySessionId,
        (completedAwards.get(entry.source.activitySessionId) ?? 0) +
          entry.amount,
      );
    }
  }

  const projection: CompletedSession[] = [];
  for (const session of deriveActivityHistory(sessions, userId)) {
    const validation = validateActivitySession(session, nodes);
    if (!validation.valid) {
      return {
        valid: false,
        errors: [`Activity session ${session.id}: ${validation.errors.join(' ')}`],
      };
    }
    if (session.activityType !== 'participation' || session.status !== 'completed') {
      continue;
    }
    const node = nodes.find((candidate) => candidate.id === session.nodeId);
    if (!node) {
      return {
        valid: false,
        errors: [`Participation session ${session.id} references an unknown node.`],
      };
    }
    projection.push({
      nodeId: node.id,
      nodeName: node.name,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      xpAwarded: completedAwards.get(session.id) ?? 0,
    });
  }
  return { valid: true, value: projection };
}

export function deriveCanonicalBehavioralSignals(
  sessions: readonly ActivitySession[],
  entries: readonly XPEntry[],
  nodes: readonly NodeRecord[],
  userId?: UserId,
): ValidationResult<BehavioralSignals> {
  const projection = deriveCompletedSessionProjection(
    sessions,
    entries,
    nodes,
    userId,
  );
  return projection.valid
    ? {
        valid: true,
        value: deriveBehavioralSignals(projection.value),
      }
    : projection;
}

export type LegacyMemoryInspection =
  | { status: 'invalid'; errors: string[] }
  | {
      status: 'unresolved';
      legacyCompletedSessions: readonly CompletedSession[];
      xpTodayAggregate: number;
      unresolved: readonly [
        'missing-user-and-session-identities',
        'activity-and-evidence-not-encoded',
        'xp-aggregate-source-and-economy-unknown',
      ];
    };

export function inspectLegacyMemory(value: unknown): LegacyMemoryInspection {
  if (!isRecord(value)) {
    return { status: 'invalid', errors: ['Legacy memory must be an object.'] };
  }
  if (
    typeof value.xpToday !== 'number' ||
    !Number.isFinite(value.xpToday)
  ) {
    return { status: 'invalid', errors: ['Legacy xpToday is invalid.'] };
  }
  if (!Array.isArray(value.completedSessions)) {
    return {
      status: 'invalid',
      errors: ['Legacy completedSessions must be an array.'],
    };
  }

  const sessionsValid = value.completedSessions.every((session) => {
    if (!isRecord(session)) return false;
    return (
      typeof session.nodeId === 'string' &&
      typeof session.nodeName === 'string' &&
      typeof session.startedAt === 'number' &&
      Number.isFinite(session.startedAt) &&
      typeof session.completedAt === 'number' &&
      Number.isFinite(session.completedAt) &&
      typeof session.xpAwarded === 'number' &&
      Number.isFinite(session.xpAwarded)
    );
  });
  if (!sessionsValid) {
    return {
      status: 'invalid',
      errors: ['Legacy completed session shape is invalid.'],
    };
  }

  return {
    status: 'unresolved',
    legacyCompletedSessions:
      value.completedSessions as unknown as readonly CompletedSession[],
    xpTodayAggregate: value.xpToday,
    unresolved: [
      'missing-user-and-session-identities',
      'activity-and-evidence-not-encoded',
      'xp-aggregate-source-and-economy-unknown',
    ],
  };
}
