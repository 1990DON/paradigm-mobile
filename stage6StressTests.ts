import { CompletedSession } from './behavioralSignals';
import {
  calculateWalkingXp,
  simulateStage6Scenario,
  Stage6SimulationResult,
} from './stage6Simulation';

export const NODE_CONCENTRATION_THRESHOLD = 0.8;
export const WALKING_DOMINANCE_THRESHOLD = 0.75;
export const REPEAT_STREAK_THRESHOLD = 5;
export const SHORT_AVG_SESSION_MS = 15000;
export const STAGNATION_SESSION_THRESHOLD = 10;
export const STAGNATION_MAX_DISTINCT_NODES = 2;
export const DEAD_LOOP_MAX_DISTANCE_KM = 0.5;

// PROVISIONAL SIMULATION THRESHOLDS

export type StressFlag =
  | 'GRIND_ABUSE'
  | 'DEAD_LOOP'
  | 'STAGNATION'
  | 'WALKING_DOMINANCE'
  | 'NODE_CONCENTRATION'
  | 'MALFORMED_HISTORY'
  | 'XP_INFLATION_SIGNAL';

export type Stage6StressScenario = {
  scenarioName: string;
  completedSessions: CompletedSession[];
  walkingDistanceKm: number;
};

export type Stage6StressTestResult = {
  scenarioName: string;
  sessionCount: number;
  distinctNodeCount: number;
  nodeXp: number;
  perNodeXp: Record<string, number>;
  walkingDistanceKm: number;
  walkingXp: number;
  combinedXp: number;
  averageSessionDurationMs: number;
  lastCompletedAt: number | null;
  consecutiveSameNodeCompletions: number;
  nodeXpConcentration: number;
  walkingXpShare: number;
  xpPerSession: number;
  malformedSessionCount: number;
  flags: StressFlag[];
};

type ScenarioSessionInput = Omit<CompletedSession, 'nodeName'> & {
  nodeName?: string;
};

function session(
  nodeId: string,
  startedAt: number,
  completedAt: number,
  xpAwarded: number,
  nodeName = nodeId,
): CompletedSession {
  return { nodeId, nodeName, startedAt, completedAt, xpAwarded };
}

function isMalformedSession(completedSession: ScenarioSessionInput): boolean {
  return (
    completedSession.nodeId.length === 0 ||
    !Number.isFinite(completedSession.startedAt) ||
    !Number.isFinite(completedSession.completedAt) ||
    completedSession.completedAt < completedSession.startedAt ||
    !Number.isFinite(completedSession.xpAwarded) ||
    completedSession.xpAwarded < 0
  );
}

function isValidSession(
  completedSession: CompletedSession,
): completedSession is CompletedSession {
  return !isMalformedSession(completedSession);
}

function makeRepeatedSessions(
  count: number,
  nodeId: string,
  durationMs: number,
  xpAwarded: number,
): CompletedSession[] {
  return Array.from({ length: count }, (_, index) => {
    const startedAt = 1000 + index * (durationMs + 9000);
    return session(nodeId, startedAt, startedAt + durationMs, xpAwarded);
  });
}

function makeStagnantSessions(): CompletedSession[] {
  return Array.from({ length: 12 }, (_, index) => {
    const nodeId = index % 2 === 0 ? 'court' : 'park';
    const startedAt = 1000 + index * 90000;
    return session(nodeId, startedAt, startedAt + 60000, index % 2 === 0 ? 45 : 20);
  });
}

function makeExtremeVolumeSessions(): CompletedSession[] {
  return makeRepeatedSessions(20, 'court', 60000, 45);
}

export const stage6StressScenarios: Stage6StressScenario[] = [
  {
    scenarioName: 'healthy-explorer',
    completedSessions: [
      session('court', 1000, 61000, 45),
      session('bodega', 120000, 210000, 12),
      session('transit', 260000, 380000, 28),
      session('park', 430000, 580000, 20),
    ],
    walkingDistanceKm: 2.8,
  },
  {
    scenarioName: 'same-node-grinder',
    completedSessions: makeRepeatedSessions(8, 'court', 60000, 45),
    walkingDistanceKm: 0.2,
  },
  {
    scenarioName: 'rapid-fire-grinder',
    completedSessions: makeRepeatedSessions(8, 'bodega', 10000, 12),
    walkingDistanceKm: 0.1,
  },
  {
    scenarioName: 'walking-heavy-user',
    completedSessions: [session('park', 1000, 61000, 20)],
    walkingDistanceKm: 20,
  },
  {
    scenarioName: 'mixed-balanced-user',
    completedSessions: [
      session('court', 1000, 61000, 45),
      session('bodega', 120000, 180000, 12),
      session('transit', 240000, 360000, 28),
      session('park', 420000, 510000, 20),
    ],
    walkingDistanceKm: 3.5,
  },
  {
    scenarioName: 'stagnant-user',
    completedSessions: makeStagnantSessions(),
    walkingDistanceKm: 1,
  },
  {
    scenarioName: 'dead-loop-user',
    completedSessions: makeRepeatedSessions(7, 'transit', 120000, 28),
    walkingDistanceKm: 0.1,
  },
  {
    scenarioName: 'transit-heavy-user',
    completedSessions: [
      ...makeRepeatedSessions(8, 'transit', 60000, 28),
      session('court', 900000, 960000, 45),
    ],
    walkingDistanceKm: 0.8,
  },
  {
    scenarioName: 'malformed-history-user',
    completedSessions: [
      session('court', 1000, 61000, 45),
      session('court', 61000, 60000, 45),
      session('court', Number.NaN, 62000, 45),
      session('unknown', 63000, 63000, Number.NaN),
      session('', 64000, 64000, -1),
    ],
    walkingDistanceKm: Number.NaN,
  },
  {
    scenarioName: 'extreme-volume-user',
    completedSessions: makeExtremeVolumeSessions(),
    walkingDistanceKm: 0,
  },
];

