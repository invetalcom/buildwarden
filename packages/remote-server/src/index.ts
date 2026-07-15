import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_REMOTE_ACCESS_PORT,
  REMOTE_ACCESS_HEALTH_PATH,
  REMOTE_ACCESS_LOOPBACK_HOST,
  REMOTE_ACCESS_PROTOCOL_VERSION,
  REMOTE_ACCESS_RPC_PATH,
  type RemoteAccessHealth,
  type RemoteApiMethod,
  type RemoteApiMethodArgs,
  type RemoteApiMethodResult,
  type RemoteRpcErrorCode,
  type RemoteRpcRequest,
  type RemoteRpcResponse,
} from "@buildwarden/shared";

const MAX_REQUEST_BODY_BYTES = 1_048_576;

type RemoteOperationHandler<Method extends RemoteApiMethod> = (
  ...args: RemoteApiMethodArgs<Method>
) => Promise<RemoteApiMethodResult<Method>>;

type UntypedRemoteOperationHandler = (...args: unknown[]) => Promise<unknown>;

export interface RemoteOperationErrorContext {
  method: string;
  requestId: string;
  error: unknown;
}

export class RemoteOperationRegistry {
  private readonly handlers = new Map<RemoteApiMethod, UntypedRemoteOperationHandler>();

  constructor(private readonly onOperationError?: (context: RemoteOperationErrorContext) => void) {}

  register<Method extends RemoteApiMethod>(method: Method, handler: RemoteOperationHandler<Method>): void {
    this.handlers.set(method, handler as UntypedRemoteOperationHandler);
  }

  has(method: RemoteApiMethod): boolean {
    return this.handlers.has(method);
  }

  invoke<Method extends RemoteApiMethod>(
    method: Method,
    args: RemoteApiMethodArgs<Method>,
  ): Promise<RemoteApiMethodResult<Method>> {
    const handler = this.handlers.get(method);
    if (!handler) {
      return Promise.reject(new Error(`Remote operation is not registered: ${method}`));
    }
    return handler(...args) as Promise<RemoteApiMethodResult<Method>>;
  }

  async dispatch(payload: unknown): Promise<RemoteRpcResponse> {
    const parsed = parseRemoteRpcRequest(payload);
    if (!parsed.ok) {
      return errorResponse(parsed.requestId, parsed.code, parsed.message);
    }

    const { request } = parsed;
    const handler = this.handlers.get(request.method);
    if (!handler) {
      return errorResponse(request.requestId, "method-not-found", "The requested operation is not available.");
    }

    try {
      const result = await handler(...request.args);
      return {
        protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result: result === undefined ? null : result,
      };
    } catch (error) {
      this.onOperationError?.({ method: request.method, requestId: request.requestId, error });
      return errorResponse(request.requestId, "operation-failed", "The operation failed.");
    }
  }
}

type ParsedRemoteRpcRequest =
  | { ok: true; request: RemoteRpcRequest }
  | { ok: false; requestId: string; code: RemoteRpcErrorCode; message: string };

const errorResponse = (
  requestId: string,
  code: RemoteRpcErrorCode,
  message: string,
): RemoteRpcResponse => ({
  protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
  requestId,
  ok: false,
  error: { code, message },
});

const parseRemoteRpcRequest = (payload: unknown): ParsedRemoteRpcRequest => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, requestId: "", code: "invalid-request", message: "Expected a JSON object." };
  }

  const value = payload as Record<string, unknown>;
  const requestId = typeof value.requestId === "string" ? value.requestId : "";
  if (!requestId || requestId.length > 128) {
    return { ok: false, requestId, code: "invalid-request", message: "A valid requestId is required." };
  }
  if (value.protocolVersion !== REMOTE_ACCESS_PROTOCOL_VERSION) {
    return { ok: false, requestId, code: "protocol-mismatch", message: "Unsupported protocol version." };
  }
  if (typeof value.method !== "string" || !value.method) {
    return { ok: false, requestId, code: "invalid-request", message: "A method is required." };
  }
  if (!Array.isArray(value.args)) {
    return { ok: false, requestId, code: "invalid-request", message: "args must be an array." };
  }

  return {
    ok: true,
    request: {
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId,
      method: value.method as RemoteApiMethod,
      args: value.args,
    },
  };
};

