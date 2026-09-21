import {
  runStage6PopulationSimulation,
  Stage6PopulationConfig,
  Stage6PopulationResult,
} from './stage6PopulationSimulation';
import {
  runStage6StressTests,
  Stage6StressTestResult,
  StressFlag,
} from './stage6StressTests';

export const STAGE6_CANDIDATE_ECONOMY_VERSION =
  'STAGE 6 CANDIDATE ECONOMY V1';

export const STAGE6_CANDIDATE_SEED = 1990;
export const STAGE6_CANDIDATE_USERS = 1000;
export const STAGE6_CANDIDATE_DAYS = 30;

export type CandidateId = 'A' | 'B' | 'C';
export type CandidateLabel =
  | 'A - BALANCED'
  | 'B - MOVEMENT-HEAVY'
  | 'C - LOW-CONCENTRATION';

export type CandidateEconomyConfiguration = {
  court: number;
  bodega: number;
  transit: number;
  park: number;
  walking: number;
};

export type CandidateExperiment = {
  id: CandidateId | 'baseline';
  label: CandidateLabel | 'BASELINE';
  configuration: CandidateEconomyConfiguration;
  population: Stage6PopulationResult;
  stressBattery: Stage6StressTestResult[];
  deterministicReplay: boolean;
  malformedHistoryHandled: boolean;
  disqualifications: string[];
  eligible: boolean;
};

export type CandidateScore = {
  id: CandidateId;
  label: CandidateLabel;
  eligible: boolean;
  disqualifications: string[];
  raw: {
    nodeConcentrationImprovement: number;
    walkingBalance: number;
    totalXpDrift: number;
    top1PercentDrift: number;
    diagnosticBurden: number;
  };
  normalized: {
    nodeConcentrationImprovement: number;
    walkingBalance: number;
    totalXpDrift: number;
    top1PercentDrift: number;
    diagnosticBurden: number;
  };
  weighted: {
    nodeConcentrationImprovement: number;
    walkingBalance: number;
    totalXpDrift: number;
    top1PercentDrift: number;
    diagnosticBurden: number;
  };
  finalScore: number | null;
};

export type Stage6CandidateEconomyResult = {
  version: string;
  baseline: CandidateExperiment;
  candidates: CandidateExperiment[];
  scores: CandidateScore[];
  selectedCandidate: CandidateId | null;
  selectedCandidateLabel: CandidateLabel | null;
  selectedCandidateBattery: CandidateExperiment | null;
};

const BASELINE: CandidateEconomyConfiguration = {
  court: 45,
  bodega: 12,
  transit: 28,
  park: 20,
  walking: 5,
};

const CANDIDATES: Record<
  CandidateId,
  { label: CandidateLabel; configuration: CandidateEconomyConfiguration }
> = {
  A: {
    label: 'A - BALANCED',
    configuration: {
      court: 34,
      bodega: 12,
      transit: 28,
      park: 20,
      walking: 5,
    },
  },
  B: {
    label: 'B - MOVEMENT-HEAVY',
    configuration: {
      court: 45,
      bodega: 12,
      transit: 28,
      park: 20,
      walking: 6.25,
    },
  },
  C: {
    label: 'C - LOW-CONCENTRATION',
    configuration: {
      court: 34,
      bodega: 15,
      transit: 35,
      park: 25,
      walking: 5,
    },
  },
};

const CANDIDATE_IDS: CandidateId[] = ['A', 'B', 'C'];
const DIAGNOSTIC_BURDEN_FLAGS: StressFlag[] = [
  'GRIND_ABUSE',
  'STAGNATION',
  'WALKING_DOMINANCE',
  'NODE_CONCENTRATION',
];

function toPopulationConfig(
  configuration: CandidateEconomyConfiguration,
): Stage6PopulationConfig {
  return {
    seed: STAGE6_CANDIDATE_SEED,
    users: STAGE6_CANDIDATE_USERS,
    days: STAGE6_CANDIDATE_DAYS,
    nodeXp: {
      court: configuration.court,
      bodega: configuration.bodega,
      transit: configuration.transit,
      park: configuration.park,
    },
    walkingXpPerKm: configuration.walking,
  };
}

