import {
  runStage6PopulationSimulation,
  Stage6PopulationArchetype,
  Stage6PopulationResult,
} from './stage6PopulationSimulation';

export const SENSITIVITY_SEED = 1990;
export const SENSITIVITY_USERS = 1000;
export const SENSITIVITY_DAYS = 30;

export type SensitivityParameter =
  | 'court'
  | 'bodega'
  | 'transit'
  | 'park'
  | 'walking';

export type SensitivityExperiment = {
  name: string;
  changedParameter: SensitivityParameter | null;
  parameterValue: number;
  result: Stage6PopulationResult;
};

export type SensitivityDelta = {
  name: string;
  changedParameter: SensitivityParameter;
  parameterValue: number;
  metrics: Record<string, { absolute: number; percentage: number | null }>;
};

export type SensitivitySummary = {
  parameter: SensitivityParameter;
  score: number;
  largestChange: {
    totalXp: string;
    walkingShare: string;
    nodeConcentration: string;
    archetypeOutcomes: string;
    diagnosticCounts: string;
  };
};

export type Stage6SensitivityLabResult = {
  baseline: SensitivityExperiment;
  experiments: SensitivityExperiment[];
  deltasFromBaseline: SensitivityDelta[];
  sensitivityRanking: SensitivitySummary[];
};

const BASELINE = {
  court: 45,
  bodega: 12,
  transit: 28,
  park: 20,
  walking: 5,
} as const;

const VARIANTS: Array<{
  parameter: SensitivityParameter;
  value: number;
}> = [
  { parameter: 'court', value: 34 },
  { parameter: 'court', value: 56 },
  { parameter: 'bodega', value: 9 },
  { parameter: 'bodega', value: 15 },
  { parameter: 'transit', value: 21 },
  { parameter: 'transit', value: 35 },
  { parameter: 'park', value: 15 },
  { parameter: 'park', value: 25 },
  { parameter: 'walking', value: 3.75 },
  { parameter: 'walking', value: 6.25 },
];

const ARCHETYPES: Stage6PopulationArchetype[] = [
  'healthy-explorer',
  'local-regular',
  'transit-heavy',
  'walking-heavy',
  'mixed-movement',
  'grinder',
];

function configFor(
  parameter: SensitivityParameter | null,
  value: number,
) {
  const values = { ...BASELINE, ...(parameter ? { [parameter]: value } : {}) };
  return {
    seed: SENSITIVITY_SEED,
    users: SENSITIVITY_USERS,
    days: SENSITIVITY_DAYS,
    nodeXp: {
      court: values.court,
      bodega: values.bodega,
      transit: values.transit,
      park: values.park,
    },
    walkingXpPerKm: values.walking,
  };
}

function runExperiment(
  name: string,
  parameter: SensitivityParameter | null,
  value: number,
): SensitivityExperiment {
  return {
    name,
    changedParameter: parameter,
    parameterValue: value,
    result: runStage6PopulationSimulation(configFor(parameter, value)),
  };
}

function percentageDelta(value: number, baseline: number): number | null {
  return baseline === 0 ? null : (value - baseline) / Math.abs(baseline);
}

function metricDelta(value: number, baseline: number) {
  return {
    absolute: value - baseline,
    percentage: percentageDelta(value, baseline),
  };
}

function makeDelta(
  experiment: SensitivityExperiment,
  baseline: Stage6PopulationResult,
): SensitivityDelta {
  const result = experiment.result;
  const metrics: Record<string, { absolute: number; percentage: number | null }> = {
    totalCombinedXp: metricDelta(result.totalCombinedXp, baseline.totalCombinedXp),
    walkingXpShare: metricDelta(result.walkingXpShare, baseline.walkingXpShare),
    highestNodeShare: metricDelta(
      result.highestXpNodeShare,
      baseline.highestXpNodeShare,
    ),
    top1PercentXpShare: metricDelta(
      result.top1PercentXpShare,
      baseline.top1PercentXpShare,
    ),
  };

  ARCHETYPES.forEach((archetype) => {
    metrics[`archetype:${archetype}`] = metricDelta(
      result.profiles[archetype].averageXpPerUser,
      baseline.profiles[archetype].averageXpPerUser,
    );
  });

  return {
    name: experiment.name,
    changedParameter: experiment.changedParameter as SensitivityParameter,
    parameterValue: experiment.parameterValue,
    metrics,
  };
}

