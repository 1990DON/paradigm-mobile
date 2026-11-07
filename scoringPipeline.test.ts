import {
  ActivitySessionId,
  CanonicalEventId,
  CanonicalObservationId,
  NodeRecord,
  UserRecord,
  parseActivitySessionId,
  parseCanonicalEventId,
  parseCanonicalObservationId,
  parseNodeId,
  parseUserId,
  deriveXPProjections,
} from './canonicalDomain';
import {
  InMemorySessionPersistence,
  SessionPersistence,
  SessionPersistenceTransaction,
  SessionProcessor,
} from './sessionProcessor';
import {
  ScoringPipeline,
  STAGE6_BASELINE_WALKING_POLICY,
  UNDEFINED_PARTICIPATION_POLICY,
  UNDEFINED_PRESENCE_POLICY,
} from './scoringPipeline';
import { calculateWalkingXp, WALK_XP_PER_KM } from './stage6Simulation';
import { runStage6CandidateEconomy } from './stage6CandidateEconomy';

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

const userId = id(parseUserId('user-scoring'), 'User id');
const otherUserId = id(parseUserId('user-scoring-other'), 'Other user id');
const courtId = id(parseNodeId('court'), 'Court node id');
const user: UserRecord = { id: userId, createdAt: 0, updatedAt: 0 };
const otherUser: UserRecord = { id: otherUserId, createdAt: 0, updatedAt: 0 };
const verifiedCourt: NodeRecord = {
  id: courtId,
  name: 'Basketball Court',
  geography: {
    verification: 'verified',
    location: { latitude: 0, longitude: 0 },
    boundary: [
      { latitude: -0.01, longitude: -0.01 },
      { latitude: 0.01, longitude: -0.01 },
      { latitude: 0.01, longitude: 0.01 },
      { latitude: -0.01, longitude: 0.01 },
    ],
  },
};

function sessionId(value: string): ActivitySessionId {
  return id(parseActivitySessionId(value), `Session ${value}`);
}

function observationId(value: string): CanonicalObservationId {
  return id(parseCanonicalObservationId(value), `Observation ${value}`);
}

function eventId(value: string): CanonicalEventId {
  return id(parseCanonicalEventId(value), `Event ${value}`);
}

function setup() {
  const store = new InMemorySessionPersistence(
    [user, otherUser],
    [verifiedCourt],
  );
  const processor = new SessionProcessor(store);
  const pipeline = new ScoringPipeline(processor);
  return { store, processor, pipeline };
}

function createAndStartWalking(
  processor: SessionProcessor,
  value: string,
  distanceMeters = 500,
) {
  const idValue = sessionId(value);
  const created = processor.createSession({
    id: idValue,
    userId,
    category: 'walking',
    startedAt: 1000,
    walking: { distanceMeters, distanceSource: 'measured' },
  });
  assert(created.accepted, 'Walking session should be created.');
  const started = processor.startSession(idValue, userId);
  assert(started.accepted, 'Walking session should start.');
  return idValue;
}

