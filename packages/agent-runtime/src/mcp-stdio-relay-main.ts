/**
 * A stdio MCP server that relays every message to one Streamable HTTP MCP endpoint.
 *
 * ACP requires agents to support stdio MCP servers, while HTTP support is optional. BuildWarden
 * serves its own tools, and a project's MCP servers, over HTTP, so an agent without HTTP MCP gets
 * them through this relay: the agent starts it as a stdio server, and the relay forwards each
 * JSON-RPC message unchanged. It reads its target from the environment, which keeps the bearer
 * token off the command line.
 *
 * The file runs on its own (bundled as `out/main/mcp-stdio-relay.js`, started with Electron as
 * Node), so it imports nothing but Node built-ins.
 */
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const MCP_RELAY_URL_ENV = "BUILDWARDEN_MCP_RELAY_URL";
export const MCP_RELAY_HEADERS_ENV = "BUILDWARDEN_MCP_RELAY_HEADERS";

/** How long open answers may still finish once the agent closed stdin, and how long the closing DELETE may take. */
const SHUTDOWN_WAIT_MS = 5_000;

/** One event-stream event, or one JSON body, larger than this ends the relay rather than its memory. */
const MAX_MESSAGE_CHARS = 16 * 1_048_576;

type JsonRpcId = string | number;
interface JsonRpcMessage { jsonrpc?: string; id?: JsonRpcId | null; method?: string; params?: unknown; result?: unknown; error?: unknown }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Write = (message: unknown) => void;

const writeStdout: Write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

/** Writes every JSON-RPC message of an event stream as it arrives. */
const relayEventStream = async (response: Response, write: Write): Promise<void> => {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (rawEvent: string) => {
    const data = rawEvent.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    try {
      write(JSON.parse(data));
    } catch {
      // An event that is not JSON-RPC (a comment, a keep-alive) has nothing to relay.
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        if (boundary > MAX_MESSAGE_CHARS) throw new Error("The MCP server sent an event larger than the relay accepts.");
        flush(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (buffer.length > MAX_MESSAGE_CHARS) throw new Error("The MCP server sent an event larger than the relay accepts.");
      if (done) break;
    }
    if (buffer.trim()) flush(buffer);
  } finally {
    void reader.cancel().catch(() => undefined);
  }
};

/** A JSON body, read only up to the relay's limit: a larger one is cancelled, not buffered. */
const readBoundedText = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) text += decoder.decode(value, { stream: true });
      if (text.length > MAX_MESSAGE_CHARS) throw new Error("The MCP server sent a response larger than the relay accepts.");
      if (done) return text + decoder.decode();
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
};

export interface McpStdioRelayOptions {
  url: string;
  headers: Record<string, string>;
  input?: NodeJS.ReadableStream;
  /** Receives each message for the agent; stdout by default. */
  write?: Write;
  fetcher?: typeof fetch;
  /** How long shutdown waits for open answers, and then for the DELETE. */
  shutdownWaitMs?: number;
}

