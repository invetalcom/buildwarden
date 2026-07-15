import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  DEFAULT_REMOTE_ACCESS_PORT,
  REMOTE_ACCESS_HEALTH_PATH,
  REMOTE_ACCESS_INFO_PATH,
  REMOTE_ACCESS_LEGACY_HEALTH_PATH,
  REMOTE_ACCESS_LOOPBACK_HOST,
  REMOTE_ACCESS_MIN_PROTOCOL_VERSION,
  REMOTE_ACCESS_PROTOCOL_VERSION,
  REMOTE_ACCESS_RPC_PATH,
  REMOTE_ACCESS_SERVER_CAPABILITIES,
  REMOTE_ACCESS_WEBSOCKET_PATH,
  type RemoteAccessHealth,
  type RemoteAccessInfo,
  type RemoteAccessServerCapability,
  type RemoteApiMethod,
  type RemoteApiMethodArgs,
  type RemoteApiMethodResult,
  type RemoteRpcErrorCode,
  type RemoteRpcRequest,
  type RemoteRpcResponse,
  type RemoteStreamEvent,
  type RemoteStreamEventType,
  type RemoteWebSocketClientMessage,
  type RemoteWebSocketServerMessage,
} from "@buildwarden/shared";

const MAX_REQUEST_BODY_BYTES = 1_048_576;
const MAX_WEBSOCKET_MESSAGE_BYTES = 65_536;
const REMOTE_STREAM_EVENTS = ["run", "chat", "warning", "loop", "task"] as const satisfies readonly RemoteStreamEventType[];
const REMOTE_STREAM_EVENT_SET = new Set<string>(REMOTE_STREAM_EVENTS);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

type RemoteOperationHandler<Method extends RemoteApiMethod> = (
  ...args: RemoteApiMethodArgs<Method>
) => Promise<RemoteApiMethodResult<Method>>;

type RemoteOperationArgsValidator<Method extends RemoteApiMethod> = (
  args: unknown[],
) => args is RemoteApiMethodArgs<Method>;

type UntypedRemoteOperationHandler = (...args: unknown[]) => Promise<unknown>;
type UntypedRemoteOperationArgsValidator = (args: unknown[]) => boolean;

interface RegisteredRemoteOperation {
  handler: UntypedRemoteOperationHandler;
  validateArgs: UntypedRemoteOperationArgsValidator;
}

export const validateNoRemoteArgs = (args: unknown[]): args is [] => args.length === 0;

export interface RemoteOperationErrorContext {
  method: string;
  requestId: string;
  error: unknown;
}

export class RemoteOperationRegistry {
  private readonly handlers = new Map<RemoteApiMethod, RegisteredRemoteOperation>();

  constructor(private readonly onOperationError?: (context: RemoteOperationErrorContext) => void) {}

  register<Method extends RemoteApiMethod>(
    method: Method,
    handler: RemoteOperationHandler<Method>,
    validateArgs: RemoteOperationArgsValidator<Method>,
  ): void {
    this.handlers.set(method, {
      handler: handler as unknown as UntypedRemoteOperationHandler,
      validateArgs: validateArgs as UntypedRemoteOperationArgsValidator,
    });
  }

  has(method: RemoteApiMethod): boolean {
    return this.handlers.has(method);
  }

  invoke<Method extends RemoteApiMethod>(
    method: Method,
    args: RemoteApiMethodArgs<Method>,
  ): Promise<RemoteApiMethodResult<Method>> {
    const operation = this.handlers.get(method);
    if (!operation) {
      return Promise.reject(new Error(`Remote operation is not registered: ${method}`));
    }
    return operation.handler(...args as unknown[]) as Promise<RemoteApiMethodResult<Method>>;
  }

