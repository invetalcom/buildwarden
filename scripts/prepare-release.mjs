import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

const usage = "Usage: pnpm release:prepare 1.0.0";
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const skippedPackageSearchDirs = new Set([".git", ".vite", "dist", "dist-release", "node_modules", "out", "release"]);

if (version === "--help" || version === "-h") {
  console.log(usage);
  process.exit(0);
}

if (!semverPattern.test(version ?? "")) {
  console.error(usage);
  process.exit(1);
}

const formatReleaseDate = (date) => date.toISOString().slice(0, 10);

const git = (args) =>
  execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const runGit = (args) =>
  execFileSync("git", args, {
    cwd: rootDir,
    stdio: "inherit",
  });

const collectPackageFiles = async (absoluteDir, relativeDir, paths) => {
  const packagePath = join(relativeDir, "package.json");

  if (existsSync(join(rootDir, packagePath))) {
    paths.push(packagePath);
  }

  const entries = await readdir(absoluteDir, { withFileTypes: true });

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || skippedPackageSearchDirs.has(entry.name)) {
      continue;
    }

    const childRelativeDir = join(relativeDir, entry.name);

    await collectPackageFiles(join(rootDir, childRelativeDir), childRelativeDir, paths);
  }
};

const listWorkspacePackageFiles = async () => {
  const paths = ["package.json"];

  for (const workspaceDir of ["apps", "packages"]) {
    const absoluteWorkspaceDir = join(rootDir, workspaceDir);

    if (!existsSync(absoluteWorkspaceDir)) {
      continue;
    }

    await collectPackageFiles(absoluteWorkspaceDir, workspaceDir, paths);
  }

  return paths;
};

const packagePaths = await listWorkspacePackageFiles();
const dirtyPackageFiles = git(["status", "--porcelain", "--", ...packagePaths]).trim();

if (dirtyPackageFiles) {
  console.error("Release package files already have uncommitted changes. Commit or stash them first:");
  console.error(dirtyPackageFiles);
  process.exit(1);
}

const releaseDate = formatReleaseDate(new Date());

for (const packagePath of packagePaths) {
  const absolutePath = join(rootDir, packagePath);
  const packageJson = JSON.parse(await readFile(absolutePath, "utf8"));

  packageJson.version = version;

  if (packagePath === join("apps", "desktop", "package.json")) {
    packageJson.releaseDate = releaseDate;
  }

  await writeFile(absolutePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

runGit(["add", "--", ...packagePaths]);

const stagedFiles = git(["diff", "--cached", "--name-only", "--", ...packagePaths]).trim();

if (!stagedFiles) {
  console.log(`Release metadata is already up to date for v${version}. No commit created.`);
  process.exit(0);
}

runGit(["commit", "-m", `chore(release): v${version}`, "--", ...packagePaths]);

console.log(`Prepared release commit for v${version} with releaseDate ${releaseDate}.`);
