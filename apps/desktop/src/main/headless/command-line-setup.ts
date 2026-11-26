import { basename, resolve } from "node:path";
import type { ProviderType, UnifiedProviderFamily } from "@buildwarden/shared";
import {
  confirm,
  count,
  formatBytes,
  parseCommand,
  plain,
  readSecret,
  required,
  shortId,
  table,
  unknownAction,
  type Command,
  type CommandLineIo,
} from "./command-line-shared";
import { PROVIDER_OPTION_NAMES, type HostProvider } from "./control-protocol";
import { UsageError } from "./launch";

const PROVIDER_KINDS: Record<string, { type: ProviderType; family?: UnifiedProviderFamily; label: string; key: "none" | "optional" | "required" }> = {
  codex: { type: "codex-cli", label: "Codex", key: "none" },
  claude: { type: "claude-code", label: "Claude Code", key: "none" },
  cursor: { type: "cursor-agent", label: "Cursor", key: "none" },
  acp: { type: "acp", label: "ACP agent", key: "none" },
  openai: { type: "ai-sdk", family: "openai", label: "OpenAI", key: "required" },
  anthropic: { type: "ai-sdk", family: "anthropic", label: "Anthropic", key: "required" },
  google: { type: "ai-sdk", family: "google", label: "Google", key: "required" },
  xai: { type: "ai-sdk", family: "xai", label: "xAI", key: "required" },
  "openai-compatible": { type: "ai-sdk", family: "openai-compatible", label: "OpenAI compatible", key: "optional" },
  openrouter: { type: "openrouter", label: "OpenRouter", key: "required" },
  azure: { type: "azure-legacy", label: "Azure OpenAI", key: "required" },
};
const PROVIDER_KIND_ALIASES: Record<string, string> = { "codex-cli": "codex", "claude-code": "claude", "cursor-agent": "cursor", "azure-legacy": "azure" };

const YES = { yes: { type: "boolean", short: "y" } } as const;

const describeProvider = (provider: HostProvider): string => `${plain(provider.label)} (${shortId(provider.id)})`;

const readApiKey = async (
  io: CommandLineIo,
  key: "none" | "optional" | "required",
  fromStdin: boolean | undefined,
): Promise<string> => {
  if (key === "none") {
    if (fromStdin) throw new UsageError("This provider signs in through its own command-line tool and has no API key.");
    return "";
  }
  if (key === "optional" && !fromStdin && !io.interactive) return "";
  return readSecret(io, { fromStdin, flag: "--key-stdin", label: key === "optional" ? "API key (empty for none)" : "API key" });
};

const addProvider: Command = async (args, io) => {
  const { values, positionals: [rawKind] } = parseCommand(args, {
    label: { type: "string" },
    "base-url": { type: "string" },
    "key-stdin": { type: "boolean" },
    config: { type: "string" },
    env: { type: "string", multiple: true },
    binary: { type: "string" },
    home: { type: "string" },
    "launch-args": { type: "string" },
    "auto-compact-window": { type: "string" },
    endpoint: { type: "string" },
    command: { type: "string" },
    "api-version": { type: "string" },
  }, 1);
  const name = required(rawKind, `provider type: ${Object.keys(PROVIDER_KINDS).join(", ")}`);
  const kindName = PROVIDER_KIND_ALIASES[name] ?? name;
  if (!Object.hasOwn(PROVIDER_KINDS, kindName)) throw new UsageError(`Unknown provider type: ${name}. Use one of: ${Object.keys(PROVIDER_KINDS).join(", ")}`);
  const kind = PROVIDER_KINDS[kindName];
  const options: Record<string, string> = {};
  for (const option of PROVIDER_OPTION_NAMES) {
    const value = option === "env" ? values.env?.join("\n") : values[option];
    if (value !== undefined) options[option] = value;
  }
  const provider = await io.request("addProvider", {
    providerType: kind.type,
    ...(kind.family ? { family: kind.family } : {}),
    label: values.label ?? kind.label,
    ...(values["base-url"] ? { apiBaseUrl: values["base-url"] } : {}),
    ...(values.config ? { configJson: values.config } : {}),
    options,
    apiKey: await readApiKey(io, kind.key, values["key-stdin"]),
  });
  io.out(`Added ${describeProvider(provider)}.\nNext: buildwarden model available ${shortId(provider.id)}`);
};