function maxNodeConcentration(
  perNodeXp: Record<string, number>,
  nodeXp: number,
): number {
  if (!Number.isFinite(nodeXp) || nodeXp <= 0) {
    return 0;
  }

  const largestNodeXp = Math.max(...Object.values(perNodeXp));
  return Number.isFinite(largestNodeXp) ? largestNodeXp / nodeXp : 0;
}

function malformedSessionCount(scenario: Stage6StressScenario): number {
  return scenario.completedSessions.filter(isMalformedSession).length;
}

function stressFlags(
  result: Stage6StressTestResult,
  malformedCount: number,
): StressFlag[] {
  const flags: StressFlag[] = [];
  const hasHighRepetition =
    result.consecutiveSameNodeCompletions >= REPEAT_STREAK_THRESHOLD;
  const hasShortSessions =
    result.averageSessionDurationMs > 0 &&
    result.averageSessionDurationMs <= SHORT_AVG_SESSION_MS;
  const hasConcentratedNodeXp =
    result.nodeXpConcentration >= NODE_CONCENTRATION_THRESHOLD;

  if (hasHighRepetition && (hasShortSessions || hasConcentratedNodeXp)) {
    flags.push('GRIND_ABUSE');
  }
  if (
    hasHighRepetition &&
    result.walkingDistanceKm <= DEAD_LOOP_MAX_DISTANCE_KM
  ) {
    flags.push('DEAD_LOOP');
  }
  if (
    result.sessionCount >= STAGNATION_SESSION_THRESHOLD &&
    result.distinctNodeCount <= STAGNATION_MAX_DISTINCT_NODES
  ) {
    flags.push('STAGNATION');
  }
  if (result.walkingXpShare >= WALKING_DOMINANCE_THRESHOLD) {
    flags.push('WALKING_DOMINANCE');
  }
  if (hasConcentratedNodeXp) {
    flags.push('NODE_CONCENTRATION');
  }
  if (
    malformedCount > 0 ||
    !Number.isFinite(result.walkingDistanceKm) ||
    result.walkingDistanceKm < 0
  ) {
    flags.push('MALFORMED_HISTORY');
  }
  if (
    result.sessionCount >= STAGNATION_SESSION_THRESHOLD &&
    result.walkingDistanceKm <= DEAD_LOOP_MAX_DISTANCE_KM
  ) {
    flags.push('XP_INFLATION_SIGNAL');
  }

  return flags;
}

export function analyzeStage6StressScenario(
  scenario: Stage6StressScenario,
): Stage6StressTestResult {
  const validSessions = scenario.completedSessions.filter(isValidSession);
  const hasValidWalkingDistance =
    Number.isFinite(scenario.walkingDistanceKm) &&
    scenario.walkingDistanceKm >= 0;
  const simulatedWalkingDistanceKm = hasValidWalkingDistance
    ? scenario.walkingDistanceKm
    : 0;
  const simulation: Stage6SimulationResult = simulateStage6Scenario({
    name: 'mixed-movement-node',
    completedSessions: validSessions,
    walkingDistanceKm: simulatedWalkingDistanceKm,
  });
  const malformedCount = malformedSessionCount(scenario);
  const walkingXp = calculateWalkingXp(simulatedWalkingDistanceKm);
  const combinedXp = simulation.nodeXpTotal + walkingXp;
  const nodeXpConcentration = maxNodeConcentration(
    simulation.perNodeXpProduced,
    simulation.nodeXpTotal,
  );
  const walkingXpShare =
    Number.isFinite(combinedXp) && combinedXp > 0
      ? walkingXp / combinedXp
      : 0;
  const result: Stage6StressTestResult = {
    scenarioName: scenario.scenarioName,
    sessionCount: simulation.completedSessionCount,
    distinctNodeCount: simulation.distinctNodeCount,
    nodeXp: simulation.nodeXpTotal,
    perNodeXp: simulation.perNodeXpProduced,
    walkingDistanceKm: simulatedWalkingDistanceKm,
    walkingXp,
    combinedXp,
    averageSessionDurationMs: simulation.averageSessionDurationMs,
    lastCompletedAt: simulation.lastCompletedAt,
    consecutiveSameNodeCompletions: simulation.consecutiveSameNodeCompletions,
    nodeXpConcentration,
    walkingXpShare,
    xpPerSession:
      simulation.completedSessionCount > 0
        ? combinedXp / simulation.completedSessionCount
        : 0,
    malformedSessionCount: malformedCount,
    flags: [],
  };

  return {
    ...result,
    flags: stressFlags(
      result,
      malformedCount + (hasValidWalkingDistance ? 0 : 1),
    ),
  };
}

export function runStage6StressTests(): Stage6StressTestResult[] {
  return stage6StressScenarios.map(analyzeStage6StressScenario);
}
