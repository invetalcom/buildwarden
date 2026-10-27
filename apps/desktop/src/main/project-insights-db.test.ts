import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BuildWardenDatabase } from "@buildwarden/db";
import { PROJECT_INSIGHT_KINDS } from "@buildwarden/shared";
import { expect, it } from "vitest";

it("excludes retired graph records from reopened project snapshots while preserving supported insights", async () => {
  const directory = mkdtempSync(join(tmpdir(), "buildwarden-project-insights-"));
  const path = join(directory, "state.sqlite");
  let db = new BuildWardenDatabase(path);
  try {
    await db.init();
    const project = db.addProject({ repoPath: "C:\\repo", baseBranch: "main", resolvedName: "Repo" });
    for (const kind of PROJECT_INSIGHT_KINDS) {
      db.upsertProjectInsight({ projectId: project.id, kind, title: kind, summary: "Saved insight", dataJson: "{}" });
    }
    await db.close();

    const legacyDb = new DatabaseSync(path);
    try {
      const insert = legacyDb.prepare(`
        insert into project_insights (id, project_id, kind, title, summary, data_json, generated_at, updated_at)
        values (?, ?, ?, 'Legacy graph', 'Saved graph', '{}', '2026-10-01', '2026-10-01')
      `);
      for (const kind of ["architecture-graph", "dependency-gravity"]) {
        insert.run(kind, project.id, kind);
      }
    } finally {
      legacyDb.close();
    }

    db = new BuildWardenDatabase(path);
    await db.init();
    const expectedKinds = [...PROJECT_INSIGHT_KINDS].sort();
    expect(db.listProjectInsights(project.id).map((insight) => insight.kind).sort()).toEqual(expectedKinds);
    expect(db.getSnapshot(project.id).projects[0]?.insights.map((insight) => insight.kind).sort()).toEqual(expectedKinds);
  } finally {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
