import {
  ORCHESTRATION_TOOL_NAMES,
  type OrchestrationToolName,
  type RunToolDefinition,
} from "@buildwarden/shared";

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  properties,
  ...(required.length > 0 ? { required } : {}),
});

const requestId = {
  type: "string",
  minLength: 8,
  maxLength: 128,
  description: "Stable idempotency key. Reuse this exact value only when retrying the same mutation.",
};

export const ORCHESTRATION_TOOL_DEFINITIONS: RunToolDefinition[] = [
  {
    name: "buildwarden_orchestration_get",
    description: "Read the current durable orchestration, configured roles/models, limits, and wake state.",
    inputSchema: objectSchema({}),
  },
  {
    name: "buildwarden_tasks_delegate",
    description:
      "Create one wave of independent durable BuildWarden child runs. Use role descriptions to select agents. Child workspaces are isolated.",
    inputSchema: objectSchema(
      {
        requestId,
        tasks: {
          type: "array",
          minItems: 1,
          items: objectSchema(
            {
              clientTaskId: { type: "string", minLength: 1, maxLength: 80 },
              title: { type: "string", minLength: 1, maxLength: 160 },
              prompt: { type: "string", minLength: 1, maxLength: 65_536 },
              roleId: { type: "string", minLength: 1, maxLength: 80 },
              modelId: { type: "string", minLength: 1, maxLength: 160 },
              intent: { type: "string", enum: ["inspect", "implement"] },
            },
            ["clientTaskId", "title", "prompt", "roleId", "intent"],
          ),
        },
      },
      ["requestId", "tasks"],
    ),
  },
  {
    name: "buildwarden_tasks_list",
    description: "List compact durable task state for the current orchestration.",
    inputSchema: objectSchema({}),
  },
  {
    name: "buildwarden_tasks_read",
    description: "Read one durable task, including result, recent activity, token usage, and changed-file summary.",
    inputSchema: objectSchema({ taskId: { type: "string", minLength: 1 } }, ["taskId"]),
  },
  {
    name: "buildwarden_tasks_send_message",
    description: "Queue a durable follow-up message for one child run at its next safe turn boundary.",
    inputSchema: objectSchema(
      {
        requestId,
        taskId: { type: "string", minLength: 1 },
        content: { type: "string", minLength: 1, maxLength: 32_768 },
      },
      ["requestId", "taskId", "content"],
    ),
  },
  {
    name: "buildwarden_tasks_cancel",
    description: "Cancel one or more pending or running durable tasks.",
    inputSchema: objectSchema(
      {
        requestId,
        taskIds: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
      },
      ["requestId", "taskIds"],
    ),
  },
  {
    name: "buildwarden_orchestration_yield",
    description:
      "Persist when BuildWarden should resume the coordinator. After this tool succeeds, end the current response.",
    inputSchema: objectSchema(
      {
        requestId,
        mode: { type: "string", enum: ["all-terminal", "any-terminal", "attention"] },
        taskIds: { type: "array", items: { type: "string", minLength: 1 } },
      },
      ["requestId", "mode"],
    ),
  },
  {
    name: "buildwarden_adoption_propose",
    description: "Propose explicitly adopting a completed implementation task's isolated changes.",
    inputSchema: objectSchema(
      {
        requestId,
        taskId: { type: "string", minLength: 1 },
      },
      ["requestId", "taskId"],
    ),
  },
  {
    name: "buildwarden_orchestration_finish",
    description: "Finish the orchestration after every task is terminal and no adoption is applying.",
    inputSchema: objectSchema({ requestId }, ["requestId"]),
  },
];

const orchestrationToolNames = new Set<string>(ORCHESTRATION_TOOL_NAMES);

export const isOrchestrationToolName = (value: string): value is OrchestrationToolName =>
  orchestrationToolNames.has(value);
