import {
  ActivityCategory,
  ActivitySession,
  ActivitySessionId,
  CanonicalEventId,
  CanonicalEventRecord,
  CanonicalObservationId,
  EconomyVersion,
  LocationObservation,
  NodeRecord,
  UserRecord,
  XPEntry,
  XPEntryId,
  completeActivitySession,
  parseActivitySessionId,
  parseCanonicalEventId,
  parseCanonicalObservationId,
  parseXPEntryId,
  recordCanonicalEvent,
  recordLocationObservation,
  recordXPEntry,
  sortCanonicalEvents,
  sortLocationObservations,
  validateActivitySession,
  validateCanonicalEvent,
  validateLocationObservation,
  validateXPEntry,
} from './canonicalDomain';

export type ProcessingLifecycle = 'created' | 'active' | 'completed';

export type ProcessingSession = {
  lifecycle: ProcessingLifecycle;
  activity: ActivitySession;
};

export type PersistenceSnapshot = {
  users: readonly UserRecord[];
  nodes: readonly NodeRecord[];
  sessions: readonly ProcessingSession[];
  observations: readonly LocationObservation[];
  events: readonly CanonicalEventRecord[];
  xpEntries: readonly XPEntry[];
};

export interface SessionPersistenceTransaction {
  readonly snapshot: PersistenceSnapshot;
  saveUser(user: UserRecord): void;
  saveNode(node: NodeRecord): void;
  saveSession(session: ProcessingSession): void;
  replaceSession(session: ProcessingSession): void;
  saveObservation(observation: LocationObservation): void;
  saveEvent(event: CanonicalEventRecord): void;
  saveXPEntry(entry: XPEntry): void;
}

export interface SessionPersistence {
  snapshot(): PersistenceSnapshot;
  transaction<T>(
    work: (transaction: SessionPersistenceTransaction) => T,
  ): T;
}

/*
 * Production persistence adapters must implement transaction<T> as one database
 * transaction: reads must use the transaction snapshot, mutations must commit
 * together, and thrown/rollback responses must discard all staged mutations.
 * Isolation must prevent concurrent duplicate keys/replays; database uniqueness
 * constraints remain required because this interface is not a concurrency lock.
 */

function cloneSnapshot(snapshot: PersistenceSnapshot): PersistenceSnapshot {
  return {
    users: snapshot.users.map((value) => ({ ...value })),
    nodes: snapshot.nodes.map((value) => ({ ...value })),
    sessions: snapshot.sessions.map((value) => ({
      lifecycle: value.lifecycle,
      activity: { ...value.activity } as ActivitySession,
    })),
    observations: snapshot.observations.map((value) => ({
      ...value,
      ...(value.location ? { location: { ...value.location } } : {}),
    })),
    events: snapshot.events.map((value) => ({
      ...value,
      observationIds: [...value.observationIds],
    })),
    xpEntries: snapshot.xpEntries.map((value) => ({
      ...value,
      source: { ...value.source },
      economyVersion: { ...value.economyVersion },
    })),
  };
}

export class InMemorySessionPersistence implements SessionPersistence {
  private state: PersistenceSnapshot;

  constructor(
    users: readonly UserRecord[] = [],
    nodes: readonly NodeRecord[] = [],
    initial: Partial<PersistenceSnapshot> = {},
  ) {
    this.state = {
      users,
      nodes,
      sessions: initial.sessions ?? [],
      observations: initial.observations ?? [],
      events: initial.events ?? [],
      xpEntries: initial.xpEntries ?? [],
    };
  }

  snapshot(): PersistenceSnapshot {
    return cloneSnapshot(this.state);
  }

  transaction<T>(
    work: (transaction: SessionPersistenceTransaction) => T,
  ): T {
    const staged = cloneSnapshot(this.state);
    let result: T;
    const transaction: SessionPersistenceTransaction = {
      snapshot: staged,
      saveUser: (user) => {
        staged.users = [...staged.users.filter((item) => item.id !== user.id), user];
      },
      saveNode: (node) => {
        staged.nodes = [...staged.nodes.filter((item) => item.id !== node.id), node];
      },
      saveSession: (session) => {
        staged.sessions = [...staged.sessions, session];
      },
      replaceSession: (session) => {
        staged.sessions = staged.sessions.map((item) =>
          item.activity.id === session.activity.id ? session : item,
        );
      },
      saveObservation: (observation) => {
        staged.observations = [...staged.observations, observation];
      },
      saveEvent: (event) => {
        staged.events = [...staged.events, event];
      },
      saveXPEntry: (entry) => {
        staged.xpEntries = [...staged.xpEntries, entry];
      },
    };

    try {
      result = work(transaction);
    } catch (error) {
      throw error;
    }
    this.state = staged;
    return result;
  }
}

