import simpleGit, { type SimpleGit } from "simple-git";
import { parseGitRemoteToWebBase } from "./remote-parse.js";

export interface ParsedPrMrLink {
  provider: "github" | "gitlab";
  number: number;
  /** Canonical web base for the repo (no trailing slash), for matching `origin`. */
  expectedWebBase: string;
}

export interface ComputePrMrDiffResult {
  diff: string;
  provider: "github" | "gitlab";
  number: number;
  /** Remote-tracking ref used as the merge base (e.g. `origin/main`). */
  baseRef: string;
  /** Local ref created for the PR/MR head (`refs/buildwarden/...`). */
  headRef: string;
}

const normalizeWebBaseForCompare = (value: string) => value.trim().replace(/\/$/, "").toLowerCase();

/** Parses a GitHub PR or GitLab MR URL from the browser. */
export function parsePrMrBrowserUrl(urlString: string): ParsedPrMrLink | null {
  const trimmed = urlString.trim();
  if (!trimmed) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  const path = url.pathname.replace(/\/$/, "") || url.pathname;

  const githubPull = path.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
  if (githubPull?.[1] && githubPull[2] && githubPull[3]) {
    const number = Number.parseInt(githubPull[3], 10);
    if (!Number.isFinite(number) || number < 1) {
      return null;
    }
    const expectedWebBase = `${url.origin}/${githubPull[1]}/${githubPull[2]}`.replace(/\/$/, "");
    return {
      provider: "github",
      number,
      expectedWebBase,
    };
  }

  const mrMarker = "/-/merge_requests/";
  const mrIdx = path.indexOf(mrMarker);
  if (mrIdx !== -1) {
    const rest = path.slice(mrIdx + mrMarker.length);
    const numMatch = rest.match(/^(\d+)/);
    if (!numMatch?.[1]) {
      return null;
    }
    const number = Number.parseInt(numMatch[1], 10);
    if (!Number.isFinite(number) || number < 1) {
      return null;
    }
    const projectPath = path.slice(0, mrIdx);
    if (!projectPath || projectPath === "/") {
      return null;
    }
    const expectedWebBase = `${url.origin}${projectPath}`.replace(/\/$/, "");
    return {
      provider: "gitlab",
      number,
      expectedWebBase,
    };
  }

  return null;
}

async function resolveOriginRemoteUrl(git: SimpleGit): Promise<string> {
  const out = await git.remote(["get-url", "origin"]);
  const url = String(out ?? "").trim();
  if (!url) {
    throw new Error('This repository has no "origin" remote. Add one that points to GitHub or GitLab.');
  }
  return url;
}

async function resolveDefaultBaseRef(git: SimpleGit): Promise<string> {
  try {
    const sym = await git.raw(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
    const line = sym.trim();
    const m = line.match(/^refs\/remotes\/(origin\/.+)$/);
    if (m?.[1]) {
      return m[1];
    }
  } catch {
    /* fall through */
  }

  for (const name of ["main", "master", "develop"]) {
    try {
      await git.revparse([`origin/${name}`]);
      return `origin/${name}`;
    } catch {
      /* try next */
    }
  }

  throw new Error(
    'Could not infer a base branch (expected refs/remotes/origin/HEAD or origin/main). Enter the target branch name explicitly (e.g. "main").',
  );
}

async function resolveBaseRef(git: SimpleGit, baseBranch?: string): Promise<string> {
  const trimmed = baseBranch?.trim();
  if (trimmed) {
    const withoutOrigin = trimmed.replace(/^origin\//, "");
    const candidate = `origin/${withoutOrigin}`;
    try {
      await git.revparse([candidate]);
      return candidate;
    } catch {
      throw new Error(`Base branch ref not found: ${candidate}. Fetch remotes or check the branch name.`);
    }
  }
  return resolveDefaultBaseRef(git);
}

/**
 * Fetches PR/MR head from `origin` and returns the unified diff from the merge base with the base ref to that head.
 * Does not use hosting HTTP APIs — only `git fetch` and `git diff`.
 */
export async function computePrMrDiffViaFetch(
  repoPath: string,
  options: { prMrUrl: string; baseBranch?: string },
): Promise<ComputePrMrDiffResult> {
  const parsed = parsePrMrBrowserUrl(options.prMrUrl);
  if (!parsed) {
    throw new Error("Could not parse a GitHub pull request or GitLab merge request URL.");
  }

  const git = simpleGit(repoPath);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error("Project path is not a git repository.");
  }

  const originUrl = await resolveOriginRemoteUrl(git);
  const originRemote = parseGitRemoteToWebBase(originUrl);
  if (!originRemote) {
    throw new Error('Could not interpret "origin" as a GitHub or GitLab remote URL.');
  }

  if (originRemote.provider !== parsed.provider) {
    throw new Error(`The PR/MR link is for ${parsed.provider}, but "origin" looks like ${originRemote.provider}.`);
  }

  if (normalizeWebBaseForCompare(originRemote.webBaseUrl) !== normalizeWebBaseForCompare(parsed.expectedWebBase)) {
    throw new Error(
      "The PR/MR URL does not match this project’s origin repository. Open the project that owns that URL, or fix origin.",
    );
  }

  const headRef = `refs/buildwarden/pr-mr-${parsed.provider}-${parsed.number}`;
  let baseRef = "";

  try {
    await git.fetch("origin");

    if (parsed.provider === "github") {
      await git.raw(["fetch", "origin", `pull/${parsed.number}/head:${headRef}`]);
    } else {
      await git.raw(["fetch", "origin", `merge-requests/${parsed.number}/head:${headRef}`]);
    }

    baseRef = await resolveBaseRef(git, options.baseBranch);
    const mergeBase = (await git.raw(["merge-base", baseRef, headRef])).trim();
    if (!mergeBase) {
      throw new Error("git merge-base returned empty output.");
    }

    const diff = (await git.diff([mergeBase, headRef])).trim();

    return {
      diff,
      provider: parsed.provider,
      number: parsed.number,
      baseRef,
      headRef,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/could not resolve host|unable to access|Authentication failed|Permission denied|403|401/i.test(message)) {
      throw new Error(
        `Network or authentication failed while fetching. Ensure credentials for "origin" allow git fetch. ${message}`,
      );
    }
    if (/couldn't find remote ref|could not find remote ref|fatal: couldn't find remote ref/i.test(message)) {
      throw new Error(
        parsed.provider === "gitlab"
          ? `Could not fetch merge-requests/${parsed.number}/head from origin. On GitLab, ensure merge request refs are advertised, or verify the MR number and permissions. Raw: ${message}`
          : `Could not fetch pull/${parsed.number}/head from origin. Verify the PR number and that you can fetch from origin. Raw: ${message}`,
      );
    }
    throw error instanceof Error ? error : new Error(message);
  } finally {
    try {
      await git.raw(["update-ref", "-d", headRef]);
    } catch {
      /* ref may not exist */
    }
  }
}
