import {
  ActivitySession,
  ActivitySessionId,
  CanonicalEventId,
  CanonicalEventRecord,
  CanonicalObservationId,
  EconomyVersion,
  EXISTING_NODE_IDS,
  EXISTING_NODE_RECORDS,
  NodeId,
  NodeRecord,
  LocationObservation,
  ParticipationSession,
  PresenceSession,
  XPEntry,
  XPEntryId,
  WalkingSession,
  canQualifyForGpsVerifiedPresence,
  deriveAcceptedAuthoritativeEvents,
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
  parseCanonicalEventId,
  parseCanonicalObservationId,
  parseNodeId,
  parseUserId,
  parseXPEntryId,
  recordXPEntry,
  recordCanonicalEvent,
  recordLocationObservation,
  sortCanonicalEvents,
  sortLocationObservations,
  validateActivitySession,
  validateCanonicalEvent,
  validateLocationObservation,
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
      userId: TEST_USER_ID,
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

  const verificationOutsideInterval: PresenceSession = {
    ...presence,
    evidence: {
      verification: {
        ...VERIFIED_PRESENCE_EVIDENCE,
        verifiedAt: 2999,
      },
    },
  };
  assert(
    !validateActivitySession(verificationOutsideInterval, TEST_NODES).valid,
    'A GPS verification timestamp outside the completed session interval is invalid.',
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

  const walkingObservationId = id(
    parseCanonicalObservationId('observation-walking-1'),
    'Walking observation id',
  );
  const walkingObservation: LocationObservation = {
    id: walkingObservationId,
    userId: TEST_USER_ID,
    sessionId: walking.id,
    kind: 'walking',
    observedAt: 6500,
    location: { latitude: 0, longitude: 0 },
    evidenceStatus: 'unverified',
    source: 'manual',
    idempotencyKey: 'observation-walking-1',
  };
  assert(
    validateLocationObservation(
      walkingObservation,
      [walking],
      EXISTING_NODE_RECORDS,
    ).valid,
    'Node-less walking observations remain valid.',
  );
  assert(
    validateLocationObservation(
      { ...walkingObservation, userId: id(parseUserId('other-user'), 'Other user id') },
      [walking],
      TEST_NODES,
    ).valid === false,
    'Walking observations must bind to the session user.',
  );
  assert(
    validateLocationObservation(
      { ...walkingObservation, sessionId: id(parseActivitySessionId('other-session'), 'Other session id') },
      [walking],
      TEST_NODES,
    ).valid === false,
    'Walking observations must reference an existing session.',
  );
  assert(
    validateLocationObservation(
      { ...walkingObservation, observedAt: walking.startedAt - 1 },
      [walking],
      TEST_NODES,
    ).valid === false,
    'Observations before the session interval are invalid.',
  );
  assert(
    validateLocationObservation(
      { ...walkingObservation, observedAt: walking.startedAt + 1001 },
      [walking],
      TEST_NODES,
    ).valid === false,
    'Observations after a completed session are invalid.',
  );

  const presenceObservation: LocationObservation = {
    id: id(
      parseCanonicalObservationId('observation-presence-1'),
      'Presence observation id',
    ),
    userId: TEST_USER_ID,
    sessionId: PRESENCE_ID,
    kind: 'presence',
    nodeId: PARK_ID,
    observedAt: 4000,
    location: { latitude: 0, longitude: 0 },
    evidenceStatus: 'verified',
    source: 'gps',
    idempotencyKey: 'observation-presence-1',
  };
  assert(
    validateLocationObservation(
      presenceObservation,
      [presence],
      TEST_NODES,
    ).valid,
    'Verified presence observations bind correctly to session, user, and node.',
  );
  assert(
    !validateLocationObservation(
      { ...presenceObservation, sessionId: PARTICIPATION_ID },
      [presence, participation],
      TEST_NODES,
    ).valid,
    'A presence observation cannot be reassigned to a participation session.',
  );
  assert(
    !validateLocationObservation(
      { ...presenceObservation, nodeId: COURT_ID },
      [presence],
      TEST_NODES,
    ).valid,
    'GPS observation nodeId cannot be contaminated by an unrelated node.',
  );
  assert(
    !validateLocationObservation(
      {
        ...presenceObservation,
        evidenceStatus: 'verified',
        location: { latitude: 1, longitude: 1 },
      },
      [presence],
      TEST_NODES,
    ).valid,
    'Verified presence cannot use a location outside node geography.',
  );

  const simulatedPresence: LocationObservation = {
    ...presenceObservation,
    id: id(
      parseCanonicalObservationId('observation-presence-simulated'),
      'Simulated presence observation id',
    ),
    evidenceStatus: 'simulated',
    source: 'simulation',
    idempotencyKey: 'observation-presence-simulated',
  };
  assert(
    validateLocationObservation(
      simulatedPresence,
      [presence],
      TEST_NODES,
    ).valid,
    'Simulated observations are represented distinctly and can remain recorded.',
  );

  const participationObservation: LocationObservation = {
    id: id(
      parseCanonicalObservationId('observation-participation-1'),
      'Participation observation id',
    ),
    userId: TEST_USER_ID,
    sessionId: PARTICIPATION_ID,
    kind: 'participation',
    nodeId: COURT_ID,
    observedAt: 1500,
    evidenceStatus: 'verified',
    source: 'organized',
    idempotencyKey: 'observation-participation-1',
  };
  assert(
    validateLocationObservation(
      participationObservation,
      [participation],
      TEST_NODES,
    ).valid,
    'Participation evidence is distinct from geographic presence.',
  );
  const participationEvent: CanonicalEventRecord = {
    id: id(
      parseCanonicalEventId('event-participation-1'),
      'Participation canonical event id',
    ),
    userId: TEST_USER_ID,
    sessionId: PARTICIPATION_ID,
    kind: 'participation_observation',
    nodeId: COURT_ID,
    occurredAt: 2000,
    evidenceStatus: 'verified',
    observationIds: [participationObservation.id],
    idempotencyKey: 'event-participation-1',
  };
  assert(
    validateCanonicalEvent(
      participationEvent,
      [participationObservation],
      [participation],
      TEST_NODES,
    ).valid,
    'Participation events preserve session identity and explicit evidence source.',
  );
  assert(
    participationObservation.kind !== presenceObservation.kind &&
      presenceObservation.kind !== walkingObservation.kind &&
      walkingObservation.kind !== participationObservation.kind,
    'Walking, presence, and participation observations remain separate kinds.',
  );

  const simulatedParticipationObservation: LocationObservation = {
    ...participationObservation,
    id: id(
      parseCanonicalObservationId('observation-participation-simulated'),
      'Simulated participation observation id',
    ),
    evidenceStatus: 'simulated',
    source: 'simulation',
    idempotencyKey: 'observation-participation-simulated',
  };
  const simulatedParticipationEvent: CanonicalEventRecord = {
    ...participationEvent,
    id: id(
      parseCanonicalEventId('event-participation-simulated'),
      'Simulated participation event id',
    ),
    evidenceStatus: 'simulated',
    observationIds: [simulatedParticipationObservation.id],
    idempotencyKey: 'event-participation-simulated',
  };
  const participationAuthority = deriveAcceptedAuthoritativeEvents(
    [simulatedParticipationEvent],
    [simulatedParticipationObservation],
    [participation],
    TEST_NODES,
  );
  assert(
    participationAuthority.valid &&
      participationAuthority.value.length === 0,
    'Simulated participation evidence never becomes authoritative.',
  );

  const presenceEvent: CanonicalEventRecord = {
    id: id(
      parseCanonicalEventId('event-presence-1'),
      'Presence canonical event id',
    ),
    userId: TEST_USER_ID,
    sessionId: PRESENCE_ID,
    kind: 'presence_observation',
    nodeId: PARK_ID,
    occurredAt: 5000,
    evidenceStatus: 'verified',
    observationIds: [presenceObservation.id],
    idempotencyKey: 'event-presence-1',
  };
  assert(
    validateCanonicalEvent(
      presenceEvent,
      [presenceObservation],
      [presence],
      TEST_NODES,
    ).valid,
    'Canonical presence events validate with complete observation evidence.',
  );
  assert(
    !validateCanonicalEvent(
      { ...presenceEvent, occurredAt: 3999 },
      [presenceObservation],
      [presence],
      TEST_NODES,
    ).valid,
    'Canonical events cannot precede their observation evidence.',
  );
  assert(
    !validateCanonicalEvent(
      { ...presenceEvent, sessionId: PARTICIPATION_ID },
      [presenceObservation],
      [presence, participation],
      TEST_NODES,
    ).valid,
    'Canonical events cannot reuse observations from another session.',
  );

  const simulatedPresenceEvent: CanonicalEventRecord = {
    ...presenceEvent,
    id: id(
      parseCanonicalEventId('event-presence-simulated'),
      'Simulated presence event id',
    ),
    idempotencyKey: 'event-presence-simulated',
    evidenceStatus: 'simulated',
    observationIds: [simulatedPresence.id],
  };
  assert(
    validateCanonicalEvent(
      simulatedPresenceEvent,
      [simulatedPresence],
      [presence],
      TEST_NODES,
    ).valid,
    'Simulated presence remains a valid recorded event.',
  );

  const observationReplay = recordLocationObservation(
    [presenceObservation],
    presenceObservation,
  );
  equal(
    observationReplay.status,
    'duplicate',
    'Duplicate observation submission is replay-safe.',
  );
  assert(
    recordLocationObservation(
      [presenceObservation],
      { ...presenceObservation, location: { latitude: 1, longitude: 1 } },
    ).status === 'conflict',
    'Conflicting observation identities are rejected.',
  );

  const eventReplay = recordCanonicalEvent([presenceEvent], presenceEvent);
  equal(
    eventReplay.status,
    'duplicate',
    'Duplicate canonical event submission is replay-safe.',
  );
  assert(
    recordCanonicalEvent(
      [presenceEvent],
      { ...presenceEvent, occurredAt: presenceEvent.occurredAt + 1 },
    ).status === 'conflict',
    'Conflicting canonical event identities are rejected.',
  );

  const orderedEvents = sortCanonicalEvents([
    { ...presenceEvent, occurredAt: 5000 },
    {
      ...presenceEvent,
      id: id(parseCanonicalEventId('event-presence-earlier'), 'Earlier event id'),
      idempotencyKey: 'event-presence-earlier',
      occurredAt: 4000,
    },
  ]);
  equal(
    orderedEvents[0].occurredAt,
    4000,
    'Canonical event ordering is deterministic by timestamp.',
  );
  assert(
    sortLocationObservations([
      { ...presenceObservation, observedAt: 4500 },
      { ...presenceObservation, observedAt: 4000 },
    ])[0].observedAt === 4000,
    'Location observation ordering is deterministic by timestamp.',
  );

  const authoritative = deriveAcceptedAuthoritativeEvents(
    [presenceEvent, simulatedPresenceEvent],
    [presenceObservation, simulatedPresence],
    [presence],
    TEST_NODES,
  );
  assert(authoritative.valid, 'Authoritative event derivation should validate.');
  equal(
    authoritative.value.length,
    1,
    'Only verified, non-simulated presence evidence becomes authoritative.',
  );

  const simulatedWalkingObservation: LocationObservation = {
    ...walkingObservation,
    id: id(
      parseCanonicalObservationId('observation-walking-simulated'),
      'Simulated walking observation id',
    ),
    evidenceStatus: 'simulated',
    source: 'simulation',
    idempotencyKey: 'observation-walking-simulated',
  };
  const simulatedWalkingEvent: CanonicalEventRecord = {
    id: id(
      parseCanonicalEventId('event-walking-simulated'),
      'Simulated walking event id',
    ),
    userId: TEST_USER_ID,
    sessionId: walking.id,
    kind: 'walking_observation',
    occurredAt: 6500,
    evidenceStatus: 'simulated',
    observationIds: [simulatedWalkingObservation.id],
    idempotencyKey: 'event-walking-simulated',
  };
  const simulatedWalkingAuthority = deriveAcceptedAuthoritativeEvents(
    [simulatedWalkingEvent],
    [simulatedWalkingObservation],
    [walking],
    TEST_NODES,
  );
  assert(
    simulatedWalkingAuthority.valid &&
      simulatedWalkingAuthority.value.length === 0,
    'Simulated walking observations never become accepted authoritative evidence.',
  );

  const verifiedLookingSimulatedWalkingEvent: CanonicalEventRecord = {
    ...simulatedWalkingEvent,
    id: id(
      parseCanonicalEventId('event-walking-self-claimed-verified'),
      'Self-claimed walking event id',
    ),
    idempotencyKey: 'event-walking-self-claimed-verified',
    evidenceStatus: 'verified',
    observationIds: [
      id(
        parseCanonicalObservationId('observation-walking-real-looking'),
        'Real-looking walking observation id',
      ),
    ],
  };
  const verifiedLookingSimulatedWalkingObservation: LocationObservation = {
    ...walkingObservation,
    id: verifiedLookingSimulatedWalkingEvent.observationIds[0],
    evidenceStatus: 'verified',
    source: 'gps-device',
    idempotencyKey: 'observation-walking-real-looking',
  };
  const selfClaimedAuthority = deriveAcceptedAuthoritativeEvents(
    [verifiedLookingSimulatedWalkingEvent],
    [verifiedLookingSimulatedWalkingObservation],
    [walking],
    TEST_NODES,
  );
  assert(
    selfClaimedAuthority.valid &&
      selfClaimedAuthority.value.length === 0,
    'Verified-looking evidence cannot authorize a simulated walking session.',
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
  assert(
    !validateXPEntry(
      { ...entries[0], awardedAt: 1999 },
      sessions,
      TEST_NODES,
    ).valid,
    'XP awards cannot precede their source session completion.',
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
