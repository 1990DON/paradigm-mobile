import { CompletedSession } from './behavioralSignals';
import {
  calculateWalkingXp,
  simulateStage6Scenario,
  stage6Scenarios,
} from './stage6Simulation';
import {
  analyzeStage6StressScenario,
  StressFlag,
} from './stage6StressTests';

export const DEFAULT_STAGE6_POPULATION_SEED = 1990;
export const DEFAULT_STAGE6_POPULATION_USERS = 1000;
export const DEFAULT_STAGE6_POPULATION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const SIMULATION_START_MS = 1704067200000;

export type Stage6PopulationArchetype =
  | 'healthy-explorer'
  | 'local-regular'
  | 'transit-heavy'
  | 'walking-heavy'
  | 'mixed-movement'
  | 'grinder';

export type Stage6PopulationConfig = {
  seed?: number;
  users?: number;
  days?: number;
};

export type Stage6PopulationProfile = {
  userCount: number;
  sessionCount: number;
  nodeXp: number;
  walkingXp: number;
  combinedXp: number;
  averageXpPerUser: number;
};

export type Stage6PopulationResult = {
  seed: number;
  simulatedDays: number;
  totalUsers: number;
  totalSessions: number;
  totalNodeXp: number;
  totalWalkingXp: number;
  totalCombinedXp: number;
  walkingXpShare: number;
  averageXpPerUser: number;
  medianXpPerUser: number;
  p90XpPerUser: number;
  p99XpPerUser: number;
  maxUserXp: number;
  top1PercentXpShare: number;
  perNodeXp: Record<string, number>;
  highestXpNode: string | null;
  highestXpNodeShare: number;
  profiles: Record<Stage6PopulationArchetype, Stage6PopulationProfile>;
  dailyCombinedXp: number[];
  diagnosticFlagCounts: Record<StressFlag, number>;
};

type UserSimulation = {
  archetype: Stage6PopulationArchetype;
  completedSessions: CompletedSession[];
  walkingDistanceKm: number;
};

type ArchetypeBehavior = {
  nodes: string[];
  dailySessionRange: [number, number];
  walkingRangeKm: [number, number];
  durationRangeMs: [number, number];
};

const ARCHETYPE_COUNTS: Record<Stage6PopulationArchetype, number> = {
  'healthy-explorer': 250,
  'local-regular': 250,
  'transit-heavy': 150,
  'walking-heavy': 150,
  'mixed-movement': 100,
  grinder: 100,
};

const ARCHETYPE_BEHAVIOR: Record<
  Stage6PopulationArchetype,
  ArchetypeBehavior
> = {
  'healthy-explorer': {
    nodes: ['court', 'bodega', 'transit', 'park'],
    dailySessionRange: [1, 3],
    walkingRangeKm: [0.8, 2.4],
    durationRangeMs: [45000, 150000],
  },
  'local-regular': {
    nodes: ['court', 'bodega'],
    dailySessionRange: [1, 2],
    walkingRangeKm: [0.2, 1.2],
    durationRangeMs: [45000, 120000],
  },
  'transit-heavy': {
    nodes: ['transit', 'transit', 'transit', 'court'],
    dailySessionRange: [1, 3],
    walkingRangeKm: [0.5, 1.8],
    durationRangeMs: [60000, 180000],
  },
  'walking-heavy': {
    nodes: ['park', 'park', 'transit'],
    dailySessionRange: [0, 1],
    walkingRangeKm: [4, 10],
    durationRangeMs: [45000, 120000],
  },
  'mixed-movement': {
    nodes: ['court', 'bodega', 'transit', 'park'],
    dailySessionRange: [1, 2],
    walkingRangeKm: [1.5, 4],
    durationRangeMs: [45000, 150000],
  },
  grinder: {
    nodes: ['bodega'],
    dailySessionRange: [3, 5],
    walkingRangeKm: [0, 0.2],
    durationRangeMs: [8000, 20000],
  },
};

const ALL_FLAGS: StressFlag[] = [
  'GRIND_ABUSE',
  'DEAD_LOOP',
  'STAGNATION',
  'WALKING_DOMINANCE',
  'NODE_CONCENTRATION',
  'MALFORMED_HISTORY',
  'XP_INFLATION_SIGNAL',
];

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 4294967296;
  }

  integer(minimum: number, maximum: number): number {
    return minimum + Math.floor(this.next() * (maximum - minimum + 1));
  }

  range(minimum: number, maximum: number): number {
    return minimum + this.next() * (maximum - minimum);
  }
}