export function runScoringPipelineTests(): void {
  // 1/2/3/4 Valid walking pipeline and full in-memory award reconstruction.
  {
    const { store, processor, pipeline } = setup();
    const walkingSession = createAndStartWalking(processor, 'session-score-walking');
    const walkingObservation = processor.acceptObservation({
      id: observationId('observation-score-walking'),
      idempotencyKey: 'observation-score-walking',
      userId,
      sessionId: walkingSession,
      kind: 'walking',
      observedAt: 1200,
      location: { latitude: 0, longitude: 0 },
      evidenceStatus: 'verified',
      source: 'gps',
    });
    assert(walkingObservation.accepted, 'Measured walking observation should be accepted.');
    const walkingEvent = processor.acceptEvent({
      id: eventId('event-score-walking'),
      idempotencyKey: 'event-score-walking',
      userId,
      sessionId: walkingSession,
      kind: 'walking_observation',
      occurredAt: 1200,
      evidenceStatus: 'verified',
      observationIds: [observationId('observation-score-walking')],
    });
    assert(walkingEvent.accepted, 'Walking event should be accepted.');
    const completed = processor.completeSession(walkingSession, userId, 2000);
    assert(completed.accepted, 'Walking session should complete.');

    const first = pipeline.evaluate({
      userId,
      sessionId: walkingSession,
      eventId: eventId('event-score-walking'),
      policy: STAGE6_BASELINE_WALKING_POLICY,
    });
    equal(first.status, 'ACCEPTED', 'Walking activity should score.');
    if (first.status === 'ACCEPTED') {
      equal(first.award.amount, calculateWalkingXp(0.5, WALK_XP_PER_KM), 'Stage 6 formula reuse');
      equal(first.award.category, 'walking', 'Walking remains its own category');
      equal(first.award.source.evidence?.eventId, eventId('event-score-walking'), 'Evidence event binding');
    }

    const replay = pipeline.evaluate({
      userId,
      sessionId: walkingSession,
      eventId: eventId('event-score-walking'),
      policy: STAGE6_BASELINE_WALKING_POLICY,
    });
    equal(replay.status, 'IDEMPOTENT_REPLAY', 'Exact scoring replay');
    equal(processor.getHistory(userId).xpEntries.length, 1, 'Retry must not add duplicate XP');
    equal(processor.deriveState(userId).totalXp, calculateWalkingXp(0.5, WALK_XP_PER_KM), 'Reconstructed total');
    const snapshot = store.snapshot();
    const projection = deriveXPProjections(
      userId,
      snapshot.xpEntries,
      snapshot.sessions.map((item) => item.activity),
      snapshot.nodes,
      snapshot.events,
      snapshot.observations,
    );
    assert(projection.valid, 'Evidence-bearing canonical XP projection must reconstruct.');
  }

  // 5 No fabricated distance / 8 simulated evidence / 12 timestamps and contamination.
  {
    const { processor, pipeline } = setup();
    const noDistanceSession = createAndStartWalking(
      processor,
      'session-score-no-distance',
      0,
    );
    const noDistanceObservation = processor.acceptObservation({
      id: observationId('observation-no-distance'),
      idempotencyKey: 'observation-no-distance',
      userId,
      sessionId: noDistanceSession,
      kind: 'walking',
      observedAt: 1100,
      location: { latitude: 0, longitude: 0 },
      evidenceStatus: 'verified',
      source: 'gps',
    });
    assert(noDistanceObservation.accepted, 'Observation setup should succeed before score validation.');
    assert(processor.acceptEvent({
      id: eventId('event-no-distance'),
      idempotencyKey: 'event-no-distance',
      userId,
      sessionId: noDistanceSession,
      kind: 'walking_observation',
      occurredAt: 1100,
      evidenceStatus: 'verified',
      observationIds: [observationId('observation-no-distance')],
    }).accepted, 'Event setup should succeed.');
    processor.completeSession(noDistanceSession, userId, 2000);
    equal(
      pipeline.evaluate({
        userId,
        sessionId: noDistanceSession,
        eventId: eventId('event-no-distance'),
        policy: STAGE6_BASELINE_WALKING_POLICY,
      }).status,
      'REJECTED',
      'Zero distance must not fabricate XP.',
    );

    const simulatedSession = createAndStartWalking(
      processor,
      'session-score-simulated',
    );
    assert(processor.acceptObservation({
      id: observationId('observation-simulated-score'),
      idempotencyKey: 'observation-simulated-score',
      userId,
      sessionId: simulatedSession,
      kind: 'walking',
      observedAt: 1100,
      location: { latitude: 0, longitude: 0 },
      evidenceStatus: 'simulated',
      source: 'simulation',
    }).accepted,
    'Stage 7.3 may retain simulated evidence as a raw observation.',
    );
    assert(
      !processor.acceptEvent({
        id: eventId('event-simulated-score'),
        idempotencyKey: 'event-simulated-score',
        userId,
        sessionId: simulatedSession,
        kind: 'walking_observation',
        occurredAt: 1100,
        evidenceStatus: 'simulated',
        observationIds: [observationId('observation-simulated-score')],
      }).accepted,
      'Simulated walking event cannot be accepted.',
    );

    const crossUserSession = createAndStartWalking(
      processor,
      'session-score-cross-user',
    );
    processor.completeSession(crossUserSession, userId, 2000);
    equal(
      pipeline.evaluate({
        userId: otherUserId,
        sessionId: crossUserSession,
        eventId: eventId('event-missing'),
        policy: STAGE6_BASELINE_WALKING_POLICY,
      }).status,
      'REJECTED',
      'Cross-user scoring must fail.',
    );
  }

  // 13 presence and participation policies remain deferred.
  {
    const { processor, pipeline } = setup();
    const presenceSession = processor.createSession({
      id: sessionId('session-score-presence'),
      userId,
      category: 'presence',
      startedAt: 1000,
      nodeId: courtId,
      presence: { status: 'observed' },
    });
    assert(presenceSession.accepted, 'Presence session should be created.');
    processor.startSession(sessionId('session-score-presence'), userId);
    const presenceEvent = processor.acceptEvent({
      id: eventId('event-score-presence-missing-observation'),
      idempotencyKey: 'event-score-presence-missing-observation',
      userId,
      sessionId: sessionId('session-score-presence'),
      kind: 'presence_observation',
      nodeId: courtId,
      occurredAt: 1000,
      evidenceStatus: 'verified',
      observationIds: [observationId('observation-score-presence-missing')],
    });
    assert(!presenceEvent.accepted, 'Event without canonical observation evidence is invalid.');
    equal(
      pipeline.evaluate({
        userId,
        sessionId: sessionId('session-score-presence'),
        eventId: eventId('event-score-presence-missing-observation'),
        policy: UNDEFINED_PRESENCE_POLICY,
      }).status,
      'DEFERRED',
      'Presence must defer when policy is undefined.',
    );

    const participationSession = processor.createSession({
      id: sessionId('session-score-participation'),
      userId,
      category: 'participation',
      startedAt: 1000,
      nodeId: courtId,
      participation: { activityName: 'Basketball', source: 'organized' },
    });
    assert(participationSession.accepted, 'Participation session should be created.');
    processor.startSession(sessionId('session-score-participation'), userId);
    equal(
      pipeline.evaluate({
        userId,
        sessionId: sessionId('session-score-participation'),
        eventId: eventId('event-score-participation-missing'),
        policy: UNDEFINED_PARTICIPATION_POLICY,
      }).status,
      'DEFERRED',
      'Participation must defer when policy is undefined.',
    );
  }

  // 9/10 duplicate and overlapping walking evidence; conflicting replay.
  {
    const { processor, pipeline } = setup();
    const sessionOne = createAndStartWalking(processor, 'session-score-duplicate');
    assert(processor.acceptObservation({
      id: observationId('observation-score-duplicate'),
      idempotencyKey: 'observation-score-duplicate',
      userId,
      sessionId: sessionOne,
      kind: 'walking',
      observedAt: 1100,
      location: { latitude: 0, longitude: 0 },
      evidenceStatus: 'verified',
      source: 'gps',
    }).accepted, 'Duplicate-path setup observation should accept.');
    assert(processor.acceptEvent({
      id: eventId('event-score-duplicate'),
      idempotencyKey: 'event-score-duplicate',
      userId,
      sessionId: sessionOne,
      kind: 'walking_observation',
      occurredAt: 1100,
      evidenceStatus: 'verified',
      observationIds: [observationId('observation-score-duplicate')],
    }).accepted, 'Duplicate-path setup event should accept.');
    processor.completeSession(sessionOne, userId, 2000);

    const first = pipeline.evaluate({
      userId,
      sessionId: sessionOne,
      eventId: eventId('event-score-duplicate'),
      policy: STAGE6_BASELINE_WALKING_POLICY,
    });
    equal(first.status, 'ACCEPTED', 'First walking award should be accepted.');

    equal(
      pipeline.evaluate({
        userId,
        sessionId: sessionOne,
        eventId: eventId('event-score-duplicate'),
        policy: STAGE6_BASELINE_WALKING_POLICY,
      }).status,
      'IDEMPOTENT_REPLAY',
      'Replay must remain idempotent.',
    );

    assert(processor.acceptObservation({
      id: observationId('observation-score-overlap'),
      idempotencyKey: 'observation-score-overlap',
      userId,
      sessionId: sessionOne,
      kind: 'walking',
      observedAt: 1200,
      location: { latitude: 0, longitude: 0 },
      evidenceStatus: 'verified',
      source: 'gps',
    }).accepted === false,
    'Adding evidence after completion must be rejected.',
    );

    equal(
      pipeline.evaluate({
        userId,
        sessionId: sessionOne,
        eventId: eventId('event-score-missing-overlap'),
        policy: STAGE6_BASELINE_WALKING_POLICY,
      }).status,
      'REJECTED',
      'Missing overlapping-event replay must be rejected.',
    );
  }

  // 14/17 atomic rollback and Stage 6 candidate simulation preservation.
  {
    const store = new InMemorySessionPersistence([user], [verifiedCourt]);
    let threw = false;
    try {
      store.transaction((tx) => {
        tx.saveUser({ id: userId, createdAt: 0, updatedAt: 1 });
        throw new Error('forced transaction failure');
      });
    } catch {
      threw = true;
    }
    assert(threw, 'Atomic transaction failure should surface.');
    equal(store.snapshot().users[0].updatedAt, 0, 'Failed staged mutation must roll back.');

    const before = runStage6CandidateEconomy();
    const after = runStage6CandidateEconomy();
    equal(
      JSON.stringify(before),
      JSON.stringify(after),
      'Stage 6 candidate simulation output remains deterministic and unchanged.',
    );
  }

  // Canonical invalid event and policy binding remain fail closed.
  {
    const { processor, pipeline } = setup();
    const session = createAndStartWalking(processor, 'session-score-invalid');
    processor.completeSession(session, userId, 2000);
    equal(
      pipeline.evaluate({
        userId,
        sessionId: session,
        eventId: eventId('event-score-invalid'),
        policy: UNDEFINED_PRESENCE_POLICY,
      }).status,
      'CONFLICT',
      'Presence policy must not be accepted for a walking category.',
    );
    equal(
      pipeline.evaluate({
        userId,
        sessionId: session,
        eventId: eventId('event-score-invalid'),
        policy: {
          ...STAGE6_BASELINE_WALKING_POLICY,
          economyVersion: {
            scope: 'simulation',
            version: 'candidate-c',
            candidateId: 'C',
          },
        },
      }).status,
      'CONFLICT',
      'Candidate C or simulation walking policy must not activate live scoring.',
    );
  }
}

runScoringPipelineTests();
