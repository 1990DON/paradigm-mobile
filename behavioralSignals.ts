export type CompletedSession = {
  nodeId: string;
  nodeName: string;
  startedAt: number;
  completedAt: number;
  xpAwarded: number;
};

export type BehavioralSignals = {
  completedSessionCount: number;
  distinctNodeCount: number;
  totalCompletedXp: number;
  averageSessionDurationMs: number;
  lastCompletedAt: number | null;
  consecutiveSameNodeCompletions: number;
};

export function deriveBehavioralSignals(
  completedSessions: CompletedSession[],
): BehavioralSignals {
  const completedSessionCount = completedSessions.length;
  const distinctNodeCount = new Set(
    completedSessions.map((session) => session.nodeId),
  ).size;
  const totalCompletedXp = completedSessions.reduce(
    (total, session) => total + session.xpAwarded,
    0,
  );

  const validDurations = completedSessions
    .map((session) => ({
      startedAt: session.startedAt,
      completedAt: session.completedAt,
    }))
    .filter(
      (session) =>
        Number.isFinite(session.startedAt) &&
        Number.isFinite(session.completedAt) &&
        session.completedAt >= session.startedAt,
    )
    .map((session) => session.completedAt - session.startedAt);

  const averageSessionDurationMs =
    validDurations.length > 0
      ? validDurations.reduce((total, duration) => total + duration, 0) /
        validDurations.length
      : 0;

  const finiteCompletedAtValues = completedSessions
    .map((session) => session.completedAt)
    .filter((value) => Number.isFinite(value));

  const lastCompletedAt =
    finiteCompletedAtValues.length > 0
      ? Math.max(...finiteCompletedAtValues)
      : null;

  const consecutiveSameNodeCompletions =
    completedSessions.length === 0
      ? 0
      : (() => {
          let streak = 0;
          const finalNodeId = completedSessions[completedSessions.length - 1].nodeId;

          for (let index = completedSessions.length - 1; index >= 0; index -= 1) {
            if (completedSessions[index].nodeId !== finalNodeId) {
              break;
            }

            streak += 1;
          }

          return streak;
        })();

  return {
    completedSessionCount,
    distinctNodeCount,
    totalCompletedXp,
    averageSessionDurationMs,
    lastCompletedAt,
    consecutiveSameNodeCompletions,
  };
}

export function deriveNodeXpTotals(
  completedSessions: CompletedSession[],
): Record<string, number> {
  const totals = new Map<string, number>();

  completedSessions.forEach((session) => {
    totals.set(
      session.nodeId,
      (totals.get(session.nodeId) ?? 0) + session.xpAwarded,
    );
  });

  return Object.fromEntries(
    [...totals.entries()].sort(([firstNodeId], [secondNodeId]) =>
      firstNodeId.localeCompare(secondNodeId),
    ),
  );
}