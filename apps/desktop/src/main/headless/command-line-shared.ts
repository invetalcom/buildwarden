import { parseArgs } from "node:util";
import type { HostControlRequest } from "./control-protocol";
import type { DoctorProbes } from "./command-line-doctor";
import { UsageError, type ServeOptions } from "./launch";

export interface CommandLineIo {
  out(text: string): void;
  error(text: string): void;
  interactive: boolean;
  cwd: string;
  version: string;
  request: HostControlRequest;
  /** Reads one line without echoing it. Only called when `interactive`. */
  promptSecret(label: string): Promise<string>;
  promptLine(label: string): Promise<string>;
  readStdin(): Promise<string>;
  renderQr(text: string): Promise<string>;
  /** Runs `git clone` in this terminal, so Git can show progress and ask for credentials. */
  gitClone(url: string, folder: string): Promise<void>;
  doctor: DoctorProbes;
  service: {
    print(options: ServeOptions): string;
    install(options: ServeOptions): Promise<string>;
    uninstall(): Promise<string>;
  };
}

/** Returns the exit code; nothing means success. */
export type Command = (args: string[], io: CommandLineIo) => Promise<number | void>;

type CommandOptions = NonNullable<NonNullable<Parameters<typeof parseArgs>[0]>["options"]>;

export const parseCommand = <Options extends CommandOptions>(args: string[], options: Options, maxPositionals: number) => {
  let parsed;
  try {
    parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.positionals.length > maxPositionals) {
    throw new UsageError(`Unexpected argument: ${parsed.positionals[maxPositionals]}`);
  }
  return parsed;
};

export const required = (value: string | undefined, label: string): string => {
  if (!value?.trim()) throw new UsageError(`Missing ${label}.`);
  return value;
};

export const unknownAction = (command: string, action: string): never => {
  throw new UsageError(`Unknown action for ${command}: ${action}`);
};

export const rows = (entries: Array<[label: string, value: string]>): string => {
  const width = Math.max(...entries.map(([label]) => label.length)) + 2;
  return entries.map(([label, value]) => `${label.padEnd(width)}${value}`).join("\n");
};

/** Aligned columns; the last one is not padded. */
export const table = (lines: string[][], empty: string): string => {
  if (lines.length === 0) return empty;
  const widths = lines[0].map((_, column) => Math.max(...lines.map((line) => line[column].length)));
  return lines
    .map((line) => line.map((cell, column) => column === line.length - 1 ? cell : cell.padEnd(widths[column])).join("  "))
    .join("\n");
};

/** Output may contain names chosen elsewhere; keep control characters out of the terminal. */
export const plain = (value: string): string => value.replace(/\p{Cc}+/gu, " ").trim();

export const shortId = (id: string): string => id.slice(0, 8);

export const count = (amount: number, noun: string): string => `${String(amount)} ${noun}${amount === 1 ? "" : "s"}`;

export const formatBytes = (bytes: number): string => {
  const gigabytes = bytes / 1024 ** 3;
  return gigabytes >= 1 ? `${gigabytes.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

/** A pipe usually ends with a line break that is not part of the secret. */
export const readPipedSecret = async (io: CommandLineIo): Promise<string> => (await io.readStdin()).replace(/\r?\n$/, "");

export const readSecret = async (io: CommandLineIo, options: { fromStdin: boolean | undefined; flag: string; label: string }): Promise<string> => {
  if (options.fromStdin) return readPipedSecret(io);
  if (!io.interactive) throw new UsageError(`Pass it on standard input with ${options.flag}.`);
  return io.promptSecret(`${options.label}: `);
};

/** Asks before something is deleted or replaced. */
export const confirm = async (io: CommandLineIo, yes: boolean | undefined, message: string): Promise<void> => {
  if (yes) return;
  if (!io.interactive) throw new UsageError(`${message} Add --yes to confirm.`);
  if (await io.promptLine(`${message} Type yes to continue: `) !== "yes") throw new Error("Nothing was changed.");
};
