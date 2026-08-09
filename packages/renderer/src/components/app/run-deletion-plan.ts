import type { RunDeletionImpact } from "@buildwarden/shared";

export interface RunDeletionPlan {
  impacts: RunDeletionImpact[];
  targetRunIds: string[];
  affectedRunIds: Set<string>;
  runningRunIds: Set<string>;
  ownedDirectories: Set<string>;
  branches: Set<string>;
  artifactPaths: Set<string>;
  lockedOrMissingPaths: Set<string>;
}

export const buildRunDeletionPlan = (requestedImpacts: readonly RunDeletionImpact[]): RunDeletionPlan => {
  const impactByCoordinator = new Map<string, RunDeletionImpact>();
  for (const impact of requestedImpacts) impactByCoordinator.set(impact.coordinatorRunId, impact);
  const impacts = [...impactByCoordinator.values()];

  return {
    impacts,
    targetRunIds: impacts.map((impact) => impact.coordinatorRunId),
    affectedRunIds: new Set(impacts.flatMap((impact) => impact.runIds)),
    runningRunIds: new Set(impacts.flatMap((impact) => impact.runningRunIds)),
    ownedDirectories: new Set(impacts.flatMap((impact) => impact.ownedDirectories)),
    branches: new Set(impacts.flatMap((impact) => impact.branches)),
    artifactPaths: new Set(impacts.flatMap((impact) => impact.artifactPaths)),
    lockedOrMissingPaths: new Set(impacts.flatMap((impact) => impact.lockedOrMissingPaths)),
  };
};
