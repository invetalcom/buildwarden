import type { ChatAttachmentPayload } from "@buildwarden/shared";

export interface RunBatchProgress {
  acceptedModelIds: readonly string[];
  recordAccepted: (modelId: string) => void;
}

export interface RunComposerSubmission {
  prompt: string;
  attachments?: ChatAttachmentPayload[];
  batch: RunBatchProgress;
}

/** Record each acknowledged run before starting the next model, so partial retries skip it. */
export async function startRunBatch(
  modelIds: string[],
  createRun: (modelId: string) => Promise<string | null>,
  progress?: RunBatchProgress,
): Promise<string | null> {
  const accepted = new Set(progress?.acceptedModelIds);
  let lastRunId: string | null = null;
  for (const modelId of new Set(modelIds)) {
    if (accepted.has(modelId)) continue;
    try {
      const runId = await createRun(modelId);
      if (!runId) throw new Error("The selected model or provider is no longer available.");
      accepted.add(modelId);
      progress?.recordAccepted(modelId);
      lastRunId = runId;
    } catch (error) {
      if (!progress || accepted.size === 0) throw error;
      throw new Error(`Some runs already started. Retry will start only the remaining models. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return lastRunId;
}
