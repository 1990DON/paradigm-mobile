import {
  CompletedSession,
  deriveBehavioralSignals,
  deriveNodeXpTotals,
} from './behavioralSignals';

export const WALK_XP_PER_KM = 5;

export type Stage6ScenarioName =
  | 'repeated-same-node'
  | 'multi-node-explorer'
  | 'walking-heavy'
  | 'mixed-movement-node'
  | 'high-frequency-grinder'
  | 'malformed-spam-history';

export type Stage6Scenario = {
  name: Stage6ScenarioName;
  completedSessions: CompletedSession[];
  walkingDistanceKm: number;
};

export type Stage6SimulationResult = {
  scenarioName: Stage6ScenarioName;
  completedSessionCount: number;
  distinctNodeCount: number;
  nodeXpTotal: number;
  perNodeXpProduced: Record<string, number>;
  simulatedWalkingDistanceKm: number;
  simulatedWalkingXp: number;
  combinedXp: number;
  averageSessionDurationMs: number;
  lastCompletedAt: number | null;
  consecutiveSameNodeCompletions: number;
};

export function calculateWalkingXp(
  walkingDistanceKm: number,
  xpPerKm = WALK_XP_PER_KM,
): number {
  return walkingDistanceKm * xpPerKm;
}

function session(
  nodeId: string,
  nodeName: string,
  startedAt: number,
  completedAt: number,
  xpAwarded: number,
): CompletedSession {
  return { nodeId, nodeName, startedAt, completedAt, xpAwarded };
}

export const stage6Scenarios: Stage6Scenario[] = [
  {
    name: 'repeated-same-node',
    completedSessions: [
      session('court', 'Basketball Court', 1000, 61000, 45),
      session('court', 'Basketball Court', 120000, 180000, 45),
      session('court', 'Basketball Court', 240000, 300000, 45),
    ],
    walkingDistanceKm: 0.4,
  },
  {
    name: 'multi-node-explorer',
    completedSessions: [
      session('court', 'Basketball Court', 1000, 61000, 45),
      session('bodega', 'Neighborhood Bodega', 120000, 210000, 12),
      session('transit', 'Transit Zone', 260000, 380000, 28),
      session('park', 'Park', 430000, 580000, 20),
    ],
    walkingDistanceKm: 2.8,
  },
  {
    name: 'walking-heavy',
    completedSessions: [
      session('park', 'Park', 1000, 121000, 20),
    ],
    walkingDistanceKm: 12.5,
  },
  {
    name: 'mixed-movement-node',
    completedSessions: [
      session('transit', 'Transit Zone', 1000, 91000, 28),
      session('court', 'Basketball Court', 180000, 300000, 45),
      session('bodega', 'Neighborhood Bodega', 420000, 480000, 12),
    ],
    walkingDistanceKm: 4.2,
  },
  {
    name: 'high-frequency-grinder',
    completedSessions: [
      session('bodega', 'Neighborhood Bodega', 1000, 11000, 12),
      session('bodega', 'Neighborhood Bodega', 20000, 30000, 12),
      session('bodega', 'Neighborhood Bodega', 40000, 50000, 12),
      session('bodega', 'Neighborhood Bodega', 60000, 70000, 12),
      session('bodega', 'Neighborhood Bodega', 80000, 90000, 12),
      session('bodega', 'Neighborhood Bodega', 100000, 110000, 12),
    ],
    walkingDistanceKm: 0.1,
  },
  {
    name: 'malformed-spam-history',
    completedSessions: [
      session('court', 'Basketball Court', 1000, 61000, 45),
      session('court', 'Basketball Court', 61000, 60000, 45),
      session('court', 'Basketball Court', Number.NaN, 62000, 45),
      session('unknown', '', 63000, 63000, 0),
      session('unknown', '', 64000, 64000, 0),
    ],
    walkingDistanceKm: 0,
  },
];

export function simulateStage6Scenario(
  scenario: Stage6Scenario,
): Stage6SimulationResult {
  const behavioralSignals = deriveBehavioralSignals(scenario.completedSessions);
  const perNodeXpProduced = deriveNodeXpTotals(scenario.completedSessions);
  const simulatedWalkingXp = calculateWalkingXp(scenario.walkingDistanceKm);

  return {
    scenarioName: scenario.name,
    completedSessionCount: behavioralSignals.completedSessionCount,
    distinctNodeCount: behavioralSignals.distinctNodeCount,
    nodeXpTotal: behavioralSignals.totalCompletedXp,
    perNodeXpProduced,
    simulatedWalkingDistanceKm: scenario.walkingDistanceKm,
    simulatedWalkingXp,
    combinedXp: behavioralSignals.totalCompletedXp + simulatedWalkingXp,
    averageSessionDurationMs: behavioralSignals.averageSessionDurationMs,
    lastCompletedAt: behavioralSignals.lastCompletedAt,
    consecutiveSameNodeCompletions:
      behavioralSignals.consecutiveSameNodeCompletions,
  };
}

export function runStage6Simulation(): Stage6SimulationResult[] {
  return stage6Scenarios.map(simulateStage6Scenario);
}