function variantFor(
  parameter: SensitivityParameter,
  direction: 'low' | 'high',
  experiments: SensitivityExperiment[],
): SensitivityExperiment {
  const matches = experiments.filter(
    (experiment) => experiment.changedParameter === parameter,
  );
  return direction === 'low' ? matches[0] : matches[1];
}

function largestDirectionalChange(
  parameter: SensitivityParameter,
  baseline: Stage6PopulationResult,
  experiments: SensitivityExperiment[],
  selector: (result: Stage6PopulationResult) => number,
): string {
  const low = variantFor(parameter, 'low', experiments);
  const high = variantFor(parameter, 'high', experiments);
  return Math.abs(selector(high.result) - selector(baseline)) >=
    Math.abs(selector(low.result) - selector(baseline))
    ? high.name
    : low.name;
}

function diagnosticChange(
  parameter: SensitivityParameter,
  baseline: Stage6PopulationResult,
  experiments: SensitivityExperiment[],
): string {
  const low = variantFor(parameter, 'low', experiments);
  const high = variantFor(parameter, 'high', experiments);
  const diagnosticDelta = (experiment: SensitivityExperiment) =>
    Object.keys(baseline.diagnosticFlagCounts).reduce(
      (total, flag) =>
        total +
        Math.abs(
          experiment.result.diagnosticFlagCounts[flag as keyof typeof baseline.diagnosticFlagCounts] -
            baseline.diagnosticFlagCounts[flag as keyof typeof baseline.diagnosticFlagCounts],
        ),
      0,
    );
  return diagnosticDelta(high) >= diagnosticDelta(low) ? high.name : low.name;
}

function makeSummary(
  parameter: SensitivityParameter,
  baseline: Stage6PopulationResult,
  experiments: SensitivityExperiment[],
): SensitivitySummary {
  const low = variantFor(parameter, 'low', experiments);
  const high = variantFor(parameter, 'high', experiments);
  const maxPercentageChange = (selector: (result: Stage6PopulationResult) => number) =>
    Math.max(
      Math.abs(percentageDelta(selector(low.result), selector(baseline)) ?? 0),
      Math.abs(percentageDelta(selector(high.result), selector(baseline)) ?? 0),
    );

  return {
    parameter,
    score:
      (maxPercentageChange((result) => result.totalCombinedXp) +
        maxPercentageChange((result) => result.walkingXpShare) +
        maxPercentageChange((result) => result.highestXpNodeShare)) /
      3,
    largestChange: {
      totalXp: largestDirectionalChange(
        parameter,
        baseline,
        experiments,
        (result) => result.totalCombinedXp,
      ),
      walkingShare: largestDirectionalChange(
        parameter,
        baseline,
        experiments,
        (result) => result.walkingXpShare,
      ),
      nodeConcentration: largestDirectionalChange(
        parameter,
        baseline,
        experiments,
        (result) => result.highestXpNodeShare,
      ),
      archetypeOutcomes: largestDirectionalChange(
        parameter,
        baseline,
        experiments,
        (result) =>
          Math.max(
            ...ARCHETYPES.map(
              (archetype) =>
                Math.abs(
                  percentageDelta(
                    result.profiles[archetype].averageXpPerUser,
                    baseline.profiles[archetype].averageXpPerUser,
                  ) ?? 0,
                ),
            ),
          ),
      ),
      diagnosticCounts: diagnosticChange(parameter, baseline, experiments),
    },
  };
}

export function runStage6SensitivityLab(): Stage6SensitivityLabResult {
  const baseline = runExperiment('baseline', null, BASELINE.court);
  const experiments = [
    baseline,
    ...VARIANTS.map(({ parameter, value }) =>
      runExperiment(`${parameter}-${value}`, parameter, value),
    ),
  ];
  const variantExperiments = experiments.slice(1);

  return {
    baseline,
    experiments,
    deltasFromBaseline: variantExperiments.map((experiment) =>
      makeDelta(experiment, baseline.result),
    ),
    sensitivityRanking: (
      ['court', 'bodega', 'transit', 'park', 'walking'] as SensitivityParameter[]
    )
      .map((parameter) =>
        makeSummary(parameter, baseline.result, variantExperiments),
      )
      .sort((first, second) => second.score - first.score),
  };
}

export function serializeStage6SensitivityLab(
  result: Stage6SensitivityLabResult,
): string {
  return JSON.stringify(result);
}