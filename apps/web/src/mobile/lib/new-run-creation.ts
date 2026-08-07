export interface NewRunCreationResult<Model, Run> {
  runs: Run[];
  failures: Array<{ model: Model; error: unknown }>;
}

export const createNewRunsIndependently = async <Model, Run>(
  models: readonly Model[],
  createRun: (model: Model) => Promise<Run>,
): Promise<NewRunCreationResult<Model, Run>> => {
  const runs: Run[] = [];
  const failures: Array<{ model: Model; error: unknown }> = [];
  for (const model of models) {
    try {
      runs.push(await createRun(model));
    } catch (error) {
      failures.push({ model, error });
    }
  }
  return { runs, failures };
};