function validateConfig(config: Required<Stage6PopulationConfig>): void {
  if (!Number.isSafeInteger(config.seed)) {
    throw new Error('Population seed must be a safe integer');
  }
  if (!Number.isSafeInteger(config.users) || config.users < 0) {
    throw new Error('Population users must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(config.days) || config.days < 0) {
    throw new Error('Population days must be a non-negative safe integer');
  }
}

function resolveConfig(
  config: Stage6PopulationConfig = {},
): Required<Stage6PopulationConfig> {
  const resolved = {
    seed: config.seed ?? DEFAULT_STAGE6_POPULATION_SEED,
    users: config.users ?? DEFAULT_STAGE6_POPULATION_USERS,
    days: config.days ?? DEFAULT_STAGE6_POPULATION_DAYS,
  };
  validateConfig(resolved);
  return resolved;
}

function nodeXpById(): Record<string, number> {
  const totals: Record<string, number> = {};
  stage6Scenarios.forEach((scenario) => {
    scenario.completedSessions.forEach((completedSession) => {
      if (!(completedSession.nodeId in totals)) {
        totals[completedSession.nodeId] = completedSession.xpAwarded;
      }
    });
  });
  return totals;
}

function archetypeForUser(userIndex: number): Stage6PopulationArchetype {
  const populationSize = Object.values(ARCHETYPE_COUNTS).reduce(
    (total, count) => total + count,
    0,
  );
  const normalizedUserIndex = userIndex % populationSize;
  let offset = 0;
  for (const [archetype, count] of Object.entries(ARCHETYPE_COUNTS) as [
    Stage6PopulationArchetype,
    number,
  ][]) {
    if (normalizedUserIndex < offset + count) {
      return archetype;
    }
    offset += count;
  }
  throw new Error('Population composition does not cover the user');
}

function createUserSimulation(
  userIndex: number,
  archetype: Stage6PopulationArchetype,
  days: number,
  random: SeededRandom,
  xpByNode: Record<string, number>,
): UserSimulation {
  const behavior = ARCHETYPE_BEHAVIOR[archetype];
  const completedSessions: CompletedSession[] = [];
  let walkingDistanceKm = 0;

  for (let day = 0; day < days; day += 1) {
    const sessionCount = random.integer(
      behavior.dailySessionRange[0],
      behavior.dailySessionRange[1],
    );
    walkingDistanceKm += random.range(
      behavior.walkingRangeKm[0],
      behavior.walkingRangeKm[1],
    );

    for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
      const nodeId = behavior.nodes[random.integer(0, behavior.nodes.length - 1)];
      const durationMs = Math.round(
        random.range(
          behavior.durationRangeMs[0],
          behavior.durationRangeMs[1],
        ),
      );
      const startedAt =
        SIMULATION_START_MS +
        day * DAY_MS +
        userIndex * 1000 +
        sessionIndex * 300000;
      const completedAt = startedAt + durationMs;
      completedSessions.push({
        nodeId,
        nodeName: nodeId,
        startedAt,
        completedAt,
        xpAwarded: xpByNode[nodeId],
      });
    }
  }

  return { archetype, completedSessions, walkingDistanceKm };
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil(sortedValues.length * percentileValue) - 1,
  );
  return sortedValues[index];
}

function addProfileResult(
  profile: Stage6PopulationProfile,
  sessionCount: number,
  nodeXp: number,
  walkingXp: number,
): void {
  profile.sessionCount += sessionCount;
  profile.nodeXp += nodeXp;
  profile.walkingXp += walkingXp;
  profile.combinedXp += nodeXp + walkingXp;
}

function makeProfiles(
  userCount: number,
): Record<Stage6PopulationArchetype, Stage6PopulationProfile> {
  const profileUserCounts = Object.fromEntries(
    Object.keys(ARCHETYPE_COUNTS).map((archetype) => [archetype, 0]),
  ) as Record<Stage6PopulationArchetype, number>;
  for (let userIndex = 0; userIndex < userCount; userIndex += 1) {
    profileUserCounts[archetypeForUser(userIndex)] += 1;
  }

  return Object.fromEntries(
    Object.entries(profileUserCounts).map(([archetype, count]) => [
      archetype,
      {
        userCount: count,
        sessionCount: 0,
        nodeXp: 0,
        walkingXp: 0,
        combinedXp: 0,
        averageXpPerUser: 0,
      },
    ]),
  ) as Record<Stage6PopulationArchetype, Stage6PopulationProfile>;
}

function highestNode(
  perNodeXp: Record<string, number>,
): { node: string | null; share: number } {
  const entries = Object.entries(perNodeXp).sort(
    ([firstNode], [secondNode]) => firstNode.localeCompare(secondNode),
  );
  if (entries.length === 0) {
    return { node: null, share: 0 };
  }
  const [node, xp] = entries.reduce((highest, entry) =>
    entry[1] > highest[1] ? entry : highest,
  );
  const totalNodeXp = entries.reduce((total, [, nodeXp]) => total + nodeXp, 0);
  return {
    node,
    share: totalNodeXp > 0 ? xp / totalNodeXp : 0,
  };
}

