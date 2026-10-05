import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceRevision } from "@buildwarden/shared";
import { FOLDER_WORKSPACE_IGNORED_NAMES } from "./folder-workspace-constants";

const exec = promisify(execFile);

/** Uses a private index: inspecting a revision never stages the user's changes. */
export const captureWorkspaceRevision = async (cwd: string, vcs: "git" | "folder"): Promise<WorkspaceRevision> => {
  if (vcs === "folder") {
    const hash = createHash("sha256");
    const walk = async (path: string, prefix = ""): Promise<void> => {
      const entries = (await readdir(path)).sort();
      for (const name of entries) {
        if (FOLDER_WORKSPACE_IGNORED_NAMES.has(name)) continue;
        const full = join(path, name); const relative = `${prefix}${name}`; const stat = await lstat(full);
        if (stat.isDirectory()) { await walk(full, `${relative}/`); continue; }
        const content = createHash("sha256");
        if (stat.isSymbolicLink()) content.update(await readlink(full));
        else if (stat.isFile()) for await (const chunk of createReadStream(full)) content.update(chunk);
        else throw new Error(`Cannot fingerprint special file: ${relative}`);
        hash.update(JSON.stringify([relative, stat.mode & 0o111, stat.isSymbolicLink() ? "link" : "file", content.digest("hex")]));
      }
    };
    await walk(cwd);
    return { fingerprint: `folder:${hash.digest("hex")}`, head: null };
  }
  const temporary = await mkdtemp(join(tmpdir(), "buildwarden-revision-"));
  const git = async (...args: string[]) => (await exec("git", args, {
    cwd, env: { ...process.env, GIT_INDEX_FILE: join(temporary, "index") },
    windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
  })).stdout.trim();
  try {
    const head = await git("rev-parse", "HEAD");
    const original = async (...args: string[]) => (await exec("git", args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })).stdout;
    const flagged = await original("ls-files", "-v", "-z");
    if (flagged.split("\0").some((entry) => /^[a-zS]/.test(entry))) {
      throw new Error("Verification requires a full checkout without skip-worktree or assume-unchanged files.");
    }
    const indexPath = (await original("rev-parse", "--git-path", "index")).trim();
    try { await copyFile(resolve(cwd, indexPath), join(temporary, "index")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await git("read-tree", head);
    }
    const status = await git("status", "--porcelain=v2", "--untracked-files=all", "--ignore-submodules=none");
    if (status.split("\n").some((line) => /^1 |^2 /.test(line) && /^S.(?:M.|.U)/.test(line.split(" ")[2] ?? ""))) {
      throw new Error("Commit or clean nested submodule changes before verifying this revision.");
    }
    // Include staged ignored files too. add --all replaces partial staging only in this private index.
    await git("add", "--all", "--", ".");
    return { fingerprint: `git:${await git("write-tree")}`, head };
  } finally { await rm(temporary, { recursive: true, force: true }); }
};