export type CreateSessionInput = {
  id: ActivitySessionId;
  userId: UserRecord['id'];
  category: ActivityCategory;
  startedAt: number;
  nodeId?: NodeRecord['id'];
  walking?: {
    distanceMeters: number;
    distanceSource: 'simulated' | 'manual' | 'measured';
  };
  presence?: { status: 'observed' };
  participation?: {
    activityName: string;
    source: 'self_reported' | 'organized';
  };
};

export type AcceptObservationInput = Omit<LocationObservation, 'id'> & {
  id: CanonicalObservationId;
};

export type AcceptEventInput = Omit<CanonicalEventRecord, 'id'> & {
  id: CanonicalEventId;
};

export type RecordAwardInput = Omit<XPEntry, 'id'> & {
  id: XPEntryId;
};

export type ProcessingResult<T> =
  | { accepted: true; value: T }
  | { accepted: false; errors: readonly string[] };

export type CanonicalHistory = {
  sessions: readonly ProcessingSession[];
  observations: readonly LocationObservation[];
  events: readonly CanonicalEventRecord[];
  xpEntries: readonly XPEntry[];
};

export type DerivedSessionState = {
  sessionCount: number;
  completedSessionCount: number;
  eventCount: number;
  observationCount: number;
  xpByCategory: Record<ActivityCategory, number>;
  totalXp: number;
};

function sameXPEntry(first: XPEntry, second: XPEntry): boolean {
  const sameEconomy =
    first.economyVersion.scope === second.economyVersion.scope &&
    first.economyVersion.version === second.economyVersion.version &&
    (first.economyVersion.scope !== 'simulation' ||
      second.economyVersion.scope !== 'simulation' ||
      first.economyVersion.candidateId === second.economyVersion.candidateId);
  return (
    first.id === second.id &&
    first.idempotencyKey === second.idempotencyKey &&
    first.userId === second.userId &&
    first.source.activitySessionId === second.source.activitySessionId &&
    first.category === second.category &&
    first.amount === second.amount &&
    first.awardedAt === second.awardedAt &&
    sameEconomy
  );
}

export class SessionProcessor {
  constructor(private readonly persistence: SessionPersistence) {}

  createSession(input: CreateSessionInput): ProcessingResult<ProcessingSession> {
    return this.persistence.transaction((tx) => {
      const snapshot = tx.snapshot;
      if (!snapshot.users.some((user) => user.id === input.userId)) {
        return { accepted: false, errors: ['User does not exist.'] };
      }
      if (!parseActivitySessionId(String(input.id))) {
        return { accepted: false, errors: ['Session id is invalid.'] };
      }
      if (!Number.isFinite(input.startedAt) || input.startedAt < 0) {
        return { accepted: false, errors: ['Session startedAt is invalid.'] };
      }

      let activity: ActivitySession;
      if (input.category === 'walking') {
        if (!input.walking) {
          return { accepted: false, errors: ['Walking evidence is required.'] };
        }
        activity = {
          id: input.id,
          userId: input.userId,
          activityType: 'walking',
          startedAt: input.startedAt,
          status: 'in_progress',
          ...(input.nodeId ? { nodeId: input.nodeId } : {}),
          evidence: input.walking,
        };
      } else if (input.category === 'presence') {
        if (!input.nodeId || !input.presence) {
          return { accepted: false, errors: ['Presence node and evidence are required.'] };
        }
        activity = {
          id: input.id,
          userId: input.userId,
          activityType: 'presence',
          nodeId: input.nodeId,
          startedAt: input.startedAt,
          status: 'in_progress',
          evidence: { verification: { status: 'observed' } },
        };
      } else {
        if (!input.nodeId || !input.participation) {
          return { accepted: false, errors: ['Participation node and evidence are required.'] };
        }
        activity = {
          id: input.id,
          userId: input.userId,
          activityType: 'participation',
          nodeId: input.nodeId,
          startedAt: input.startedAt,
          status: 'in_progress',
          evidence: input.participation,
        };
      }

      const validation = validateActivitySession(activity, snapshot.nodes);
      if (!validation.valid) {
        return { accepted: false, errors: validation.errors };
      }
      const existing = snapshot.sessions.find((item) => item.activity.id === input.id);
      if (existing) {
        const first = existing.activity;
        const sameIdentity =
          first.id === validation.value.id &&
          first.userId === validation.value.userId &&
          first.activityType === validation.value.activityType &&
          first.startedAt === validation.value.startedAt &&
          first.nodeId === validation.value.nodeId &&
          (first.activityType !== 'walking' ||
            (validation.value.activityType === 'walking' &&
              first.evidence.distanceMeters === validation.value.evidence.distanceMeters &&
              first.evidence.distanceSource === validation.value.evidence.distanceSource)) &&
          (first.activityType !== 'participation' ||
            (validation.value.activityType === 'participation' &&
              first.evidence.activityName === validation.value.evidence.activityName &&
              first.evidence.source === validation.value.evidence.source));
        return sameIdentity
          ? { accepted: true, value: existing }
          : { accepted: false, errors: ['Session id conflicts with an existing session.'] };
      }

      const record: ProcessingSession = { lifecycle: 'created', activity: validation.value };
      tx.saveSession(record);
      return { accepted: true, value: record };
    });
  }

