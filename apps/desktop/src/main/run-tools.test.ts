import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildInitialRepoContext } from "./initial-repo-context";
import { createRunToolContext } from "./run-tools";
import { compileShellAllowlistRegExes } from "./shell-allowlist";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

const makeTempDir = async () => {
  const path = await mkdtemp(join(tmpdir(), "buildwarden-run-tools-"));
  tempDirs.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("run tool context", () => {
  it("can write, read, list, search, and delete files inside the worktree", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath);

    const writeResult = await tools.executeTool({
      id: "write-1",
      name: "write_file",
      arguments: {
        path: "src/example.ts",
        content: 'export const example = "hello";\n',
      },
    });
    expect(writeResult.ok).toBe(true);

    const readResult = await tools.executeTool({
      id: "read-1",
      name: "read_file",
      arguments: { path: "src/example.ts" },
    });
    expect(readResult.ok).toBe(true);
    expect(readResult.content).toContain('export const example = "hello";');

    const listResult = await tools.executeTool({
      id: "list-1",
      name: "list_files",
      arguments: { path: "." },
    });
    expect(listResult.content).toContain("src");
    expect(listResult.content).toContain("src/example.ts");

    const searchResult = await tools.executeTool({
      id: "search-1",
      name: "search_repo",
      arguments: { query: "example" },
    });
    expect(searchResult.ok).toBe(true);
    expect(searchResult.content).toContain("src/example.ts");

    const deleteResult = await tools.executeTool({
      id: "delete-1",
      name: "delete_file",
      arguments: { path: "src/example.ts" },
    });
    expect(deleteResult.ok).toBe(true);
    await expect(readFile(join(worktreePath, "src/example.ts"), "utf8")).rejects.toThrow();
  });

  it("includes writeFileUnifiedDiff in metadata for new and updated files", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath);

    const created = await tools.executeTool({
      id: "w-new",
      name: "write_file",
      arguments: { path: "a.txt", content: "one\n" },
    });
    expect(created.ok).toBe(true);
    const metaNew = created.metadata as { writeFileUnifiedDiff?: string };
    expect(metaNew.writeFileUnifiedDiff).toContain("diff --git");
    expect(metaNew.writeFileUnifiedDiff).toContain("new file mode");
    expect(metaNew.writeFileUnifiedDiff).toContain("+one");

    await tools.executeTool({
      id: "r-upd",
      name: "read_file",
      arguments: { path: "a.txt" },
    });

    const updated = await tools.executeTool({
      id: "w-upd",
      name: "write_file",
      arguments: { path: "a.txt", content: "two\nthree\n" },
    });
    expect(updated.ok).toBe(true);
    const metaUpd = updated.metadata as { writeFileUnifiedDiff?: string };
    expect(metaUpd.writeFileUnifiedDiff).toContain("-one");
    expect(metaUpd.writeFileUnifiedDiff).toContain("+two");
    expect(metaUpd.writeFileUnifiedDiff).toContain("+three");
  });

  it("can read a focused 1-based line range from a file", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath);
    await writeFile(join(worktreePath, "src.txt"), "one\ntwo\nthree\nfour\nfive\n", "utf8");

    const result = await tools.executeTool({
      id: "read-range",
      name: "read_file",
      arguments: { path: "src.txt", startLine: 2, endLine: 4 },
    });

    expect(result.ok).toBe(true);
    expect(result.content).toBe("2|two\n3|three\n4|four");
    expect(result.metadata).toMatchObject({
      path: "src.txt",
      lineStart: 2,
      lineEnd: 4,
      totalLines: 6,
      truncated: false,
    });
  });

  it("rejects invalid read_file line ranges", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath);
    await writeFile(join(worktreePath, "src.txt"), "one\ntwo\n", "utf8");

    const result = await tools.executeTool({
      id: "read-range-invalid",
      name: "read_file",
      arguments: { path: "src.txt", startLine: 4, endLine: 2 },
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("endLine must be greater than or equal to startLine");
  });

  it("refuses to overwrite an existing file before it has been read in the run", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath);
    const targetPath = join(worktreePath, "guarded.txt");
    await writeFile(targetPath, "original file contents\n", "utf8");

    const result = await tools.executeTool({
      id: "w-guard-read-first",
      name: "write_file",
      arguments: { path: "guarded.txt", content: "replacement\n" },
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("Use read_file first");
    await expect(readFile(targetPath, "utf8")).resolves.toBe("original file contents\n");
  });

  it("refuses empty or placeholder overwrites for existing files", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath);
    const targetPath = join(worktreePath, "guarded.txt");
    await writeFile(targetPath, "original file contents\n", "utf8");

    await tools.executeTool({
      id: "read-guarded",
      name: "read_file",
      arguments: { path: "guarded.txt" },
    });

    const emptyResult = await tools.executeTool({
      id: "w-empty",
      name: "write_file",
      arguments: { path: "guarded.txt", content: "   \n" },
    });
    expect(emptyResult.ok).toBe(false);
    expect(emptyResult.content).toContain("empty content");
    await expect(readFile(targetPath, "utf8")).resolves.toBe("original file contents\n");

    const placeholderResult = await tools.executeTool({
      id: "w-placeholder",
      name: "write_file",
      arguments: { path: "guarded.txt", content: "<updated>" },
    });
    expect(placeholderResult.ok).toBe(false);
    expect(placeholderResult.content).toContain("placeholder content");
    await expect(readFile(targetPath, "utf8")).resolves.toBe("original file contents\n");
  });

  it("refuses suspiciously tiny overwrites and preserves the previous file", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath);
    const targetPath = join(worktreePath, "big.ts");
    const originalContent = `${"export const value = 1;\n".repeat(20)}export const done = true;\n`;
    await writeFile(targetPath, originalContent, "utf8");

    await tools.executeTool({
      id: "read-big",
      name: "read_file",
      arguments: { path: "big.ts" },
    });

    const result = await tools.executeTool({
      id: "w-tiny",
      name: "write_file",
      arguments: { path: "big.ts", content: "export {};\n" },
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("suspiciously small");
    await expect(readFile(targetPath, "utf8")).resolves.toBe(originalContent);
  });

  it("exposes edit_file in code mode by default", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath);

    const result = await tools.executeTool({
      id: "edit-default",
      name: "edit_file",
      arguments: {
        file_path: "note.txt",
        old_string: "",
        new_string: "hello\n",
        expected_replacements: 1,
      },
    });

    expect(result.ok).toBe(true);
    await expect(readFile(join(worktreePath, "note.txt"), "utf8")).resolves.toBe("hello\n");
  });

  it("can create and edit files via edit_file when explicitly enabled", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(
      worktreePath,
      "code",
      undefined,
      undefined,
      undefined,
      ["read_file", "write_file", "edit_file", "delete_file", "list_files", "search_repo", "run_shell"],
    );

    const created = await tools.executeTool({
      id: "edit-create",
      name: "edit_file",
      arguments: {
        file_path: "src/example.ts",
        old_string: "",
        new_string: "export const value = 1;\n",
        expected_replacements: 1,
      },
    });
    expect(created.ok).toBe(true);
    await expect(readFile(join(worktreePath, "src/example.ts"), "utf8")).resolves.toBe("export const value = 1;\n");

    await tools.executeTool({
      id: "edit-read",
      name: "read_file",
      arguments: { path: "src/example.ts" },
    });

    const updated = await tools.executeTool({
      id: "edit-update",
      name: "edit_file",
      arguments: {
        file_path: "src/example.ts",
        old_string: "export const value = 1;\n",
        new_string: "export const value = 2;\n",
        expected_replacements: 1,
      },
    });
    expect(updated.ok).toBe(true);
    expect(updated.content).toContain("Updated 1 occurrence");
    const diff = (updated.metadata as { writeFileUnifiedDiff?: string }).writeFileUnifiedDiff ?? "";
    expect(diff).toContain("-export const value = 1;");
    expect(diff).toContain("+export const value = 2;");
    await expect(readFile(join(worktreePath, "src/example.ts"), "utf8")).resolves.toBe("export const value = 2;\n");
  });

  it("writeFileUnifiedDiff uses real line diff (no duplicate +/- for identical lines)", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath);
    const unchangedBlock = ['"jasmine-core": "~5.2.0",', '"karma": "~6.4.2",', '"karma-chrome-launcher": "~3.2.0",'].join("\n");
    await tools.executeTool({
      id: "w1",
      name: "write_file",
      arguments: {
        path: "package.json",
        content: `${unchangedBlock}\n"karma-coverage": "~2.2.2",\n"karma-jasmine": "~5.1.0",\n`,
      },
    });
    await tools.executeTool({
      id: "r1",
      name: "read_file",
      arguments: { path: "package.json" },
    });
    const updated = await tools.executeTool({
      id: "w2",
      name: "write_file",
      arguments: {
        path: "package.json",
        content: `${unchangedBlock}\n"karma-coverage": "~2.2.1",\n"karma-jasmine": "~5.1.0",\n`,
      },
    });
    expect(updated.ok).toBe(true);
    const diff = (updated.metadata as { writeFileUnifiedDiff?: string }).writeFileUnifiedDiff ?? "";
    expect(diff).toContain(`-"karma-coverage": "~2.2.2",`);
    expect(diff).toContain(`+"karma-coverage": "~2.2.1",`);
    // Unchanged dependency lines must not appear as both removed and re-added
    expect(diff).not.toMatch(/\n-"jasmine-core"/);
    expect(diff).not.toMatch(/\n\+"jasmine-core"/);
    expect(diff).toMatch(/\n "jasmine-core"/);
  });

  it("writeFileUnifiedDiff normalizes CRLF on disk vs LF from model (no fake churn)", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath);
    const p = join(worktreePath, "pkg.json");
    await writeFile(
      p,
      ['"a": "1",', '"b": "2",', '"c": "old",'].join("\r\n") + "\r\n",
      "utf8",
    );
    await tools.executeTool({
      id: "r-crlf",
      name: "read_file",
      arguments: { path: "pkg.json" },
    });
    const updated = await tools.executeTool({
      id: "w-crlf",
      name: "write_file",
      arguments: {
        path: "pkg.json",
        content: ['"a": "1",', '"b": "2",', '"c": "new",'].join("\n") + "\n",
      },
    });
    expect(updated.ok).toBe(true);
    const diff = (updated.metadata as { writeFileUnifiedDiff?: string }).writeFileUnifiedDiff ?? "";
    expect(diff).toContain(`-"c": "old",`);
    expect(diff).toContain(`+"c": "new",`);
    expect(diff).not.toMatch(/\n-"a":/);
    expect(diff).not.toMatch(/\n\+"a":/);
    expect(diff).toMatch(/\n "a":/);
  });

  it("builds initial repo context from common project files (code mode — recursive listing)", async () => {
    const worktreePath = await makeTempDir();
    await writeFile(join(worktreePath, "README.md"), "# Example\n", "utf8");
    await writeFile(join(worktreePath, "package.json"), '{ "name": "example" }\n', "utf8");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "index.ts"), "export {};\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: worktreePath });

    const context = await buildInitialRepoContext(worktreePath, "code");
    expect(context).toContain("README.md");
    expect(context).toContain("package.json");
    expect(context).toContain("src/index.ts");
    expect(context).toContain("Git (branch + short status):");
  });

  it("uses lighter initial context in plan mode (top-level only, fewer key files)", async () => {
    const worktreePath = await makeTempDir();
    await writeFile(join(worktreePath, "README.md"), "# Plan mode\n", "utf8");
    await writeFile(join(worktreePath, "package.json"), '{ "name": "plan" }\n', "utf8");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "deep.ts"), "export const x = 1;\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: worktreePath });

    const planCtx = await buildInitialRepoContext(worktreePath, "plan");
    const codeCtx = await buildInitialRepoContext(worktreePath, "code");

    expect(planCtx).toContain("Top-level files and folders");
    expect(planCtx).toContain("src/");
    expect(planCtx).not.toContain("src/deep.ts");
    expect(codeCtx).toContain("src/deep.ts");
    expect(planCtx.length).toBeLessThan(codeCtx.length);
  });

  it("blocks write tools in plan mode", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath, "plan");

    const writeResult = await tools.executeTool({
      id: "write-plan-1",
      name: "write_file",
      arguments: {
        path: "src/example.ts",
        content: 'export const example = "hello";\n',
      },
    });

    expect(writeResult.ok).toBe(false);
    expect(writeResult.content).toContain("not available in plan mode");
  });

  it("allows every tool in plan mode when YOLO mode is enabled", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath, "plan", undefined, undefined, undefined, undefined, {
      yoloMode: true,
    });

    const writeResult = await tools.executeTool({
      id: "write-yolo-plan-1",
      name: "write_file",
      arguments: {
        path: "src/example.ts",
        content: 'export const example = "hello";\n',
      },
    });

    expect(writeResult.ok).toBe(true);
    expect(writeResult.content).toContain("Wrote");
  });

  it("allows common safe shell inspection commands", async () => {
    const worktreePath = await makeTempDir();
    await writeFile(join(worktreePath, "README.md"), "# Example\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: worktreePath });
    const tools = createRunToolContext(worktreePath);

    const commands = ["pwd", "ls", "git status -sb", "git branch --show-current", "git diff HEAD", "rg Example README.md"];

    for (const command of commands) {
      const result = await tools.executeTool({
        id: `shell-${command}`,
        name: "run_shell",
        arguments: { command },
      });

      expect((result.metadata as { command?: string }).command).toBe(command);
      expect(result.content).not.toContain("Command is not allowed");
    }
  });

  it("allows default shell commands for gradle validation, text search/read, path listing, and npm run", async () => {
    const worktreePath = await makeTempDir();
    await mkdir(join(worktreePath, "build", "reports", "tests", "test", "classes"), { recursive: true });
    await writeFile(join(worktreePath, "README.md"), "# Example\nsecond line\n", "utf8");
    await writeFile(join(worktreePath, "package.json"), '{"scripts":{"check":"echo ok"}}\n', "utf8");
    const tools = createRunToolContext(worktreePath);

    const commands = [
      process.platform === "win32" ? ".\\gradlew.bat test --tests ExampleTest" : "./gradlew test --tests ExampleTest",
      process.platform === "win32" ? ".\\gradlew build" : "./gradlew build",
      process.platform === "win32" ? ".\\gradlew check" : "./gradlew check",
      "Select-String Example README.md",
      "ls build/reports/tests/test/classes",
      "cat README.md",
      "Get-Content README.md",
      "npm run check -- --watch=false",
    ];

    for (const command of commands) {
      const result = await tools.executeTool({
        id: `shell-default-${command}`,
        name: "run_shell",
        arguments: { command },
      });

      expect((result.metadata as { command?: string }).command).toBe(command);
      expect(result.content).not.toContain("Command is not allowed");
    }
  });

  it("allows common pnpm, bun, eslint, and Maven commands by default", async () => {
    const allowedCommands = compileShellAllowlistRegExes(undefined);

    const commands = [
      "pnpm install",
      "pnpm i --frozen-lockfile",
      "pnpm ci",
      "pnpm add react",
      "pnpm remove lodash",
      "pnpm audit",
      "pnpm why react",
      "pnpm build",
      "pnpm run dev -- --host 127.0.0.1",
      "pnpm run lint -- --max-warnings 0",
      "pnpm exec eslint . --fix",
      "pnpm dlx eslint . --cache",
      "bun install",
      "bun ci",
      "bun add react",
      "bun remove lodash",
      "bun pm ls",
      "bun test --timeout 10000",
      "bun run build",
      "bun run lint",
      "bun run dev",
      "bunx eslint . --max-warnings 0",
      "eslint . --fix --cache",
      "mvn clean test",
      "mvn -q -DskipTests package",
      "mvn verify",
      "mvn dependency:tree",
      "mvn checkstyle:check",
      "mvn spotbugs:check",
      process.platform === "win32" ? ".\\mvnw.cmd test" : "./mvnw test",
    ];

    for (const command of commands) {
      expect(allowedCommands.some((pattern) => pattern.test(command))).toBe(true);
    }
  });

  it("does not allow Maven deploy commands by default", async () => {
    const allowedCommands = compileShellAllowlistRegExes(undefined);

    expect(allowedCommands.some((pattern) => pattern.test("mvn deploy"))).toBe(false);
    expect(allowedCommands.some((pattern) => pattern.test("mvn clean deploy site-deploy"))).toBe(false);
  });

  it("allows regex alternation inside quoted or escaped shell arguments", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath, "code", undefined, ["^echo .*$"]);

    const commands = [
      'echo "TODO|FIXME"',
      'echo "TODO\\|FIXME"',
    ];

    for (const command of commands) {
      const result = await tools.executeTool({
        id: `shell-regex-${command}`,
        name: "run_shell",
        arguments: { command },
      });

      expect(result.ok).toBe(true);
      expect(result.content).toContain("TODO");
      expect(result.content).not.toContain("Shell command contains disallowed operators.");
    }
  });

  it("still blocks unsafe shell commands", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath);

    const result = await tools.executeTool({
      id: "shell-blocked",
      name: "run_shell",
      arguments: { command: "git checkout main" },
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("Command is not allowed");
  });

  it("still blocks real shell composition operators outside quoted arguments", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath, "code", undefined, [".*"]);

    const commands = [
      "grep -R TODO -n . || true",
      "cat README.md | grep TODO",
      "echo hi > out.txt",
      "echo $(pwd)",
    ];

    for (const command of commands) {
      const result = await tools.executeTool({
        id: `shell-composed-${command}`,
        name: "run_shell",
        arguments: { command },
      });

      expect(result.ok).toBe(false);
      expect(result.content).toContain("Shell command contains disallowed operators.");
    }
  });

  it("bypasses shell allowlist, approval, and composition checks when YOLO mode is enabled", async () => {
    const worktreePath = await makeTempDir();
    let approvalRequests = 0;
    const tools = createRunToolContext(
      worktreePath,
      "code",
      async () => {
        approvalRequests += 1;
        return "deny";
      },
      undefined,
      undefined,
      undefined,
      { yoloMode: true },
    );

    const result = await tools.executeTool({
      id: "shell-yolo",
      name: "run_shell",
      arguments: { command: "echo yolo; echo mode" },
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("yolo");
    expect(result.content).toContain("mode");
    expect(approvalRequests).toBe(0);
  });

  it("explains how to fix shell commands with disallowed operators", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath);

    const result = await tools.executeTool({
      id: "shell-disallowed-operators",
      name: "run_shell",
      arguments: { command: "cd repo && ./gradlew test -q" },
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("Shell command contains disallowed operators.");
    expect(result.content).toContain("do not use cd");
    expect(result.content).toContain("BuildWarden already runs run_shell from the workspace root");
  });

  it("returns a friendly missing-directory error for list_files", async () => {
    const worktreePath = await makeTempDir();
    await mkdir(join(worktreePath, "src", "main", "resources", "db"), { recursive: true });
    await writeFile(join(worktreePath, "src", "main", "resources", "db", "README.md"), "# db\n", "utf8");
    const tools = createRunToolContext(worktreePath);

    const result = await tools.executeTool({
      id: "list-missing-dir",
      name: "list_files",
      arguments: { path: "src/main/resources/db/changelog" },
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("Directory not found in the run workspace");
    expect(result.content).toContain("Paths must be relative to the workspace root");
    expect(result.content).toContain("call list_files on . or a confirmed parent directory before retrying");
    expect(result.content).toContain("Nearest existing parent: src/main/resources/db");
    expect(result.content).toContain("src/main/resources/db/README.md");
  });

  it("allows shell commands that match user-configured extra allowlist patterns", async () => {
    const worktreePath = await makeTempDir();
    await execFileAsync("git", ["init"], { cwd: worktreePath });
    const extra = ["^git rev-parse --is-inside-work-tree$"];
    const tools = createRunToolContext(worktreePath, "code", undefined, extra);

    const result = await tools.executeTool({
      id: "shell-extra",
      name: "run_shell",
      arguments: { command: "git rev-parse --is-inside-work-tree" },
    });

    expect(result.ok).toBe(true);
    expect(result.content).not.toContain("Command is not allowed");
  });

  it("sets CI=true for agent run_shell child processes", async () => {
    const worktreePath = await makeTempDir();
    const previousCi = process.env.CI;
    delete process.env.CI;
    try {
      const command = process.platform === "win32" ? "Write-Output $env:CI" : "printf $CI";
      const tools = createRunToolContext(worktreePath, "code", undefined, [".*"]);

      const result = await tools.executeTool({
        id: "shell-ci",
        name: "run_shell",
        arguments: { command },
      });

      expect(result.ok).toBe(true);
      expect(result.content).toBe("true");
    } finally {
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }
    }
  });

  it("can request user approval for shell commands outside the default allowlist", async () => {
    const worktreePath = await makeTempDir();
    const tools = createRunToolContext(worktreePath, "code", async (command) => {
      expect(command).toBe("git checkout main");
      return "allow-once";
    });

    const result = await tools.executeTool({
      id: "shell-approved",
      name: "run_shell",
      arguments: { command: "git checkout main" },
    });

    expect(result.content).not.toContain("Command is not allowed");
    expect((result.metadata as { command?: string }).command).toBe("git checkout main");
  });

});
