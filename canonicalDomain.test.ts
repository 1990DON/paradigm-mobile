import {
  ActivitySession,
  ActivitySessionId,
  EconomyVersion,
  EXISTING_NODE_IDS,
  EXISTING_NODE_RECORDS,
  NodeId,
  NodeRecord,
  ParticipationSession,
  PresenceSession,
  XPEntry,
  XPEntryId,
  WalkingSession,
  canQualifyForGpsVerifiedPresence,
  completeActivitySession,
  deriveActivityHistory,
  deriveCanonicalBehavioralSignals,
  deriveCompletedSessionProjection,
  deriveMovementHistory,
  deriveNodeHistory,
  derivePresenceHistory,
  deriveXPProjections,
  inspectLegacyMemory,
  parseActivitySessionId,
  parseNodeId,
  parseUserId,
  parseXPEntryId,
  recordXPEntry,
  validateActivitySession,
  validateXPEntry,
} from './canonicalDomain';
import { calculateWalkingXp } from './stage6Simulation';
import {
  runStage6CandidateEconomy,
  STAGE6_CANDIDATE_ECONOMY_VERSION,
} from './stage6CandidateEconomy';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} Expected ${String(expected)}, got ${String(actual)}.`);
  }
}

function id<T>(value: T | null, label: string): T {
  assert(value !== null, `${label} should be valid.`);
  return value;
}

function makeCompletedWalking(
  sessionId: string,
  startedAt: number,
  nodeId?: NodeId,
  distanceSource: 'simulated' | 'manual' | 'measured' = 'measured',
): WalkingSession {
  return {
    id: id(parseActivitySessionId(sessionId), 'Session id'),
    userId: TEST_USER_ID,
    activityType: 'walking',
    ...(nodeId === undefined ? {} : { nodeId }),
    startedAt,
    completedAt: startedAt + 1000,
    status: 'completed',
    evidence: { distanceMeters: 250, distanceSource },
  };
}

const TEST_USER_ID = id(parseUserId('user-test'), 'User id');
const COURT_ID = id(parseNodeId('court'), 'Court node id');
const PARK_ID = id(parseNodeId('park'), 'Park node id');
const PARTICIPATION_ID = id(
  parseActivitySessionId('session-participation'),
  'Participation session id',
);
const PRESENCE_ID = id(
  parseActivitySessionId('session-presence'),
  'Presence session id',
);
const VERIFIED_PARK: NodeRecord = {
  id: PARK_ID,
  name: 'Park',
  geography: {
    verification: 'verified',
    location: { latitude: 0, longitude: 0 },
    boundary: [
      { latitude: -0.01, longitude: -0.01 },
      { latitude: -0.01, longitude: 0.01 },
      { latitude: 0.01, longitude: 0.01 },
      { latitude: 0.01, longitude: -0.01 },
    ],
  },
};
const TEST_NODES = EXISTING_NODE_RECORDS.map((node) =>
  node.id === PARK_ID ? VERIFIED_PARK : node,
);

const VERIFIED_PRESENCE_EVIDENCE: Extract<
  PresenceSession['evidence']['verification'],
  { status: 'verified' }
> = {
  status: 'verified',
  method: 'gps',
  verifiedAt: 5000,
  evidence: [
    {
      sessionId: PRESENCE_ID,
      nodeId: PARK_ID,
      observedAt: 4000,
      location: { latitude: 0, longitude: 0 },
      accuracyMeters: 10,
    },
  ],
};

const participation: ParticipationSession = {
  id: PARTICIPATION_ID,
  userId: TEST_USER_ID,
  activityType: 'participation',
  nodeId: COURT_ID,
  startedAt: 1000,
  completedAt: 2000,
  status: 'completed',
  evidence: { activityName: 'Basketball', source: 'organized' },
};
const presence: PresenceSession = {
  id: PRESENCE_ID,
  userId: TEST_USER_ID,
  activityType: 'presence',
  nodeId: PARK_ID,
  startedAt: 3000,
  completedAt: 5000,
  status: 'completed',
  evidence: { verification: VERIFIED_PRESENCE_EVIDENCE },
};
const walking = makeCompletedWalking(
  'session-walking',
  6000,
  undefined,
  'simulated',
);
const IN_PROGRESS_WALKING: WalkingSession = {
  id: id(parseActivitySessionId('session-in-progress'), 'Session id'),
  userId: TEST_USER_ID,
  activityType: 'walking',
  startedAt: 7000,
  status: 'in_progress',
  evidence: { distanceMeters: 100, distanceSource: 'measured' },
};

function makeEntry(
  entryId: XPEntryId,
  key: string,
  activitySessionId: ActivitySessionId,
  category: XPEntry['category'],
  amount: number,
  awardedAt: number,
  economyVersion: EconomyVersion = {
    scope: 'live',
    version: 'live-test-rules-v1',
  },
): XPEntry {
  return {
    id: entryId,
    userId: TEST_USER_ID,
    source: { activitySessionId },
    category,
    amount,
    economyVersion,
    awardedAt,
    idempotencyKey: key,
  };
}

export function runCanonicalDomainTests(): void {
  equal(
    EXISTING_NODE_IDS.join(','),
    'court,bodega,transit,park',
    'Existing node IDs must remain stable.',
  );
  equal(
    EXISTING_NODE_RECORDS.map((node) => node.id).join(','),
    EXISTING_NODE_IDS.join(','),
    'Every existing node ID must have a canonical record.',
  );

  const observedPresence: PresenceSession = {
    ...presence,
    evidence: { verification: { status: 'observed' } },
  };
  assert(
    validateActivitySession(observedPresence, EXISTING_NODE_RECORDS).valid,
    'Observed presence remains valid without verified geography.',
  );
  const unverifiedPark = EXISTING_NODE_RECORDS.find(
    (node) => node.id === PARK_ID,
  );
  assert(unverifiedPark, 'Existing park node should be present.');
  assert(
    canQualifyForGpsVerifiedPresence(presence, unverifiedPark).status ===
      'indeterminate',
    'Unverified geography must not qualify for GPS-verified presence.',
  );
  assert(
    canQualifyForGpsVerifiedPresence(presence, VERIFIED_PARK).status ===
      'eligible',
    'Verified presence at a verified node can qualify for presence XP.',
  );
  assert(
    validateActivitySession(presence, TEST_NODES).valid,
    'Verified presence at a verified node should validate.',
  );
  assert(
    canQualifyForGpsVerifiedPresence(observedPresence, VERIFIED_PARK).status ===
      'ineligible',
    'Observed presence must remain distinct from geographically verified presence.',
  );

  const unrelatedFix: PresenceSession = {
    ...presence,
    evidence: {
      verification: {
        ...VERIFIED_PRESENCE_EVIDENCE,
        evidence: [
          {
            ...VERIFIED_PRESENCE_EVIDENCE.evidence[0],
            sessionId: id(
              parseActivitySessionId('session-unrelated'),
              'Unrelated session id',
            ),
          },
        ],
      },
    },
  };
  assert(
    !validateActivitySession(unrelatedFix, TEST_NODES).valid,
    'A GPS fix from an unrelated session must be rejected.',
  );

  const incorrectNodeFix: PresenceSession = {
    ...presence,
    evidence: {
      verification: {
        ...VERIFIED_PRESENCE_EVIDENCE,
        evidence: [
          {
            ...VERIFIED_PRESENCE_EVIDENCE.evidence[0],
            nodeId: COURT_ID,
          },
        ],
      },
    },
  };
  assert(
    !validateActivitySession(incorrectNodeFix, TEST_NODES).valid,
    'A GPS fix bound to a different node must be rejected.',
  );

  const outOfIntervalFix: PresenceSession = {
    ...presence,
    evidence: {
      verification: {
        ...VERIFIED_PRESENCE_EVIDENCE,
        evidence: [
          {
            ...VERIFIED_PRESENCE_EVIDENCE.evidence[0],
            observedAt: 5001,
          },
        ],
      },
    },
  };
  assert(
    !validateActivitySession(outOfIntervalFix, TEST_NODES).valid,
    'A GPS fix outside the completed session interval must be rejected.',
  );

  const outsideBoundary: PresenceSession = {
    ...presence,
    evidence: {
      verification: {
        ...VERIFIED_PRESENCE_EVIDENCE,
        evidence: [
          {
            ...VERIFIED_PRESENCE_EVIDENCE.evidence[0],
            location: { latitude: 1, longitude: 1 },
          },
        ],
      },
    },
  };
  assert(
    canQualifyForGpsVerifiedPresence(outsideBoundary, VERIFIED_PARK).status ===
      'ineligible',
    'A GPS fix outside the verified geographic boundary must be rejected.',
  );

  const noGpsEvidence: PresenceSession = {
    ...presence,
    evidence: {
      verification: {
        ...VERIFIED_PRESENCE_EVIDENCE,
        evidence: [],
      },
    },
  };
  assert(
    !validateActivitySession(noGpsEvidence, TEST_NODES).valid &&
      canQualifyForGpsVerifiedPresence(noGpsEvidence, VERIFIED_PARK).status ===
        'ineligible',
    'Missing GPS evidence must be explicitly ineligible.',
  );

  const walkingWithoutNode = makeCompletedWalking('walking-no-node', 0);
  assert(
    validateActivitySession(walkingWithoutNode, EXISTING_NODE_RECORDS).valid,
    'Walking can be represented without a node.',
  );
  assert(
    !validateActivitySession(
      { ...presence, nodeId: undefined },
      TEST_NODES,
    ).valid,
    'Presence requires a valid node.',
  );
  assert(
    !validateActivitySession(
      { ...participation, nodeId: undefined },
      TEST_NODES,
    ).valid,
    'Participation requires a valid node.',
  );

  const completed = completeActivitySession(
    IN_PROGRESS_WALKING,
    8000,
    TEST_NODES,
  );
  assert(completed.completed, 'An in-progress session should complete.');
  equal(completed.session.status, 'completed', 'Completion changes lifecycle state.');
  assert(
    !completeActivitySession(completed.session, 9000, TEST_NODES).completed,
    'A completed session cannot transition to completed again.',
  );
  assert(
    !validateActivitySession(
      { ...walking, completedAt: walking.startedAt - 1 },
      TEST_NODES,
    ).valid,
    'completedAt cannot precede startedAt.',
  );

  const entries: XPEntry[] = [
    makeEntry(
      id(parseXPEntryId('xp-participation'), 'XP entry id'),
      'award-participation',
      PARTICIPATION_ID,
      'participation',
      45,
      2100,
    ),
    makeEntry(
      id(parseXPEntryId('xp-presence'), 'XP entry id'),
      'award-presence',
      PRESENCE_ID,
      'presence',
      7,
      5100,
    ),
    makeEntry(
      id(parseXPEntryId('xp-walking'), 'XP entry id'),
      'award-simulated-walking',
      walking.id,
      'walking',
      2,
      7100,
      {
        scope: 'simulation',
        version: STAGE6_CANDIDATE_ECONOMY_VERSION,
        candidateId: 'C',
      },
    ),
  ];
  const sessions = [walking, presence, participation];
  assert(
    !validateXPEntry(entries[1], sessions, EXISTING_NODE_RECORDS).valid,
    'Structurally valid GPS evidence cannot authorize XP at an unverified node.',
  );
  assert(
    validateXPEntry(entries[1], sessions, TEST_NODES).valid,
    'Presence XP is accepted only after the completed eligibility checks pass.',
  );
  assert(
    !validateXPEntry(
      {
        ...entries[2],
        economyVersion: { scope: 'live', version: 'live-test-rules-v1' },
      },
      sessions,
      TEST_NODES,
    ).valid,
    'Simulated walking cannot qualify for live XP.',
  );
  assert(
    validateXPEntry(entries[2], sessions, TEST_NODES).valid,
    'Simulated walking can be represented under a simulation economy.',
  );

  const replay = {
    ...entries[0],
    id: id(parseXPEntryId('xp-participation-replay'), 'XP entry id'),
    awardedAt: entries[0].awardedAt + 1000,
  };
  const duplicateResult = recordXPEntry([entries[0]], replay);
  equal(duplicateResult.status, 'duplicate', 'Award replay must be idempotent.');
  const conflictResult = recordXPEntry(
    [entries[0]],
    { ...replay, amount: entries[0].amount + 1 },
  );
  equal(conflictResult.status, 'conflict', 'Conflicting replay must be explicit.');

  const projections = deriveXPProjections(
    TEST_USER_ID,
    entries,
    sessions,
    TEST_NODES,
  );
  assert(projections.valid, 'Valid XP entries should derive projections.');
  equal(projections.value.totalXp, 54, 'Total XP is the sum of canonical entries.');
  equal(
    projections.value.byCategory.participation,
    45,
    'Participation XP is derived independently.',
  );
  equal(
    projections.value.byCategory.presence,
    7,
    'Presence XP is derived independently.',
  );
  equal(
    projections.value.byCategory.walking,
    2,
    'Walking XP is derived independently.',
  );
  equal(
    projections.value.byNode.court,
    45,
    'Node XP includes only the eligible award associated with that node.',
  );
  equal(
    projections.value.byNode.park,
    7,
    'Presence XP is associated with its verified node.',
  );
  assert(
    projections.value.byNode.undefined === undefined,
    'Unassociated walking XP must not create a node XP total.',
  );
  const completedSessionProjection = deriveCompletedSessionProjection(
    sessions,
    entries,
    TEST_NODES,
    TEST_USER_ID,
  );
  assert(
    completedSessionProjection.valid,
    'Canonical history can project into the existing CompletedSession shape.',
  );
  equal(
    completedSessionProjection.value.length,
    1,
    'Only completed participation sessions enter the legacy read projection.',
  );
  equal(
    completedSessionProjection.value[0].xpAwarded,
    45,
    'Participation projection derives XP from canonical entries.',
  );
  const behavioralSignals = deriveCanonicalBehavioralSignals(
    sessions,
    entries,
    TEST_NODES,
    TEST_USER_ID,
  );
  assert(behavioralSignals.valid, 'Behavioral signals derive from canonical history.');
  equal(
    behavioralSignals.value.totalCompletedXp,
    45,
    'Behavioral signals retain the existing participation XP projection.',
  );

  const tiedWalking = makeCompletedWalking('session-a', 1000);
  const tiedParticipation: ActivitySession = {
    ...participation,
    id: id(parseActivitySessionId('session-b'), 'Session id'),
    startedAt: 1000,
  };
  const unorderedHistory = [tiedParticipation, tiedWalking, presence];
  const firstOrder = deriveActivityHistory(unorderedHistory)
    .map((session) => session.id)
    .join(',');
  const secondOrder = deriveActivityHistory(unorderedHistory.slice().reverse())
    .map((session) => session.id)
    .join(',');
  equal(firstOrder, secondOrder, 'Historical ordering must be deterministic.');
  equal(
    deriveMovementHistory(unorderedHistory).length,
    1,
    'Movement history contains only walking.',
  );
  equal(
    derivePresenceHistory(unorderedHistory).length,
    1,
    'Presence history contains only presence.',
  );
  equal(
    deriveNodeHistory(unorderedHistory, COURT_ID).length,
    1,
    'Node history contains sessions associated with that node.',
  );

  const legacy = inspectLegacyMemory({
    xpToday: 45,
    completedSessions: [
      {
        nodeId: 'court',
        nodeName: 'Basketball Court',
        startedAt: 1000,
        completedAt: 2000,
        xpAwarded: 45,
      },
    ],
  });
  assert(legacy.status === 'unresolved', 'Legacy aggregate must remain unresolved.');
  equal(legacy.xpTodayAggregate, 45, 'Legacy xpToday is preserved as an aggregate.');
  assert(
    legacy.unresolved.includes('xp-aggregate-source-and-economy-unknown'),
    'Legacy XP must not be assigned a source or economy silently.',
  );
  equal(calculateWalkingXp(2), 10, 'Stage 6 walking XP remains five XP per km.');

  const candidateResult = runStage6CandidateEconomy();
  equal(candidateResult.selectedCandidate, 'C', 'Stage 6 must still select Candidate C.');
  equal(
    candidateResult.version,
    STAGE6_CANDIDATE_ECONOMY_VERSION,
    'Candidate economy version remains simulation-only history.',
  );
  equal(
    entries[2].economyVersion.scope,
    'simulation',
    'Candidate C entries are explicitly simulation-scoped.',
  );
  assert(
    new Set(sessions.map((session) => session.activityType)).size === 3,
    'Movement, presence, and participation remain distinct categories.',
  );
}

runCanonicalDomainTests();