export const runProvider: Command = async (args, io) => {
  const [action = "list", ...rest] = args;
  if (action === "add") return addProvider(rest, io);
  if (action === "list") {
    parseCommand(rest, {}, 0);
    const providers = await io.request("listProviders");
    io.out(table(
      providers.map((provider) => [shortId(provider.id), plain(provider.label), provider.type, count(provider.models, "model")]),
      "No providers. Add one with: buildwarden provider add <type>",
    ));
    return;
  }
  if (action === "detect") {
    parseCommand(rest, {}, 0);
    const found = await io.request("detectProviders");
    io.out(table(found.map((entry) => [entry.label, entry.path ?? `not found${entry.message ? `: ${entry.message}` : ""}`]), ""));
    return;
  }
  const { values, positionals: [reference] } = parseCommand(rest, { ...YES, "key-stdin": { type: "boolean" } }, 1);
  const provider = required(reference, "provider");
  if (action === "check") {
    io.out((await io.request("checkProvider", { provider })).message);
  } else if (action === "set-key") {
    const apiKey = await readApiKey(io, "required", values["key-stdin"]);
    io.out(`Replaced the API key of ${describeProvider(await io.request("setProviderKey", { provider, apiKey }))}.`);
  } else if (action === "remove") {
    const match = (await io.request("findProvider", { provider }));
    await confirm(io, values.yes, `This removes ${describeProvider(match)} and its ${count(match.models, "model")}.`);
    await io.request("removeProvider", { provider: match.id });
    io.out(`Removed ${describeProvider(match)}.`);
  } else {
    unknownAction("provider", action);
  }
};

export const runModel: Command = async (args, io) => {
  const [action = "list", ...rest] = args;
  if (action === "list") {
    parseCommand(rest, {}, 0);
    const models = await io.request("listModels");
    io.out(table(
      models.map((model) => [shortId(model.id), plain(model.provider), plain(model.modelId), plain(model.name)]),
      "No models. See what a provider offers with: buildwarden model available <provider>",
    ));
    return;
  }
  if (action === "available") {
    const { positionals: [provider] } = parseCommand(rest, {}, 1);
    const available = await io.request("availableModels", { provider: required(provider, "provider") });
    io.out(table(available.models.map((model) => [plain(model.modelId), plain(model.name), model.added ? "added" : ""]), "This provider lists no models."));
    if (available.errorMessage) io.error(`The provider's own list could not be loaded: ${available.errorMessage}`);
    return;
  }
  if (action === "add") {
    const { values, positionals: [provider, ...modelIds] } = parseCommand(rest, { name: { type: "string" }, "base-url": { type: "string" } }, Infinity);
    required(provider, "provider");
    required(modelIds[0], "model id");
    if (values.name && modelIds.length > 1) throw new UsageError("--name works with one model at a time.");
    for (const modelId of modelIds) {
      const model = await io.request("addModel", {
        provider, modelId,
        ...(values.name ? { name: values.name } : {}),
        ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
      });
      io.out(`Added ${plain(model.name)} (${plain(model.modelId)}) to ${plain(model.provider)}.`);
    }
    return;
  }
  if (action !== "remove") return unknownAction("model", action);
  const { values, positionals: [reference] } = parseCommand(rest, YES, 1);
  const impact = await io.request("modelImpact", { model: required(reference, "model") });
  const related = [
    count(impact.runCount, "run"), count(impact.chatCount, "chat"), count(impact.automationCount ?? 0, "automation"),
    count(impact.projectLoopCount, "loop"), count(impact.projectLabThreadCount, "lab thread"),
    count(impact.projectInsightCount, "insight"), count(impact.orchestrationCount, "orchestration"),
  ].filter((entry) => !entry.startsWith("0 "));
  await confirm(io, values.yes, `This removes ${plain(impact.modelDisplayName)}${related.length ? ` and deletes ${related.join(", ")}` : ""}.`);
  await io.request("removeModel", { modelId: impact.modelId });
  io.out(`Removed ${plain(impact.modelDisplayName)}.`);
};