/** Relays until stdin ends. Resolves after the remote session was closed. */
export const runMcpStdioRelay = async (options: McpStdioRelayOptions): Promise<void> => {
  const fetcher = options.fetcher ?? fetch;
  const write = options.write ?? writeStdout;
  const relayError = (id: JsonRpcId, message: string): void => {
    write({ jsonrpc: "2.0", id, error: { code: -32603, message } });
  };
  // Set from the server's answers inside the request handlers, so TypeScript must not narrow them to null.
  let sessionId = null as string | null;
  let protocolVersion = null as string | null;
  /** Initialization must finish first: its response carries the session every later call names. */
  let initialized: Promise<void> = Promise.resolve();
  const inFlight = new Set<Promise<void>>();
  /** Aborts the requests still open when shutdown stops waiting for them. */
  const open = new AbortController();
  /** The agent's own initialize request, repeated when the server ends the session. */
  let initializeMessage: JsonRpcMessage | null = null;
  let reconnects = 0;
  /** Every later request names the version the initialize answer chose, whichever way that answer came. */
  const deliver = (message: JsonRpcMessage, forward: boolean) => (entry: unknown): void => {
    if (message.method === "initialize" && isRecord(entry) && entry.id === message.id && isRecord(entry.result)
      && typeof entry.result.protocolVersion === "string") {
      protocolVersion = entry.result.protocolVersion;
    }
    if (forward) write(entry);
  };

  /**
   * A server that no longer knows the session answers 404 and needs a fresh initialize. The relay
   * opens a new session itself, without the agent's involvement, and later calls use it; the call
   * that failed is not repeated.
   */
  const reconnect = async (): Promise<void> => {
    if (!initializeMessage) return;
    reconnects += 1;
    await post({ ...initializeMessage, id: `buildwarden-relay-reconnect-${String(reconnects)}` }, false);
    if (sessionId) await post({ jsonrpc: "2.0", method: "notifications/initialized" }, false);
  };

  const post = async (message: JsonRpcMessage, forward = true): Promise<void> => {
    const id = message.id ?? undefined;
    const usedSession = sessionId;
    try {
      const response = await fetcher(options.url, {
        method: "POST",
        headers: {
          ...options.headers,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
          ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
        },
        body: JSON.stringify(message),
        signal: open.signal,
        // A redirect would take the configured headers, credentials among them, and the request
        // body to another address. The relay talks only to the URL it was given.
        redirect: "error",
      });
      const session = response.headers.get("mcp-session-id");
      if (session) sessionId = session;
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const expired = response.status === 404 && usedSession !== null && message.method !== "initialize";
        // Calls that were already on their way fail too; only the first one opens a new session.
        if (expired && sessionId === usedSession) {
          sessionId = null;
          initialized = initialized.then(reconnect);
        }
        if (forward && id !== undefined && message.method) {
          relayError(id, expired
            ? "The MCP server ended its session. The relay opened a new one; call again."
            : `The MCP server answered HTTP ${String(response.status)}.`);
        }
        return;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        await relayEventStream(response, deliver(message, forward));
        return;
      }
      const text = await readBoundedText(response);
      if (!text.trim()) return;
      const body = JSON.parse(text) as unknown;
      for (const entry of Array.isArray(body) ? body : [body]) deliver(message, forward)(entry);
    } catch (error) {
      if (forward && id !== undefined && message.method) relayError(id, error instanceof Error ? error.message : String(error));
    }
  };

  const lines = createInterface({ input: options.input ?? process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "The relay received a line that is not JSON." } });
      continue;
    }
    if (message.method === "initialize") {
      initializeMessage = message;
      initialized = initialized.then(() => post(message));
      continue;
    }
    // Calls may run side by side (a long wait must not hold back other tools), after initialization.
    const task: Promise<void> = initialized.then(() => post(message)).finally(() => inFlight.delete(task));
    inFlight.add(task);
  }
  // A stream the server keeps open, or a server that stopped answering, must not keep the relay alive.
  const waitMs = options.shutdownWaitMs ?? SHUTDOWN_WAIT_MS;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    initialized.then(() => Promise.allSettled([...inFlight])),
    new Promise((resolve) => { drainTimer = setTimeout(resolve, waitMs); }),
  ]);
  clearTimeout(drainTimer);
  open.abort();
  if (sessionId) {
    await fetcher(options.url, { method: "DELETE", signal: AbortSignal.timeout(waitMs), redirect: "error", headers: {
      ...options.headers, "Mcp-Session-Id": sessionId, ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
    } })
      .then((response) => response.body?.cancel()).catch(() => undefined);
  }
};

const readHeaders = (raw: string | undefined): Record<string, string> => {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error(`${MCP_RELAY_HEADERS_ENV} must be a JSON object.`);
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
};

/** Whether this file is the process's entry point rather than a module another file imported. */
const startedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
  return normalize(entry) === normalize(fileURLToPath(import.meta.url));
};

if (startedDirectly()) {
  const url = process.env[MCP_RELAY_URL_ENV];
  if (!url) {
    process.stderr.write(`${MCP_RELAY_URL_ENV} is not set.\n`);
    process.exit(2);
  }
  runMcpStdioRelay({ url, headers: readHeaders(process.env[MCP_RELAY_HEADERS_ENV]) }).then(
    // Exit only once stdout has passed on the last answers: a pipe may still hold them.
    () => { process.stdout.write("", () => process.exit(0)); },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
