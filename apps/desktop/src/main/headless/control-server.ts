import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  MAX_CONTROL_MESSAGE_BYTES,
  type HostControlHandlers,
  type HostControlResponse,
} from "./control-protocol";

/** Unix socket paths are limited to about 104 bytes on macOS and 108 on Linux. */
const MAX_SOCKET_PATH_BYTES = 103;

export interface HostControlServerOptions {
  socketPath: string;
  handlers: HostControlHandlers;
  onError: (error: unknown) => void;
}

/** Answers terminal commands of the same user. One request and one response per connection. */
export class HostControlServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly options: HostControlServerOptions) {}

  /** The caller holds the data directory's single-instance lock, so an existing socket file is stale. */
  async start(): Promise<void> {
    const { socketPath } = this.options;
    if (process.platform !== "win32") {
      if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
        throw new Error(`The data directory path is too long for a control socket: ${socketPath}`);
      }
      const directory = dirname(socketPath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      rmSync(socketPath, { force: true });
    }
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        server.on("error", this.options.onError);
        resolve();
      });
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setEncoding("utf8");
    let received = "";
    socket.on("data", (chunk: string) => {
      received += chunk;
      const end = received.indexOf("\n");
      const line = end < 0 ? received : received.slice(0, end);
      if (Buffer.byteLength(line) > MAX_CONTROL_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      if (end < 0) return;
      socket.pause();
      socket.removeAllListeners("data");
      void this.respond(line).then((response) => {
        if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
      });
    });
  }

  private async respond(line: string): Promise<HostControlResponse> {
    try {
      const { method, input } = JSON.parse(line) as { method?: unknown; input?: unknown };
      if (typeof method !== "string" || !Object.hasOwn(this.options.handlers, method)) {
        return { ok: false, error: "The running BuildWarden host does not know this command. Restart it after an update." };
      }
      const handler = this.options.handlers[method as keyof HostControlHandlers] as (value: unknown) => Promise<unknown>;
      return { ok: true, result: (await handler(input)) ?? null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