export function runStage6PopulationSimulation(
  inputConfig: Stage6PopulationConfig = {},
): Stage6PopulationResult {
  const config = resolveConfig(inputConfig);
  const random = new SeededRandom(config.seed);
  const xpByNode = nodeXpById();
  const profiles = makeProfiles(config.users);
  const perNodeXp: Record<string, number> = {};
  const dailyCombinedXp = Array.from({ length: config.days }, () => 0);
  const diagnosticFlagCounts = Object.fromEntries(
    ALL_FLAGS.map((flag) => [flag, 0]),
  ) as Record<StressFlag, number>;
  const userXp: number[] = [];
  let totalSessions = 0;
  let totalWalkingXp = 0;

  for (let userIndex = 0; userIndex < config.users; userIndex += 1) {
    const archetype = archetypeForUser(userIndex);
    const user = createUserSimulation(
      userIndex,
      archetype,
      config.days,
      random,
      xpByNode,
    );
    const simulation = simulateStage6Scenario({
      name: 'mixed-movement-node',
      completedSessions: user.completedSessions,
      walkingDistanceKm: user.walkingDistanceKm,
    });
    const walkingXp = calculateWalkingXp(user.walkingDistanceKm);
    const profile = profiles[archetype];

    totalSessions += simulation.completedSessionCount;
    totalWalkingXp += walkingXp;
    userXp.push(simulation.combinedXp);
    addProfileResult(
      profile,
      simulation.completedSessionCount,
      simulation.nodeXpTotal,
      walkingXp,
    );

    Object.entries(simulation.perNodeXpProduced).forEach(([nodeId, xp]) => {
      perNodeXp[nodeId] = (perNodeXp[nodeId] ?? 0) + xp;
    });

    user.completedSessions.forEach((completedSession) => {
      const dayIndex = Math.floor(
        (completedSession.completedAt - SIMULATION_START_MS) / DAY_MS,
      );
      if (dayIndex >= 0 && dayIndex < dailyCombinedXp.length) {
        dailyCombinedXp[dayIndex] += completedSession.xpAwarded;
      }
    });
    const walkingXpPerDay =
      config.days > 0 ? walkingXp / config.days : 0;
    dailyCombinedXp.forEach((_, dayIndex) => {
      dailyCombinedXp[dayIndex] += walkingXpPerDay;
    });

    const diagnostic = analyzeStage6StressScenario({
      scenarioName: `${archetype}-${userIndex}`,
      completedSessions: user.completedSessions,
      walkingDistanceKm: user.walkingDistanceKm,
    });
    diagnostic.flags.forEach((flag) => {
      diagnosticFlagCounts[flag] += 1;
    });
  }

  const sortedUserXp = [...userXp].sort((first, second) => first - second);
  const totalNodeXp = Object.values(perNodeXp).reduce(
    (total, xp) => total + xp,
    0,
  );
  const totalCombinedXp = totalNodeXp + totalWalkingXp;
  const highest = highestNode(perNodeXp);
  const topUserCount = Math.ceil(config.users * 0.01);
  const topUserXp = sortedUserXp
    .slice(Math.max(0, sortedUserXp.length - topUserCount))
    .reduce((total, xp) => total + xp, 0);

  Object.values(profiles).forEach((profile) => {
    profile.averageXpPerUser =
      profile.userCount > 0 ? profile.combinedXp / profile.userCount : 0;
  });

  return {
    seed: config.seed,
    simulatedDays: config.days,
    totalUsers: config.users,
    totalSessions,
    totalNodeXp,
    totalWalkingXp,
    totalCombinedXp,
    walkingXpShare: totalCombinedXp > 0 ? totalWalkingXp / totalCombinedXp : 0,
    averageXpPerUser: config.users > 0 ? totalCombinedXp / config.users : 0,
    medianXpPerUser: percentile(sortedUserXp, 0.5),
    p90XpPerUser: percentile(sortedUserXp, 0.9),
    p99XpPerUser: percentile(sortedUserXp, 0.99),
    maxUserXp: sortedUserXp[sortedUserXp.length - 1] ?? 0,
    top1PercentXpShare: totalCombinedXp > 0 ? topUserXp / totalCombinedXp : 0,
    perNodeXp,
    highestXpNode: highest.node,
    highestXpNodeShare: highest.share,
    profiles,
    dailyCombinedXp,
    diagnosticFlagCounts,
  };
}

export function runDefaultStage6PopulationSimulation(): Stage6PopulationResult {
  return runStage6PopulationSimulation();
}
