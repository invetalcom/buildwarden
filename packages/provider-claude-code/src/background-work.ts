const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Required work holds completion; ambient processes and unawaited shells do not. */
export const readClaudeBackgroundAgentTasks = (event: unknown, awaited: ReadonlySet<string> = new Set()): Set<string> | null => {
  if (!record(event) || event.type !== "system" || event.subtype !== "background_tasks_changed" || !Array.isArray(event.tasks)) return null;
  return new Set(event.tasks.filter(record).flatMap((task) =>
    typeof task.task_id === "string" && task.ambient !== true && typeof task.task_type === "string"
      && (/agent/i.test(task.task_type) || ["local_workflow", "mcp_task"].includes(task.task_type) || awaited.has(task.task_id))
      ? [task.task_id] : []));
};

/** The CLI does not expose an awaited flag. A blocking TaskOutput explicitly establishes that dependency. */
export class ClaudeBackgroundWork {
  private snapshot: unknown;
  private readonly awaited = new Set<string>();

  update(event: unknown): Set<string> | null {
    if (!record(event)) return null;
    if (event.type === "system" && event.subtype === "background_tasks_changed" && Array.isArray(event.tasks)) {
      this.snapshot = event;
      const liveIds = new Set(event.tasks.filter(record).map((task) => task.task_id));
      for (const id of this.awaited) if (!liveIds.has(id)) this.awaited.delete(id);
      return readClaudeBackgroundAgentTasks(this.snapshot, this.awaited);
    }
    if (event.type !== "assistant" || event.parent_tool_use_id || !record(event.message) || !Array.isArray(event.message.content)) return null;
    let changed = false;
    for (const part of event.message.content.filter(record)) {
      if (part.type !== "tool_use" || part.name !== "TaskOutput" || !record(part.input) || typeof part.input.task_id !== "string") continue;
      // `block` controls whether this poll waits; it does not detach previously required work.
      // Release the dependency only when a live-task snapshot removes it.
      if (part.input.block === false) continue;
      this.awaited.add(part.input.task_id);
      changed = true;
    }
    return changed ? readClaudeBackgroundAgentTasks(this.snapshot, this.awaited) : null;
  }
}