  async dispatch(payload: unknown): Promise<RemoteRpcResponse> {
    const parsed = parseRemoteRpcRequest(payload);
    if (!parsed.ok) {
      return errorResponse(parsed.requestId, parsed.code, parsed.message);
    }

    const { request } = parsed;
    const operation = this.handlers.get(request.method);
    if (!operation) {
      return errorResponse(request.requestId, "method-not-found", "The requested operation is not available.");
    }
    if (!operation.validateArgs(request.args)) {
      return errorResponse(request.requestId, "invalid-request", "The operation arguments are invalid.");
    }

    try {
      const result = await operation.handler(...request.args);
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

const errorResponse = (requestId: string, code: RemoteRpcErrorCode, message: string): RemoteRpcResponse => ({
  protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
  requestId,
  ok: false,
  error: { code, message },
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isRequestId = (value: unknown): value is string =>
  typeof value === "string" && REQUEST_ID_PATTERN.test(value);

const parseRemoteRpcRequest = (payload: unknown): ParsedRemoteRpcRequest => {
  if (!isPlainObject(payload)) {
    return { ok: false, requestId: "", code: "invalid-request", message: "Expected a JSON object." };
  }

  const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
  if (!isRequestId(requestId)) {
    return { ok: false, requestId, code: "invalid-request", message: "A valid requestId is required." };
  }
  if (payload.protocolVersion !== REMOTE_ACCESS_PROTOCOL_VERSION) {
    return { ok: false, requestId, code: "protocol-mismatch", message: "Unsupported protocol version." };
  }
  if (typeof payload.method !== "string" || !payload.method || payload.method.length > 128) {
    return { ok: false, requestId, code: "invalid-request", message: "A valid method is required." };
  }
  if (!Array.isArray(payload.args)) {
    return { ok: false, requestId, code: "invalid-request", message: "args must be an array." };
  }

  return {
    ok: true,
    request: {
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId,
      method: payload.method as RemoteApiMethod,
      args: payload.args,
    },
  };
};

const writeJson = (response: ServerResponse, statusCode: number, body: unknown): void => {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
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

class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 413,
  ) {
    super(message);
  }
}

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyError("Request body is too large.", 413);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    totalBytes += buffer.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyError("Request body is too large.", 413);
    }
    chunks.push(buffer);
  }
  try {
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) as unknown : null;
  } catch {
    throw new RequestBodyError("Invalid JSON request body.", 400);
  }
};

const firstHeaderValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const requestedProtocolVersion = (request: IncomingMessage, url: URL): string | undefined =>
  firstHeaderValue(request.headers["x-buildwarden-protocol-version"]) ?? url.searchParams.get("protocolVersion") ?? undefined;

export interface RemoteAccessServerInfo {
  host: typeof REMOTE_ACCESS_LOOPBACK_HOST;
  port: number;
  baseUrl: string;
  startedAt: string;
}

export interface RemoteHostEventSource {
  subscribe(listener: (event: RemoteStreamEvent) => void): () => void;
}

export interface RemoteAccessServerOptions {
  appVersion: string;
  operations: RemoteOperationRegistry;
  events?: RemoteHostEventSource;
  port?: number;
  capabilities?: RemoteAccessServerCapability[];
  authentication?: RemoteAccessHealth["authentication"];
  onServerError?: (error: unknown) => void;
}

const isRunEventPayload = (value: unknown): boolean =>
  isPlainObject(value) &&
  typeof value.runId === "string" &&
  typeof value.type === "string" &&
  typeof value.title === "string" &&
  typeof value.content === "string" &&
  typeof value.createdAt === "string" &&
  (value.metadata === undefined || isPlainObject(value.metadata));

const isRemoteEventPayload = (event: RemoteStreamEventType, payload: unknown): boolean => {
  if (event === "run") return isRunEventPayload(payload);
  if (event === "chat") return isRunEventPayload(payload) && isPlainObject(payload) && typeof payload.chatId === "string";
  if (event === "warning") {
    return isPlainObject(payload) && typeof payload.title === "string" && typeof payload.message === "string" &&
      (payload.detail === undefined || typeof payload.detail === "string");
  }
  if (event === "loop") {
    return isPlainObject(payload) && typeof payload.loopId === "string" && typeof payload.projectId === "string";
  }
  return isPlainObject(payload) && typeof payload.projectId === "string" && typeof payload.taskId === "string" &&
    (payload.status === "open" || payload.status === "in_progress" || payload.status === "in_review" || payload.status === "done");
};

