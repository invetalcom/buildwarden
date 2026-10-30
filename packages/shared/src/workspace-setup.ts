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

const isSettingsRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseSetupStrings = (input: unknown): string[] => {
  if (!Array.isArray(input)) return [];
  return input.filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim()).filter(Boolean).slice(0, 20).map((entry) => entry.slice(0, 2000));
};

const parseSetupProfile = (value: unknown): WorkspaceSetupProfile | null => {
  if (!isSettingsRecord(value) || typeof value.id !== "string" || !value.id) return null;
  return {
    id: value.id.slice(0, 80),
    name: typeof value.name === "string" ? value.name.slice(0, 80) : "Setup",
    dependencies: value.dependencies === "shared" ? "shared" : "isolated",
    submodules: value.submodules === "recursive" || value.submodules === "top-level" ? value.submodules : "none",
    environmentFiles: parseSetupStrings(value.environmentFiles),
    commands: parseSetupStrings(value.commands),
    previewCommand: typeof value.previewCommand === "string" ? value.previewCommand.trim().slice(0, 2000) : "",
    previewUrl: typeof value.previewUrl === "string" && /^https?:\/\//i.test(value.previewUrl) ? value.previewUrl.slice(0, 2000) : "",
  };
};

const parseProjectSetup = (value: unknown): ProjectWorkspaceSetup | null => {
  if (!isSettingsRecord(value) || !Array.isArray(value.profiles)) return null;
  const profiles: WorkspaceSetupProfile[] = [];
  for (const candidate of value.profiles.slice(0, 10)) {
    const profile = parseSetupProfile(candidate);
    if (profile && !profiles.some((entry) => entry.id === profile.id)) profiles.push(profile);
  }
  const activeProfileId = typeof value.activeProfileId === "string" ? value.activeProfileId.slice(0, 80) : "";
  return { activeProfileId: profiles.some((profile) => profile.id === activeProfileId) ? activeProfileId : "", profiles };
};

export const parseWorkspaceSetupSettings = (raw: string | undefined): Record<string, ProjectWorkspaceSetup> => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isSettingsRecord(parsed)) return {};
    const result: Record<string, ProjectWorkspaceSetup> = {};
    for (const [projectId, value] of Object.entries(parsed)) {
      const setup = parseProjectSetup(value);
      if (setup) result[projectId] = setup;
    }
    return result;
  } catch { return {}; }
};