  startSession(sessionId: ActivitySessionId, userId: UserRecord['id']): ProcessingResult<ProcessingSession> {
    return this.persistence.transaction((tx) => {
      const session = tx.snapshot.sessions.find((item) => item.activity.id === sessionId);
      if (!session) return { accepted: false, errors: ['Session does not exist.'] };
      if (session.activity.userId !== userId) return { accepted: false, errors: ['User does not own this session.'] };
      if (session.lifecycle !== 'created') return { accepted: false, errors: ['Only a created session can be started.'] };
      const active: ProcessingSession = { lifecycle: 'active', activity: session.activity };
      tx.replaceSession(active);
      return { accepted: true, value: active };
    });
  }

  acceptObservation(input: AcceptObservationInput): ProcessingResult<LocationObservation> {
    return this.persistence.transaction((tx) => {
      const session = tx.snapshot.sessions.find((item) => item.activity.id === input.sessionId);
      if (!session) return { accepted: false, errors: ['Observation session does not exist.'] };
      const replay = recordLocationObservation(tx.snapshot.observations, input);
      if (replay.status === 'conflict') {
        return { accepted: false, errors: replay.errors };
      }
      if (replay.status === 'duplicate') {
        return { accepted: true, value: replay.observation };
      }
      if (session.lifecycle === 'completed') return { accepted: false, errors: ['Completed sessions cannot be modified.'] };
      if (session.lifecycle !== 'active') return { accepted: false, errors: ['Session must be active before evidence is accepted.'] };
      if (session.activity.userId !== input.userId) return { accepted: false, errors: ['Observation user does not own the session.'] };
      const validation = validateLocationObservation(
        input,
        tx.snapshot.sessions.map((item) => item.activity),
        tx.snapshot.nodes,
      );
      if (!validation.valid) return { accepted: false, errors: validation.errors };
      const recorded = recordLocationObservation(tx.snapshot.observations, validation.value);
      if (recorded.status === 'conflict') return { accepted: false, errors: recorded.errors };
      if (recorded.status === 'duplicate') return { accepted: true, value: recorded.observation };
      tx.saveObservation(recorded.observation);
      return { accepted: true, value: recorded.observation };
    });
  }

  acceptEvent(input: AcceptEventInput): ProcessingResult<CanonicalEventRecord> {
    return this.persistence.transaction((tx) => {
      const session = tx.snapshot.sessions.find((item) => item.activity.id === input.sessionId);
      if (!session) return { accepted: false, errors: ['Event session does not exist.'] };
      const replay = recordCanonicalEvent(tx.snapshot.events, input);
      if (replay.status === 'conflict') {
        return { accepted: false, errors: replay.errors };
      }
      if (replay.status === 'duplicate') {
        return { accepted: true, value: replay.event };
      }
      if (session.lifecycle === 'completed') return { accepted: false, errors: ['Completed sessions cannot be modified.'] };
      if (session.lifecycle !== 'active') return { accepted: false, errors: ['Session must be active before events are accepted.'] };
      if (session.activity.userId !== input.userId) return { accepted: false, errors: ['Event user does not own the session.'] };
      if (input.evidenceStatus === 'simulated') return { accepted: false, errors: ['Simulated evidence cannot be promoted to verified activity.'] };

      const validation = validateCanonicalEvent(
        input,
        tx.snapshot.observations,
        tx.snapshot.sessions.map((item) => item.activity),
        tx.snapshot.nodes,
      );
      if (!validation.valid) return { accepted: false, errors: validation.errors };
      if (validation.value.observationIds.some((observationId) => {
        const observation = tx.snapshot.observations.find((item) => item.id === observationId);
        return !observation || observation.evidenceStatus === 'simulated' ||
          observation.source === 'simulation' || observation.source === 'simulated';
      })) {
        return { accepted: false, errors: ['Event contains simulated evidence and is not live accepted activity.'] };
      }
      const recorded = recordCanonicalEvent(tx.snapshot.events, validation.value);
      if (recorded.status === 'conflict') return { accepted: false, errors: recorded.errors };
      if (recorded.status === 'duplicate') return { accepted: true, value: recorded.event };
      tx.saveEvent(recorded.event);
      return { accepted: true, value: recorded.event };
    });
  }