const parseWebSocketClientMessage = (
  payload: unknown,
): { ok: true; message: RemoteWebSocketClientMessage } | { ok: false; requestId: string; code: "invalid-message" | "protocol-mismatch"; message: string } => {
  if (!isPlainObject(payload)) {
    return { ok: false, requestId: "", code: "invalid-message", message: "Expected a JSON object." };
  }
  const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
  if (!isRequestId(requestId)) {
    return { ok: false, requestId, code: "invalid-message", message: "A valid requestId is required." };
  }
  if (payload.protocolVersion !== REMOTE_ACCESS_PROTOCOL_VERSION) {
    return { ok: false, requestId, code: "protocol-mismatch", message: "Unsupported protocol version." };
  }
  if (payload.type === "ping") {
    return { ok: true, message: { protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION, type: "ping", requestId } };
  }
  if (payload.type !== "subscribe" || !Array.isArray(payload.events)) {
    return { ok: false, requestId, code: "invalid-message", message: "Expected a subscribe or ping message." };
  }
  if (!payload.events.every((event): event is RemoteStreamEventType => typeof event === "string" && REMOTE_STREAM_EVENT_SET.has(event))) {
    return { ok: false, requestId, code: "invalid-message", message: "One or more event subscriptions are invalid." };
  }
  const events = [...new Set(payload.events)];
  return {
    ok: true,
    message: { protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION, type: "subscribe", requestId, events },
  };
};

const validateServerMessage = (message: RemoteWebSocketServerMessage): boolean => {
  if (message.protocolVersion !== REMOTE_ACCESS_PROTOCOL_VERSION) return false;
  if (message.type === "hello") {
    return message.info.protocolVersion === REMOTE_ACCESS_PROTOCOL_VERSION && message.info.apiVersion === "v1";
  }
  if (message.type === "event") {
    return Number.isSafeInteger(message.sequence) && message.sequence > 0 && isRemoteEventPayload(message.event, message.payload);
  }
  if (!isRequestId(message.requestId)) return false;
  if (message.type === "subscribed") {
    return message.events.every((event) => REMOTE_STREAM_EVENT_SET.has(event));
  }
  return message.type === "pong" || (message.type === "error" && typeof message.message === "string");
};

const rejectUpgrade = (socket: Duplex, statusCode: number, statusText: string, message: string): void => {
  const body = JSON.stringify({ error: message });
  socket.write([
    `HTTP/1.1 ${String(statusCode)} ${statusText}`,
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    "",
    body,
  ].join("\r\n"));
  socket.destroy();
};

