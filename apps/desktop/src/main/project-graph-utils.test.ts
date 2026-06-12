import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDependencyGraphSnapshotForProjectGraph, listDependencySourceFilesForProjectGraph } from "./project-graph-utils";

const tempDirs: string[] = [];

const makeTempDir = async () => {
  const path = await mkdtemp(join(tmpdir(), "buildwarden-project-graph-"));
  tempDirs.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("project graph utils", () => {
  it("collects Java files and resolves package imports", async () => {
    const repoPath = await makeTempDir();
    await mkdir(join(repoPath, "src", "main", "java", "com", "example", "service"), { recursive: true });
    await writeFile(
      join(repoPath, "src", "main", "java", "com", "example", "Application.java"),
      "package com.example;\nimport com.example.service.UserService;\npublic class Application {}\n",
      "utf8",
    );
    await writeFile(
      join(repoPath, "src", "main", "java", "com", "example", "service", "UserService.java"),
      "package com.example.service;\npublic class UserService {}\n",
      "utf8",
    );

    const sourceFiles = listDependencySourceFilesForProjectGraph(repoPath);
    const snapshot = buildDependencyGraphSnapshotForProjectGraph(repoPath);

    expect(sourceFiles).toContain("src/main/java/com/example/Application.java");
    expect(sourceFiles).toContain("src/main/java/com/example/service/UserService.java");
    expect(snapshot.modules.find((module) => module.source.endsWith("Application.java"))?.dependencies).toContainEqual({
      resolved: "src/main/java/com/example/service/UserService.java",
    });
  });

  it("collects Go files and resolves local module imports", async () => {
    const repoPath = await makeTempDir();
    await mkdir(join(repoPath, "internal", "handler"), { recursive: true });
    await writeFile(join(repoPath, "go.mod"), "module example.com/demo\n\ngo 1.22\n", "utf8");
    await writeFile(
      join(repoPath, "main.go"),
      'package main\n\nimport "example.com/demo/internal/handler"\n\nfunc main() { handler.Handle() }\n',
      "utf8",
    );
    await writeFile(join(repoPath, "internal", "handler", "handler.go"), "package handler\n\nfunc Handle() {}\n", "utf8");

    const snapshot = buildDependencyGraphSnapshotForProjectGraph(repoPath);

    expect(snapshot.modules.find((module) => module.source === "main.go")?.dependencies).toContainEqual({
      resolved: "internal/handler/handler.go",
    });
  });

  it("collects Python files and resolves package imports from src layout", async () => {
    const repoPath = await makeTempDir();
    await mkdir(join(repoPath, "src", "app", "services"), { recursive: true });
    await writeFile(join(repoPath, "src", "app", "__init__.py"), "", "utf8");
    await writeFile(
      join(repoPath, "src", "app", "main.py"),
      "from app.services import worker\nworker.run()\n",
      "utf8",
    );
    await writeFile(join(repoPath, "src", "app", "services", "worker.py"), "def run():\n    return True\n", "utf8");

    const snapshot = buildDependencyGraphSnapshotForProjectGraph(repoPath);

    expect(snapshot.modules.find((module) => module.source === "src/app/main.py")?.dependencies).toContainEqual({
      resolved: "src/app/services/worker.py",
    });
  });

  it("collects Rust files and resolves module declarations and crate uses", async () => {
    const repoPath = await makeTempDir();
    await mkdir(join(repoPath, "src", "service"), { recursive: true });
    await writeFile(join(repoPath, "src", "main.rs"), "mod service;\nuse crate::service::worker;\nfn main() {}\n", "utf8");
    await writeFile(join(repoPath, "src", "service", "mod.rs"), "pub mod worker;\n", "utf8");
    await writeFile(join(repoPath, "src", "service", "worker.rs"), "pub fn run() {}\n", "utf8");

    const snapshot = buildDependencyGraphSnapshotForProjectGraph(repoPath);
    const mainModule = snapshot.modules.find((module) => module.source === "src/main.rs");

    expect(mainModule?.dependencies).toContainEqual({ resolved: "src/service/mod.rs" });
    expect(mainModule?.dependencies).toContainEqual({ resolved: "src/service/worker.rs" });
  });
});
