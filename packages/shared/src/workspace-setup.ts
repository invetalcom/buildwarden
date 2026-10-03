export interface WorkspaceSetupProfile {
  id: string;
  name: string;
  dependencies: "isolated" | "shared";
  submodules: "none" | "top-level" | "recursive";
  environmentFiles: string[];
  commands: string[];
  previewCommand: string;
  previewUrl: string;
}

export interface ProjectWorkspaceSetup {
  activeProfileId: string;
  profiles: WorkspaceSetupProfile[];
}

export interface RunWorkspaceSetup {
  profile: WorkspaceSetupProfile;
  status: "pending" | "running" | "completed" | "failed";
}

export const parseWorkspaceSetupSettings = (raw: string | undefined): Record<string, ProjectWorkspaceSetup> => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, ProjectWorkspaceSetup> = {};
    for (const [projectId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      if (!Array.isArray(item.profiles)) continue;
      const profiles: WorkspaceSetupProfile[] = [];
      const strings = (input: unknown) => Array.isArray(input)
        ? input.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean).slice(0, 20).map((entry) => entry.slice(0, 2000)) : [];
      for (const candidate of item.profiles.slice(0, 10)) {
        if (!candidate || typeof candidate !== "object") continue;
        const p = candidate as Record<string, unknown>;
        if (typeof p.id !== "string" || !p.id || profiles.some((entry) => entry.id === p.id)) continue;
        profiles.push({ id: p.id.slice(0, 80), name: typeof p.name === "string" ? p.name.slice(0, 80) : "Setup",
          dependencies: p.dependencies === "shared" ? "shared" : "isolated",
          submodules: p.submodules === "recursive" || p.submodules === "top-level" ? p.submodules : "none",
          environmentFiles: strings(p.environmentFiles), commands: strings(p.commands),
          previewCommand: typeof p.previewCommand === "string" ? p.previewCommand.trim().slice(0, 2000) : "",
          previewUrl: typeof p.previewUrl === "string" && /^https?:\/\//i.test(p.previewUrl) ? p.previewUrl.slice(0, 2000) : "",
        });
      }
      result[projectId] = { activeProfileId: typeof item.activeProfileId === "string" && profiles.some((p) => p.id === item.activeProfileId) ? item.activeProfileId : "", profiles };
    }
    return result;
  } catch { return {}; }
};
