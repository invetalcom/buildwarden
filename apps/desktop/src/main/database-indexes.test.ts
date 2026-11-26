import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BuildWardenDatabase } from "@buildwarden/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let directory: string;
let database: BuildWardenDatabase;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "buildwarden-indexes-"));
  database = new BuildWardenDatabase(join(directory, "state.sqlite"));
  await database.init();
});

afterAll(async () => {
  await database.close();
  await rm(directory, { recursive: true, force: true });
});

const planOf = (sql: string): string =>
  ((database as unknown as { db: DatabaseSync }).db.prepare(`explain query plan ${sql}`).all() as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join(" | ");

describe("database indexes", () => {
  it.each([
    ["a run's chats", "select id from chats where run_id = 'x' order by created_at desc", "idx_chats_run_created_at"],
    ["a project's tasks", "select id from project_tasks where project_id = 'x' order by updated_at desc, created_at desc", "idx_project_tasks_project_updated"],
    ["an orchestration's messages", "select id from orchestration_task_messages where orchestration_id = 'x' order by created_at asc, rowid asc", "idx_orchestration_messages_orchestration"],
  ])("finds %s through an index", (_label, sql, index) => {
    const plan = planOf(sql);
    expect(plan).toContain(index);
    expect(plan).not.toMatch(/\bSCAN\b/);
  });
});