export class RemoteAccessServer {
  private server: Server | null = null;
  private webSocketServer: WebSocketServer | null = null;
  private info: RemoteAccessServerInfo | null = null;
  private sequence = 0;

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
    const webSocketServer = new WebSocketServer({ noServer: true, clientTracking: true, maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES });
    webSocketServer.on("connection", (socket) => this.handleWebSocket(socket, startedAt));
    webSocketServer.on("error", (error) => this.options.onServerError?.(error));
    server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head, webSocketServer));
    this.server = server;
    this.webSocketServer = webSocketServer;

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
      this.webSocketServer = null;
      webSocketServer.close();
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
    const webSocketServer = this.webSocketServer;
    this.server = null;
    this.webSocketServer = null;
    this.info = null;
    if (webSocketServer) {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    }
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }

  private buildInfo(startedAt: string): RemoteAccessInfo {
    const capabilities = this.options.capabilities ?? [
      "rpc",
      ...(this.options.events ? REMOTE_ACCESS_SERVER_CAPABILITIES.filter((capability) => capability !== "rpc") : []),
    ];
    return {
      app: "buildwarden",
      appVersion: this.options.appVersion,
      apiVersion: "v1",
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      minProtocolVersion: REMOTE_ACCESS_MIN_PROTOCOL_VERSION,
      maxProtocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      scope: "loopback",
      authentication: this.options.authentication ?? "not-configured",
      capabilities: [...new Set(capabilities)],
      endpoints: {
        health: REMOTE_ACCESS_HEALTH_PATH,
        info: REMOTE_ACCESS_INFO_PATH,
        rpc: REMOTE_ACCESS_RPC_PATH,
        events: REMOTE_ACCESS_WEBSOCKET_PATH,
      },
      startedAt,
    };
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse, startedAt: string): Promise<void> {
    if (!isAllowedLoopbackHostHeader(request.headers.host)) {
      writeJson(response, 421, { error: "Loopback host required." });
      return;
    }
    if (request.headers.origin) {
      writeJson(response, 403, { error: "Browser access is not enabled." });
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && (url.pathname === REMOTE_ACCESS_HEALTH_PATH || url.pathname === REMOTE_ACCESS_LEGACY_HEALTH_PATH)) {
      const health: RemoteAccessHealth = {
        status: "ok",
        app: "buildwarden",
        appVersion: this.options.appVersion,
        protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
        scope: "loopback",
        authentication: this.options.authentication ?? "not-configured",
        startedAt,
      };
      writeJson(response, 200, health);
      return;
    }

    if (request.method === "GET" && url.pathname === REMOTE_ACCESS_INFO_PATH) {
      const info = this.buildInfo(startedAt);
      const requestedVersion = requestedProtocolVersion(request, url);
      if (requestedVersion && requestedVersion !== String(REMOTE_ACCESS_PROTOCOL_VERSION)) {
        writeJson(response, 426, { error: "Unsupported protocol version.", info });
        return;
      }
      writeJson(response, 200, info);
      return;
    }

    if (request.method === "POST" && url.pathname === REMOTE_ACCESS_RPC_PATH) {
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        writeJson(response, 415, { error: "Content-Type must be application/json." });
        return;
      }
      try {
        const payload = await readJsonBody(request);
        writeJson(response, 200, await this.options.operations.dispatch(payload));
      } catch (error) {
        if (error instanceof RequestBodyError) {
          writeJson(response, error.statusCode, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    writeJson(response, 404, { error: "Not found." });
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, webSocketServer: WebSocketServer): void {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== REMOTE_ACCESS_WEBSOCKET_PATH) {
      rejectUpgrade(socket, 404, "Not Found", "WebSocket endpoint not found.");
      return;
    }
    if (!isAllowedLoopbackHostHeader(request.headers.host)) {
      rejectUpgrade(socket, 421, "Misdirected Request", "Loopback host required.");
      return;
    }
    if (request.headers.origin) {
      rejectUpgrade(socket, 403, "Forbidden", "Browser access is not enabled.");
      return;
    }
    if (requestedProtocolVersion(request, url) !== String(REMOTE_ACCESS_PROTOCOL_VERSION)) {
      rejectUpgrade(socket, 426, "Upgrade Required", "A supported protocolVersion is required.");
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit("connection", client, request);
    });
  }

  private handleWebSocket(socket: WebSocket, startedAt: string): void {
    const subscriptions = new Set<RemoteStreamEventType>();
    const eventDispose = this.options.events?.subscribe((event) => {
      if (!subscriptions.has(event.event)) {
        return;
      }
      this.sendWebSocketMessage(socket, {
        protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
        type: "event",
        sequence: ++this.sequence,
        event: event.event,
        payload: event.payload,
      });
    });
    socket.once("close", () => eventDispose?.());
    socket.on("error", (error) => this.options.onServerError?.(error));
    socket.on("message", (data, isBinary) => this.handleWebSocketMessage(socket, subscriptions, data, isBinary));
    this.sendWebSocketMessage(socket, {
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "hello",
      info: this.buildInfo(startedAt),
    });
  }

  private handleWebSocketMessage(
    socket: WebSocket,
    subscriptions: Set<RemoteStreamEventType>,
    data: RawData,
    isBinary: boolean,
  ): void {
    let payload: unknown;
    try {
      const buffer = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(new Uint8Array(data));
      if (isBinary || buffer.byteLength > MAX_WEBSOCKET_MESSAGE_BYTES) {
        throw new Error("Only bounded JSON text messages are accepted.");
      }
      payload = JSON.parse(buffer.toString("utf8")) as unknown;
    } catch (error) {
      this.sendWebSocketMessage(socket, {
        protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
        type: "error",
        requestId: "invalid",
        code: "invalid-message",
        message: error instanceof Error ? error.message : "Invalid JSON message.",
      });
      return;
    }

    const parsed = parseWebSocketClientMessage(payload);
    if (!parsed.ok) {
      this.sendWebSocketMessage(socket, {
        protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
        type: "error",
        requestId: isRequestId(parsed.requestId) ? parsed.requestId : "invalid",
        code: parsed.code,
        message: parsed.message,
      });
      if (parsed.code === "protocol-mismatch") {
        socket.close(1002, "Protocol version mismatch");
      }
      return;
    }

    if (parsed.message.type === "ping") {
      this.sendWebSocketMessage(socket, {
        protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
        type: "pong",
        requestId: parsed.message.requestId,
      });
      return;
    }

    subscriptions.clear();
    parsed.message.events.forEach((event) => subscriptions.add(event));
    this.sendWebSocketMessage(socket, {
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      type: "subscribed",
      requestId: parsed.message.requestId,
      events: [...subscriptions],
    });
  }

  private sendWebSocketMessage(socket: WebSocket, message: RemoteWebSocketServerMessage): void {
    if (!validateServerMessage(message)) {
      this.options.onServerError?.(new Error("Refused to publish an invalid remote WebSocket message."));
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}