const writeJson = (response: ServerResponse, statusCode: number, body: unknown): void => {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
};

const isAllowedLoopbackHostHeader = (hostHeader: string | undefined): boolean => {
  if (!hostHeader) {
    return false;
  }
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    return hostname === REMOTE_ACCESS_LOOPBACK_HOST || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    totalBytes += buffer.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as unknown : null;
};

export interface RemoteAccessServerInfo {
  host: typeof REMOTE_ACCESS_LOOPBACK_HOST;
  port: number;
  baseUrl: string;
  startedAt: string;
}

export interface RemoteAccessServerOptions {
  appVersion: string;
  operations: RemoteOperationRegistry;
  port?: number;
  onServerError?: (error: unknown) => void;
}

export class RemoteAccessServer {
  private server: Server | null = null;
  private info: RemoteAccessServerInfo | null = null;

  constructor(private readonly options: RemoteAccessServerOptions) {}

  getInfo(): RemoteAccessServerInfo | null {
    return this.info;
  }

  async start(): Promise<RemoteAccessServerInfo> {
    if (this.info) {
      return this.info;
    }

    const startedAt = new Date().toISOString();
    const server = createServer((request, response) => {
      void this.handleRequest(request, response, startedAt).catch((error) => {
        this.options.onServerError?.(error);
        if (!response.headersSent) {
          writeJson(response, 500, { error: "Internal server error." });
        } else {
          response.destroy();
        }
      });
    });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const handleError = (error: Error) => {
          server.off("listening", handleListening);
          reject(error);
        };
        const handleListening = () => {
          server.off("error", handleError);
          resolve();
        };
        server.once("error", handleError);
        server.once("listening", handleListening);
        server.listen(this.options.port ?? DEFAULT_REMOTE_ACCESS_PORT, REMOTE_ACCESS_LOOPBACK_HOST);
      });
    } catch (error) {
      this.server = null;
      throw error;
    }

    const address = server.address() as AddressInfo;
    this.info = {
      host: REMOTE_ACCESS_LOOPBACK_HOST,
      port: address.port,
      baseUrl: `http://${REMOTE_ACCESS_LOOPBACK_HOST}:${String(address.port)}`,
      startedAt,
    };
    return this.info;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.info = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      server.closeAllConnections();
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse, startedAt: string): Promise<void> {
    if (!isAllowedLoopbackHostHeader(request.headers.host)) {
      writeJson(response, 421, { error: "Loopback host required." });
      return;
    }
    if (request.headers.origin) {
      // Browser origins are deliberately disabled until authenticated web access is introduced.
      writeJson(response, 403, { error: "Browser access is not enabled." });
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === REMOTE_ACCESS_HEALTH_PATH) {
      const health: RemoteAccessHealth = {
        status: "ok",
        app: "buildwarden",
        appVersion: this.options.appVersion,
        protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
        scope: "loopback",
        authentication: "not-configured",
        startedAt,
      };
      writeJson(response, 200, health);
      return;
    }

    if (request.method === "POST" && url.pathname === REMOTE_ACCESS_RPC_PATH) {
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        writeJson(response, 415, { error: "Content-Type must be application/json." });
        return;
      }
      try {
        const payload = await readJsonBody(request);
        const result = await this.options.operations.dispatch(payload);
        writeJson(response, 200, result);
      } catch {
        writeJson(response, 400, { error: "Invalid JSON request body." });
      }
      return;
    }

    writeJson(response, 404, { error: "Not found." });
  }
}