function isFiniteValue(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isFiniteValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).every(isFiniteValue);
  }
  return true;
}

function hasNegativeMetric(value: unknown, key = ''): boolean {
  if (typeof value === 'number') {
    return value < 0 &&
      (key.toLowerCase().includes('xp') ||
        key.toLowerCase().includes('session'));
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasNegativeMetric(item, key));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([entryKey, entryValue]) =>
      hasNegativeMetric(entryValue, entryKey),
    );
  }
  return false;
}

function malformedHistoryHandled(
  stressBattery: Stage6StressTestResult[],
): boolean {
  const malformed = stressBattery.find(
    (result) => result.scenarioName === 'malformed-history-user',
  );
  return Boolean(
    malformed &&
      malformed.malformedSessionCount > 0 &&
      malformed.flags.includes('MALFORMED_HISTORY') &&
      Number.isFinite(malformed.combinedXp),
  );
}

function makeDisqualifications(
  population: Stage6PopulationResult,
  stressBattery: Stage6StressTestResult[],
  deterministicReplay: boolean,
  malformedHandled: boolean,
): string[] {
  const disqualifications: string[] = [];
  if (!isFiniteValue(population) || !isFiniteValue(stressBattery)) {
    disqualifications.push('non-finite numeric metric');
  }
  if (hasNegativeMetric(population) || hasNegativeMetric(stressBattery)) {
    disqualifications.push('negative XP or session metric');
  }
  if (population.diagnosticFlagCounts.XP_INFLATION_SIGNAL > 0) {
    disqualifications.push('XP_INFLATION_SIGNAL appears');
  }
  if (population.diagnosticFlagCounts.DEAD_LOOP > 0) {
    disqualifications.push('DEAD_LOOP appears');
  }
  if (!malformedHandled) {
    disqualifications.push('malformed-history handling failed');
  }
  if (!deterministicReplay) {
    disqualifications.push('deterministic replay failed');
  }
  return disqualifications;
}

function makeExperiment(
  id: CandidateId | 'baseline',
  label: CandidateLabel | 'BASELINE',
  configuration: CandidateEconomyConfiguration,
): CandidateExperiment {
  const config = toPopulationConfig(configuration);
  const population = runStage6PopulationSimulation(config);
  const replay = runStage6PopulationSimulation(config);
  const stressBattery = runStage6StressTests();
  const replayStressBattery = runStage6StressTests();
  const deterministicReplay =
    JSON.stringify(population) === JSON.stringify(replay) &&
    JSON.stringify(stressBattery) === JSON.stringify(replayStressBattery);
  const malformedHandled = malformedHistoryHandled(stressBattery);
  const disqualifications = makeDisqualifications(
    population,
    stressBattery,
    deterministicReplay,
    malformedHandled,
  );

  return {
    id,
    label,
    configuration,
    population,
    stressBattery,
    deterministicReplay,
    malformedHistoryHandled: malformedHandled,
    disqualifications,
    eligible: disqualifications.length === 0,
  };
}

function diagnosticBurden(population: Stage6PopulationResult): number {
  return DIAGNOSTIC_BURDEN_FLAGS.reduce(
    (total, flag) => total + population.diagnosticFlagCounts[flag],
    0,
  );
}

function absolutePercentageDifference(value: number, baseline: number): number {
  return baseline === 0 ? Math.abs(value - baseline) : Math.abs((value - baseline) / Math.abs(baseline));
}

function rawScore(
  baseline: Stage6PopulationResult,
  candidate: Stage6PopulationResult,
): CandidateScore['raw'] {
  return {
    nodeConcentrationImprovement:
      baseline.highestXpNodeShare - candidate.highestXpNodeShare,
    walkingBalance: Math.abs(candidate.walkingXpShare - 0.2),
    totalXpDrift: absolutePercentageDifference(
      candidate.totalCombinedXp,
      baseline.totalCombinedXp,
    ),
    top1PercentDrift: absolutePercentageDifference(
      candidate.top1PercentXpShare,
      baseline.top1PercentXpShare,
    ),
    diagnosticBurden: diagnosticBurden(candidate),
  };
}

function normalizeHigherBetter(value: number, values: number[]): number {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return maximum === minimum ? 1 : (value - minimum) / (maximum - minimum);
}

