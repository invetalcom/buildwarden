import type {
  OrchestrationStatus,
  RunEventType,
  RunMode,
  RunStatus,
  RunSubagentInfo,
} from "@buildwarden/shared";

export type RunActivityStep = {
  id: string;
  eventType: RunEventType;
  title: string;
  content: string;
  metadataJson: string;
  createdAt: string;
};

export type RunActivityRun = {
  id: string;
  status: RunStatus;
  mode: RunMode;
  orchestrationStatus?: OrchestrationStatus | null;
};

export type SingleActivityEntry =
  | {
      kind: "single";
      step: RunActivityStep;
      metadata: Record<string, unknown>;
    }
  | {
      kind: "tool";
      callStep?: RunActivityStep;
      callMetadata?: Record<string, unknown>;
      resultStep?: RunActivityStep;
      resultMetadata?: Record<string, unknown>;
    };

export type ActivityGroupKey = "user" | "status" | "assistant";

export type ActivityEntry =
  | SingleActivityEntry
  | {
      kind: "tool-batch";
      items: Extract<SingleActivityEntry, { kind: "tool" }>[];
    }
  | {
      kind: "diff-batch";
      items: Extract<SingleActivityEntry, { kind: "single" }>[];
    }
  | {
      kind: "single-group";
      groupKey: ActivityGroupKey;
      items: Extract<SingleActivityEntry, { kind: "single" }>[];
    }
  | {
      kind: "subagent";
      step: RunActivityStep;
      info: RunSubagentInfo;
      entries: ActivityEntry[];
    };

export type TimelineRenderItem =
  | { kind: "entry"; key: string; entry: ActivityEntry }
  | { kind: "plan-decision"; key: string; planText: string }
  | { kind: "loading"; key: string }
  | { kind: "end"; key: string };

export type SubagentActivityEntry = Extract<ActivityEntry, { kind: "subagent" }>;