/** The folder name `git clone` itself would choose. */
const cloneFolderName = (url: string): string =>
  basename(url.replace(/[?#].*$/, "").replace(/[\\/]+$/, "").replace(/\.git$/i, "").replace(/^.*:(?!\/\/)/, "/"));

const addProject = async (io: CommandLineIo, path: string, name: string | undefined): Promise<void> => {
  const project = await io.request("addProject", { path, ...(name ? { name } : {}) });
  io.out(`Added ${plain(project.name)} (${project.path}).`);
};

const runProjectToken: Command = async (args, io) => {
  const { values, positionals: [reference, action = "show"] } = parseCommand(args, { stdin: { type: "boolean" } }, 2);
  const project = required(reference, "project");
  let status;
  if (action === "show") status = await io.request("projectToken", { project });
  else if (action === "remove") status = await io.request("removeProjectToken", { project });
  else if (action === "set") {
    const token = await readSecret(io, { fromStdin: values.stdin, flag: "--stdin", label: "Access token" });
    status = await io.request("setProjectToken", { project, token });
  } else return unknownAction("project token", action);
  io.out(`${status.repoLabel} on ${status.webBaseUrl}: ${status.hasToken ? "access token saved" : "no access token"}`);
};

export const runProject: Command = async (args, io) => {
  const [action = "list", ...rest] = args;
  if (action === "token") return runProjectToken(rest, io);
  if (action === "list") {
    parseCommand(rest, {}, 0);
    const projects = await io.request("listProjects");
    io.out(table(projects.map((project) => [shortId(project.id), plain(project.name), project.path]), "No projects."));
    return;
  }
  if (action === "add" || action === "clone") {
    const { values, positionals: [source, target] } = parseCommand(rest, { name: { type: "string" } }, action === "clone" ? 2 : 1);
    if (action === "add") return addProject(io, resolve(io.cwd, required(source, "project folder")), values.name);
    const url = required(source, "repository URL");
    const folder = target ?? cloneFolderName(url);
    if (!folder) throw new UsageError("Add the folder to clone into.");
    const path = resolve(io.cwd, folder);
    // Find out that the host is not running before a long download, not after it.
    await io.request("listProjects");
    await io.gitClone(url, path);
    return addProject(io, path, values.name);
  }
  if (action !== "remove") return unknownAction("project", action);
  const { values, positionals: [reference] } = parseCommand(rest, YES, 1);
  const impact = await io.request("projectImpact", { project: required(reference, "project") });
  const active = impact.activeRuns ? `, ${String(impact.activeRuns)} of them active` : "";
  await confirm(io, values.yes,
    `This removes ${plain(impact.project.name)} with ${count(impact.runs, "run")}${active} and their worktrees. ${impact.project.path} itself is kept.`);
  await io.request("removeProject", { projectId: impact.project.id });
  io.out(`Removed ${plain(impact.project.name)}.`);
};

const CLI_NAMES: Record<string, "codex-cli" | "claude-code" | "cursor-agent"> = {
  codex: "codex-cli", "codex-cli": "codex-cli", claude: "claude-code", "claude-code": "claude-code",
  cursor: "cursor-agent", "cursor-agent": "cursor-agent",
};

export const runCli: Command = async (args, io) => {
  const { positionals: [action = "list", name] } = parseCommand(args, {}, 2);
  let snapshot;
  if (action === "update") {
    const providerType = CLI_NAMES[required(name, "name: codex, claude or cursor")];
    if (!providerType) throw new UsageError(`Unknown command-line tool: ${name}`);
    snapshot = await io.request("updateProviderCli", { providerType });
  } else {
    if (name) throw new UsageError(`Unexpected argument: ${name}`);
    if (action === "list") snapshot = await io.request("providerClis");
    else if (action === "check") snapshot = await io.request("checkProviderClis");
    else if (action === "on" || action === "off") snapshot = await io.request("enableProviderCliUpdates", { enabled: action === "on" });
    else return unknownAction("cli", action);
  }
  if (!snapshot.enabled) {
    io.out("Update checks are off. Turn them on with: buildwarden cli on");
    return;
  }
  io.out(table(snapshot.providers.map((status) => [
    status.label,
    status.installedVersion ?? "-",
    status.state === "update-available" ? `${status.latestVersion ?? "newer version"} available` : status.state,
    plain(status.message ?? (status.canAutoUpdate || status.state !== "update-available" ? "" : `${status.manualReason ?? ""} ${status.updateCommand ?? ""}`)),
  ]), "No provider uses a command-line tool yet, or nothing was checked: buildwarden cli check"));
};

export const runAutomation: Command = async (args, io) => {
  const { positionals: [action = "list", reference] } = parseCommand(args, {}, 2);
  if (action === "list") {
    const automations = await io.request("listAutomations");
    io.out(table(automations.map((automation) => [
      shortId(automation.id),
      automation.enabled ? "on" : "off",
      plain(automation.project),
      plain(automation.name),
      automation.enabled ? `next ${new Date(automation.nextRunAt).toLocaleString()}` : "",
      automation.lastError ? `last error: ${plain(automation.lastError)}` : "",
    ]), "No automations."));
    return;
  }
  if (action !== "run" && action !== "enable" && action !== "disable") return unknownAction("automation", action);
  const automation = required(reference, "automation");
  if (action === "run") {
    io.out(`Started run ${(await io.request("runAutomation", { automation })).runId}.`);
    return;
  }
  const changed = await io.request("enableAutomation", { automation, enabled: action === "enable" });
  io.out(`${plain(changed.name)} is ${changed.enabled ? `on, next ${new Date(changed.nextRunAt).toLocaleString()}` : "off"}.`);
};

export const runRun: Command = async (args, io) => {
  const { values, positionals: [action = "list", reference] } = parseCommand(args, { all: { type: "boolean" } }, 2);
  if (action === "list") {
    const runs = await io.request("listRuns", { all: values.all === true });
    io.out(table(
      runs.map((run) => [shortId(run.id), run.status, plain(run.project), new Date(run.createdAt).toLocaleString(), plain(run.title)]),
      values.all ? "No runs." : "No active runs. Show recent ones with --all.",
    ));
    return;
  }
  if (action !== "cancel") return unknownAction("run", action);
  const run = await io.request("cancelRun", { run: required(reference, "run id") });
  io.out(`Cancelled ${shortId(run.id)} (${plain(run.title)}).`);
};

export const runStorage: Command = async (args, io) => {
  const { values, positionals: [action = "show"] } = parseCommand(args, { ...YES, days: { type: "string" } }, 1);
  if (action === "show") {
    const info = await io.request("storage");
    io.out(`Database ${formatBytes(info.totalBytes)}, at least ${formatBytes(info.freeBytes)} can be reclaimed, ${formatBytes(info.diskFreeBytes)} free on the disk.`);
    return;
  }
  if (action === "compact") {
    const result = await io.request("compactStorage");
    io.out(`Reclaimed ${formatBytes(result.reclaimedBytes)}; the database now takes ${formatBytes(result.afterBytes)}.`);
    return;
  }
  if (action !== "cleanup") return unknownAction("storage", action);
  const days = Number(required(values.days, "--days <number>"));
  if (!Number.isInteger(days) || days < 1) throw new UsageError("--days must be a whole number of at least 1.");
  const impact = await io.request("cleanupImpact", { days });
  const total = impact.runCount + impact.chatCount + impact.projectLabThreadCount + impact.projectLoopCount;
  if (total === 0) {
    io.out(`Nothing is older than ${count(days, "day")}.`);
    return;
  }
  const affected = `${count(impact.runCount, "run")}, ${count(impact.chatCount, "chat")}, ${count(impact.projectLabThreadCount, "lab thread")} and ${count(impact.projectLoopCount, "loop")}`;
  await confirm(io, values.yes, `This deletes ${affected} older than ${count(days, "day")}, with their worktrees.`);
  await io.request("cleanup", { days, cutoffAt: impact.cutoffAt });
  io.out(`Deleted ${affected}.`);
};