  completeSession(
    sessionId: ActivitySessionId,
    userId: UserRecord['id'],
    completedAt: number,
  ): ProcessingResult<ProcessingSession> {
    return this.persistence.transaction((tx) => {
      const current = tx.snapshot.sessions.find((item) => item.activity.id === sessionId);
      if (!current) return { accepted: false, errors: ['Session does not exist.'] };
      if (current.activity.userId !== userId) return { accepted: false, errors: ['User does not own this session.'] };
      if (current.lifecycle === 'completed') return { accepted: false, errors: ['Session is already completed.'] };
      if (current.lifecycle !== 'active') return { accepted: false, errors: ['Only an active session can be completed.'] };
      const result = completeActivitySession(current.activity, completedAt, tx.snapshot.nodes);
      if (!result.completed) return { accepted: false, errors: result.errors };
      const completed: ProcessingSession = { lifecycle: 'completed', activity: result.session };
      tx.replaceSession(completed);
      return { accepted: true, value: completed };
    });
  }

  recordAward(input: RecordAwardInput): ProcessingResult<XPEntry> {
    return this.persistence.transaction((tx) => {
      const validation = validateXPEntry(
        input,
        tx.snapshot.sessions.map((item) => item.activity),
        tx.snapshot.nodes,
      );
      if (!validation.valid) return { accepted: false, errors: validation.errors };
      const candidate = validation.value;
      const byId = tx.snapshot.xpEntries.find((entry) => entry.id === candidate.id);
      const byKey = tx.snapshot.xpEntries.find((entry) => entry.idempotencyKey === candidate.idempotencyKey);
      const existing = byId ?? byKey;
      if (existing) {
        return sameXPEntry(existing, candidate)
          ? { accepted: true, value: existing }
          : { accepted: false, errors: ['XP award id or idempotency key conflicts with an existing award.'] };
      }
      const recorded = recordXPEntry(tx.snapshot.xpEntries, candidate);
      if (recorded.status === 'conflict') return { accepted: false, errors: recorded.errors };
      tx.saveXPEntry(recorded.entry);
      return { accepted: true, value: recorded.entry };
    });
  }

  getHistory(userId?: UserRecord['id']): CanonicalHistory {
    const snapshot = this.persistence.snapshot();
    const sessions = snapshot.sessions
      .filter((item) => !userId || item.activity.userId === userId)
      .slice()
      .sort((a, b) => a.activity.startedAt - b.activity.startedAt ||
        String(a.activity.id).localeCompare(String(b.activity.id)));
    const sessionIds = new Set(sessions.map((item) => item.activity.id));
    return {
      sessions,
      observations: sortLocationObservations(
        snapshot.observations.filter((item) =>
          sessionIds.has(item.sessionId) && (!userId || item.userId === userId)),
      ),
      events: sortCanonicalEvents(
        snapshot.events.filter((item) =>
          sessionIds.has(item.sessionId) && (!userId || item.userId === userId)),
      ),
      xpEntries: snapshot.xpEntries
        .filter((item) => sessionIds.has(item.source.activitySessionId) &&
          (!userId || item.userId === userId))
        .slice()
        .sort((a, b) => a.awardedAt - b.awardedAt ||
          String(a.id).localeCompare(String(b.id))),
    };
  }

  deriveState(userId?: UserRecord['id']): DerivedSessionState {
    const history = this.getHistory(userId);
    const xpByCategory: Record<ActivityCategory, number> = {
      walking: 0,
      presence: 0,
      participation: 0,
    };
    history.xpEntries.forEach((entry) => {
      xpByCategory[entry.category] += entry.amount;
    });
    return {
      sessionCount: history.sessions.length,
      completedSessionCount: history.sessions.filter((item) => item.lifecycle === 'completed').length,
      eventCount: history.events.length,
      observationCount: history.observations.length,
      xpByCategory,
      totalXp: xpByCategory.walking + xpByCategory.presence + xpByCategory.participation,
    };
  }
}
