import {
  ActivitySession,
  ActivitySessionId,
  CanonicalEventId,
  CanonicalObservationId,
  EconomyVersion,
  NodeRecord,
  PresenceSession,
  UserRecord,
  XPEntryId,
  parseActivitySessionId,
  parseCanonicalEventId,
  parseCanonicalObservationId,
  parseNodeId,
  parseUserId,
  parseXPEntryId,
} from './canonicalDomain';
import {
  InMemorySessionPersistence,
  SessionPersistence,
  SessionPersistenceTransaction,
  SessionProcessor,
} from './sessionProcessor';

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

const userId = id(parseUserId('user-processor'), 'User id');
const otherUserId = id(parseUserId('user-other'), 'Other user id');
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
  return id(parseActivitySessionId(value), `Session id ${value}`);
}

function observationId(value: string): CanonicalObservationId {
  return id(parseCanonicalObservationId(value), `Observation id ${value}`);
}

function eventId(value: string): CanonicalEventId {
  return id(parseCanonicalEventId(value), `Event id ${value}`);
}

function walkingProcessor() {
  const store = new InMemorySessionPersistence([user], [verifiedCourt]);
  return { store, processor: new SessionProcessor(store) };
}

export function runSessionProcessorTests(): void {
  // 1. Valid lifecycle and 2/3 invalid transitions and duplicate completion.
  {
    const { processor } = walkingProcessor();
    const created = processor.createSession({
      id: sessionId('session-walking-1'),
      userId,
      category: 'walking',
      startedAt: 1000,
      walking: { distanceMeters: 500, distanceSource: 'measured' },
    });
    assert(created.accepted, 'Valid walking session must be created.');
    if (created.accepted) equal(created.value.lifecycle, 'created', 'Initial lifecycle');
    const started = processor.startSession(sessionId('session-walking-1'), userId);
    assert(started.accepted, 'Created session must start.');
    if (started.accepted) equal(started.value.lifecycle, 'active', 'Started lifecycle');
    const completed = processor.completeSession(sessionId('session-walking-1'), userId, 2000);
    assert(completed.accepted, 'Active session must complete.');
    if (completed.accepted) equal(completed.value.lifecycle, 'completed', 'Completed lifecycle');
    assert(
      processor.createSession({
        id: sessionId('session-walking-1'),
        userId,
        category: 'walking',
        startedAt: 1000,
        walking: { distanceMeters: 500, distanceSource: 'measured' },
      }).accepted,
      'Exact session creation replay must return the existing session.',
    );
    assert(
      !processor.createSession({
        id: sessionId('session-walking-1'),
        userId,
        category: 'walking',
        startedAt: 1000,
        walking: { distanceMeters: 501, distanceSource: 'measured' },
      }).accepted,
      'Conflicting session identity replay must fail.',
    );
    assert(
      !processor.completeSession(sessionId('session-walking-1'), userId, 2100).accepted,
      'Duplicate session completion must be rejected.',
    );
    assert(!processor.startSession(sessionId('session-walking-1'), userId).accepted, 'Completed session cannot restart.');
  }

  // Invalid lifecycle transitions and cross-user ownership.
  {
    const { processor } = walkingProcessor();
    processor.createSession({
      id: sessionId('session-invalid-lifecycle'),
      userId,
      category: 'walking',
      startedAt: 1000,
      walking: { distanceMeters: 100, distanceSource: 'measured' },
    });
    assert(
      !processor.completeSession(sessionId('session-invalid-lifecycle'), userId, 1500).accepted,
      'Created session cannot complete directly.',
    );
    assert(
      !processor.startSession(sessionId('session-invalid-lifecycle'), otherUserId).accepted,
      'Another user cannot start the session.',
    );
  }

  // 4. Duplicate observations/events and conflict retries.
  {
    const { processor } = walkingProcessor();
    processor.createSession({
      id: sessionId('session-retry'),
      userId,
      category: 'walking',
      startedAt: 1000,
      walking: { distanceMeters: 100, distanceSource: 'measured' },
    });
    processor.startSession(sessionId('session-retry'), userId);
    const observation = {
      id: observationId('observation-retry'),
      idempotencyKey: 'observation-retry-key',
      userId,
      sessionId: sessionId('session-retry'),
      kind: 'walking' as const,
      observedAt: 1200,
      location: { latitude: 0, longitude: 0 },
      evidenceStatus: 'unverified' as const,
      source: 'manual',
    };
    const firstObservation = processor.acceptObservation(observation);
    const retryObservation = processor.acceptObservation(observation);
    assert(firstObservation.accepted && retryObservation.accepted, 'Observation and exact retry must succeed.');
    equal(
      processor.getHistory().observations.length,
      1,
      'Duplicate observation retry must not add a second record.',
    );
    const conflicting = processor.acceptObservation({
      ...observation,
      observedAt: 1300,
    });
    assert(!conflicting.accepted, 'Conflicting observation key reuse must fail.');

    const event = {
      id: eventId('event-retry'),
      idempotencyKey: 'event-retry-key',
      userId,
      sessionId: sessionId('session-retry'),
      kind: 'walking_observation' as const,
      occurredAt: 1200,
      evidenceStatus: 'unverified' as const,
      observationIds: [observationId('observation-retry')] as readonly CanonicalObservationId[],
    };
    assert(processor.acceptEvent(event).accepted, 'Canonical event must be accepted.');
    assert(processor.acceptEvent(event).accepted, 'Exact event retry must be accepted.');
    equal(processor.getHistory().events.length, 1, 'Duplicate event retry must not duplicate history.');
    assert(
      !processor.acceptEvent({ ...event, occurredAt: 1300 }).accepted,
      'Conflicting event key reuse must fail.',
    );
    processor.completeSession(sessionId('session-retry'), userId, 1500);
    assert(
      processor.acceptObservation(observation).accepted &&
        processor.acceptEvent(event).accepted,
      'Exact evidence retries remain idempotent after session completion.',
    );
  }

  // 6/7/8 contamination and timestamp constraints.
  {
    const { processor } = walkingProcessor();
    processor.createSession({
      id: sessionId('session-a'),
      userId,
      category: 'walking',
      startedAt: 1000,
      walking: { distanceMeters: 100, distanceSource: 'measured' },
    });
    processor.createSession({
      id: sessionId('session-b'),
      userId: otherUserId,
      category: 'walking',
      startedAt: 1000,
      walking: { distanceMeters: 100, distanceSource: 'measured' },
    });
    processor.startSession(sessionId('session-a'), userId);
    assert(
      !processor.acceptObservation({
        id: observationId('observation-other-user'),
        idempotencyKey: 'observation-other-user',
        userId: otherUserId,
        sessionId: sessionId('session-a'),
        kind: 'walking',
        observedAt: 1100,
        location: { latitude: 0, longitude: 0 },
        evidenceStatus: 'unverified',
        source: 'manual',
      }).accepted,
      'Cross-user observation evidence must fail.',
    );
    assert(
      !processor.acceptObservation({
        id: observationId('observation-before'),
        idempotencyKey: 'observation-before',
        userId,
        sessionId: sessionId('session-a'),
        kind: 'walking',
        observedAt: 999,
        location: { latitude: 0, longitude: 0 },
        evidenceStatus: 'unverified',
        source: 'manual',
      }).accepted,
      'Evidence before the session interval must fail.',
    );
  }

  // 9 simulated evidence is recorded raw but cannot become live canonical event.
  {
    const { processor } = walkingProcessor();
    processor.createSession({
      id: sessionId('session-simulated'),
      userId,
      category: 'walking',
      startedAt: 1000,
      walking: { distanceMeters: 100, distanceSource: 'simulated' },
    });
    processor.startSession(sessionId('session-simulated'), userId);
    const simulated = processor.acceptObservation({
      id: observationId('observation-simulated'),
      idempotencyKey: 'observation-simulated',
      userId,
      sessionId: sessionId('session-simulated'),
      kind: 'walking',
      observedAt: 1100,
      location: { latitude: 0, longitude: 0 },
      evidenceStatus: 'simulated',
      source: 'simulation',
    });
    assert(simulated.accepted, 'Simulated evidence may be retained as a raw observation.');
    assert(
      !processor.acceptEvent({
        id: eventId('event-simulated'),
        idempotencyKey: 'event-simulated',
        userId,
        sessionId: sessionId('session-simulated'),
        kind: 'walking_observation',
        occurredAt: 1100,
        evidenceStatus: 'simulated',
        observationIds: [observationId('observation-simulated')],
      }).accepted,
      'Simulated evidence cannot be promoted to a live canonical event.',
    );
  }

  // 10/11 category separation and deterministic replay.
  {
    const { processor } = walkingProcessor();
    for (const [suffix, category, startedAt] of [
      ['walking', 'walking', 3000],
      ['presence', 'presence', 4000],
      ['participation', 'participation', 5000],
    ] as const) {
      const inputId = sessionId(`session-${suffix}`);
      const created = category === 'walking'
        ? processor.createSession({
            id: inputId, userId, category, startedAt,
            walking: { distanceMeters: 100, distanceSource: 'measured' },
          })
        : category === 'presence'
          ? processor.createSession({
              id: inputId, userId, category, startedAt, nodeId: courtId,
              presence: { status: 'observed' },
            })
          : processor.createSession({
              id: inputId, userId, category, startedAt, nodeId: courtId,
              participation: { activityName: 'Basketball', source: 'organized' },
            });
      assert(created.accepted, `${category} session must be distinct and valid.`);
      processor.startSession(inputId, userId);
    }
    const history = processor.getHistory();
    equal(history.sessions.length, 3, 'Three activity categories must remain separate.');
    equal(new Set(history.sessions.map((item) => item.activity.activityType)).size, 3, 'Category replay set');
    const first = processor.deriveState();
    const second = processor.deriveState();
    equal(JSON.stringify(first), JSON.stringify(second), 'Derived state must be deterministic.');
  }

  // 12/13 XP duplicate and conflicting award replay.
  {
    const { processor } = walkingProcessor();
    processor.createSession({
      id: sessionId('session-xp'),
      userId,
      category: 'walking',
      startedAt: 1000,
      walking: { distanceMeters: 1000, distanceSource: 'measured' },
    });
    processor.startSession(sessionId('session-xp'), userId);
    processor.completeSession(sessionId('session-xp'), userId, 2000);
    const entry = {
      id: id(parseXPEntryId('xp-entry-1'), 'XP entry id'),
      idempotencyKey: 'xp-award-1',
      userId,
      source: { activitySessionId: sessionId('session-xp') },
      category: 'walking' as const,
      amount: 5,
      economyVersion: { scope: 'live', version: 'stage6-live-v1' } as EconomyVersion,
      awardedAt: 2000,
    };
    assert(processor.recordAward(entry).accepted, 'Legitimate XP award must be accepted.');
    assert(processor.recordAward(entry).accepted, 'Exact XP retry must be accepted.');
    equal(processor.getHistory().xpEntries.length, 1, 'XP duplicate must not add twice.');
    assert(
      !processor.recordAward({ ...entry, amount: 50 }).accepted,
      'Conflicting award replay must fail.',
    );
  }

  // 14 Persistence failure leaves state unchanged.
  {
    const stagedStore = walkingProcessor().store;
    let rollbackThrew = false;
    try {
      stagedStore.transaction((tx) => {
        tx.saveSession({
          lifecycle: 'created',
          activity: {
            id: sessionId('session-rolled-back'),
            userId,
            activityType: 'walking',
            startedAt: 1000,
            status: 'in_progress',
            evidence: { distanceMeters: 100, distanceSource: 'measured' },
          },
        });
        throw new Error('commit failure after staging');
      });
    } catch {
      rollbackThrew = true;
    }
    assert(rollbackThrew, 'Staged transaction failure must be surfaced.');
    equal(stagedStore.snapshot().sessions.length, 0, 'Staged mutations must roll back.');

    class FailingPersistence implements SessionPersistence {
      snapshot(): ReturnType<InMemorySessionPersistence['snapshot']> {
        return new InMemorySessionPersistence([user], [verifiedCourt]).snapshot();
      }
      transaction<T>(_work: (transaction: SessionPersistenceTransaction) => T): T {
        throw new Error('simulated storage failure');
      }
    }
    const store = new FailingPersistence();
    const processor = new SessionProcessor(store);
    let threw = false;
    try {
      processor.createSession({
        id: sessionId('session-failure'),
        userId,
        category: 'walking',
        startedAt: 1000,
        walking: { distanceMeters: 100, distanceSource: 'measured' },
      });
    } catch {
      threw = true;
    }
    assert(threw, 'Storage failure must be surfaced.');
    equal(store.snapshot().sessions.length, 0, 'Failed transaction must not persist partial state.');
  }

  // 15 compatibility and Stage 7.1/7.2 contract reuse is exercised above.
  {
    const { processor } = walkingProcessor();
    const unknownUser = processor.createSession({
      id: sessionId('session-no-user'),
      userId: otherUserId,
      category: 'walking',
      startedAt: 1000,
      walking: { distanceMeters: 100, distanceSource: 'measured' },
    });
    assert(!unknownUser.accepted, 'Unknown user fails canonical identity validation.');
  }
}

runSessionProcessorTests();