function normalizeLowerBetter(value: number, values: number[]): number {
  return 1 - normalizeHigherBetter(value, values);
}

function makeScores(
  baseline: Stage6PopulationResult,
  experiments: CandidateExperiment[],
): CandidateScore[] {
  const eligible = experiments.filter((experiment) => experiment.eligible);
  const rawScores = eligible.map((experiment) =>
    rawScore(baseline, experiment.population),
  );
  const values = (key: keyof CandidateScore['raw']) =>
    rawScores.map((score) => score[key]);

  return experiments.map((experiment) => {
    if (!experiment.eligible) {
      return {
        id: experiment.id as CandidateId,
        label: experiment.label as CandidateLabel,
        eligible: false,
        disqualifications: experiment.disqualifications,
        raw: rawScore(baseline, experiment.population),
        normalized: {
          nodeConcentrationImprovement: 0,
          walkingBalance: 0,
          totalXpDrift: 0,
          top1PercentDrift: 0,
          diagnosticBurden: 0,
        },
        weighted: {
          nodeConcentrationImprovement: 0,
          walkingBalance: 0,
          totalXpDrift: 0,
          top1PercentDrift: 0,
          diagnosticBurden: 0,
        },
        finalScore: null,
      };
    }

    const raw = rawScore(baseline, experiment.population);
    const normalized = {
      nodeConcentrationImprovement: normalizeHigherBetter(
        raw.nodeConcentrationImprovement,
        values('nodeConcentrationImprovement'),
      ),
      walkingBalance: normalizeLowerBetter(raw.walkingBalance, values('walkingBalance')),
      totalXpDrift: normalizeLowerBetter(raw.totalXpDrift, values('totalXpDrift')),
      top1PercentDrift: normalizeLowerBetter(raw.top1PercentDrift, values('top1PercentDrift')),
      diagnosticBurden: normalizeLowerBetter(raw.diagnosticBurden, values('diagnosticBurden')),
    };
    const weighted = {
      nodeConcentrationImprovement: normalized.nodeConcentrationImprovement * 0.3,
      walkingBalance: normalized.walkingBalance * 0.25,
      totalXpDrift: normalized.totalXpDrift * 0.2,
      top1PercentDrift: normalized.top1PercentDrift * 0.1,
      diagnosticBurden: normalized.diagnosticBurden * 0.15,
    };

    return {
      id: experiment.id as CandidateId,
      label: experiment.label as CandidateLabel,
      eligible: true,
      disqualifications: [],
      raw,
      normalized,
      weighted,
      finalScore: Object.values(weighted).reduce((total, value) => total + value, 0),
    };
  });
}

export function runStage6CandidateEconomy(): Stage6CandidateEconomyResult {
  const baseline = makeExperiment('baseline', 'BASELINE', BASELINE);
  const candidates = CANDIDATE_IDS.map((id) =>
    makeExperiment(id, CANDIDATES[id].label, CANDIDATES[id].configuration),
  );
  const scores = makeScores(baseline.population, candidates);
  const eligibleScores = scores.filter(
    (score) => score.eligible && score.finalScore !== null,
  );
  const selectedScore = eligibleScores.reduce<CandidateScore | null>(
    (selected, score) =>
      selected === null || (score.finalScore ?? -Infinity) > (selected.finalScore ?? -Infinity)
        ? score
        : selected,
    null,
  );
  const selectedCandidate = selectedScore?.id ?? null;
  const selectedCandidateBattery = candidates.find(
    (candidate) => candidate.id === selectedCandidate,
  ) ?? null;

  return {
    version: STAGE6_CANDIDATE_ECONOMY_VERSION,
    baseline,
    candidates,
    scores,
    selectedCandidate,
    selectedCandidateLabel: selectedScore?.label ?? null,
    selectedCandidateBattery,
  };
}

export function serializeStage6CandidateEconomy(
  result: Stage6CandidateEconomyResult,
): string {
  return JSON.stringify(result);
}

export function runStage6SelectedCandidateBattery(): CandidateExperiment | null {
  const result = runStage6CandidateEconomy();
  return result.selectedCandidateBattery;
}