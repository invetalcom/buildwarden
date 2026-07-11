export interface ParsedGitRemote {
  provider: "github" | "gitlab";
  webBaseUrl: string;
}

const stripGitSuffixAndTrailingSlashes = (value: string): string => {
  let normalized = value;
  if (normalized.toLowerCase().endsWith(".git")) {
    normalized = normalized.slice(0, -4);
  }
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
};

const normalizeGithubRemoteUrl = (remoteUrl: string): string | null => {
  const trimmed = remoteUrl.trim();

  if (trimmed.startsWith("https://github.com/")) {
    return trimmed.replace(/\.git$/i, "");
  }

  if (/^ssh:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname === "github.com") {
        return `https://github.com${stripGitSuffixAndTrailingSlashes(parsed.pathname)}`;
      }
    } catch {
      return null;
    }
  }

  const sshMatch = /^git@github\.com:(.+?)(?:\.git)?$/i.exec(trimmed);
  if (sshMatch?.[1]) {
    return `https://github.com/${sshMatch[1]}`;
  }

  return null;
};

/** Maps a `git remote` URL to a canonical https web base for GitHub or GitLab-style hosts. */
export function parseGitRemoteToWebBase(remoteUrl: string): ParsedGitRemote | null {
  const trimmed = remoteUrl.trim();

  if (!trimmed) {
    return null;
  }

  const githubUrl = normalizeGithubRemoteUrl(trimmed);
  if (githubUrl) {
    return {
      provider: "github",
      webBaseUrl: githubUrl,
    };
  }

  if (/^https?:\/\//i.test(trimmed) || /^ssh:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const path = stripGitSuffixAndTrailingSlashes(parsed.pathname);
      if (!path || path === "/") {
        return null;
      }

      return {
        provider: "gitlab",
        webBaseUrl: `${parsed.protocol}//${parsed.host}${path}`,
      };
    } catch {
      return null;
    }
  }

  const sshMatch = /^(?:[^@]+@)?([^:]+):(.+?)(?:\.git)?$/.exec(trimmed);
  if (!sshMatch?.[1] || !sshMatch[2]) {
    return null;
  }

  return {
    provider: "gitlab",
    webBaseUrl: `https://${sshMatch[1]}/${sshMatch[2]}`,
  };
}
