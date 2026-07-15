import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  DEFAULT_REMOTE_ACCESS_PORT,
  REMOTE_ACCESS_HEALTH_PATH,
  REMOTE_ACCESS_INFO_PATH,
  REMOTE_ACCESS_LEGACY_HEALTH_PATH,
  REMOTE_ACCESS_LOOPBACK_HOST,
  REMOTE_ACCESS_MIN_PROTOCOL_VERSION,
  REMOTE_ACCESS_PAIRING_PATH,
  REMOTE_ACCESS_PROTOCOL_VERSION,
  REMOTE_ACCESS_RPC_PATH,
  REMOTE_ACCESS_SERVER_CAPABILITIES,
  REMOTE_ACCESS_SESSION_COOKIE,
  REMOTE_ACCESS_SESSION_PATH,
  REMOTE_ACCESS_SCOPES,
  REMOTE_ACCESS_WEBSOCKET_PATH,
  type RemoteAccessAuditRecord,
  type RemoteAccessHealth,
  type RemoteAccessInfo,
  type RemoteAccessPairingGrant,
  type RemoteAccessPairingGrantRecord,
  type RemoteAccessPairingInput,
  type RemoteAccessScope,
  type RemoteAccessSession,
  type RemoteAccessSessionRecord,
  type RemoteAccessServerCapability,
  type RemoteCommandIdempotencyRecord,
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
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_REMOTE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_REMOTE_RECORD_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIRING_RATE_LIMIT_WINDOW_MS = 60_000;
const PAIRING_RATE_LIMIT_ATTEMPTS = 5;
const REMOTE_STREAM_EVENTS = ["run", "chat", "warning", "loop", "task"] as const satisfies readonly RemoteStreamEventType[];
const REMOTE_STREAM_EVENT_SET = new Set<string>(REMOTE_STREAM_EVENTS);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

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
  requiredScope: RemoteAccessScope;
  mutating: boolean;
}

export const validateNoRemoteArgs = (args: unknown[]): args is [] => args.length === 0;

export interface RemoteAuthStore {
  createRemoteAccessPairingGrant(record: RemoteAccessPairingGrantRecord): void;
  consumeRemoteAccessPairingGrant(tokenHash: string, consumedAt: string): RemoteAccessPairingGrantRecord | null;
  createRemoteAccessSession(record: RemoteAccessSessionRecord): void;
  getRemoteAccessSessionByTokenHash(tokenHash: string): RemoteAccessSessionRecord | null;
  listRemoteAccessSessions(): RemoteAccessSession[];
  touchRemoteAccessSession(sessionId: string, lastUsedAt: string): void;
  revokeRemoteAccessSession(sessionId: string, revokedAt: string): boolean;
  addRemoteAccessAuditRecord(record: RemoteAccessAuditRecord): void;
  pruneRemoteAccessRecords(cutoffs: {
    expiredPairingGrantBefore: string;
    securityAuditBefore: string;
    completedCommandBefore: string;
  }): number;
}

export interface RemoteAuthServiceOptions {
  store: RemoteAuthStore;
  credentialKey: Uint8Array;
  now?: () => Date;
  pairingTtlMs?: number;
  sessionTtlMs?: number;
  cleanupIntervalMs?: number;
  recordRetentionMs?: number;
}

export interface RemoteAccessAuthenticatedSession {
  session: RemoteAccessSession;
  token: string;
}

const publicSession = ({ tokenHash: _tokenHash, ...session }: RemoteAccessSessionRecord): RemoteAccessSession => session;

const normalizePairingCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

const createPairingCode = (): string => {
  const bytes = randomBytes(12);
  let raw = "";
  for (const byte of bytes) {
    raw += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
  }
  return `BW-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
};

const sanitizeLabel = (label: string | undefined): string => {
  const trimmed = label?.trim().replace(/[\u0000-\u001f\u007f]/g, "") ?? "";
  return trimmed.slice(0, 80) || "Remote browser";
};

const sanitizeScopes = (scopes: RemoteAccessScope[] | undefined): RemoteAccessScope[] => {
  const requested = scopes?.length ? scopes : ["state:read" as const];
  const supported = new Set<RemoteAccessScope>(REMOTE_ACCESS_SCOPES);
  const sanitized = Array.from(new Set(requested.filter((scope) => supported.has(scope))));
  return sanitized.length ? sanitized : ["state:read"];
};

export class RemoteAuthService {
  private readonly now: () => Date;
  private readonly pairingTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly recordRetentionMs: number;
  private lastCleanupAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: RemoteAuthServiceOptions) {
    if (options.credentialKey.byteLength < 32) {
      throw new Error("Remote authentication credential key must contain at least 32 bytes.");
    }
    this.now = options.now ?? (() => new Date());
    this.pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_REMOTE_CLEANUP_INTERVAL_MS;
    this.recordRetentionMs = options.recordRetentionMs ?? DEFAULT_REMOTE_RECORD_RETENTION_MS;
    this.maybePrune(this.now());
  }

  createPairingGrant(input: RemoteAccessPairingInput = {}): RemoteAccessPairingGrant {
    const createdAt = this.now();
    this.maybePrune(createdAt);
    const code = createPairingCode();
    const grant: RemoteAccessPairingGrant = {
      id: randomUUID(),
      code,
      scopes: sanitizeScopes(input.scopes),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.pairingTtlMs).toISOString(),
    };
    this.options.store.createRemoteAccessPairingGrant({
      id: grant.id,
      scopes: grant.scopes,
      expiresAt: grant.expiresAt,
      createdAt: grant.createdAt,
      tokenHash: this.hashCredential("pairing", normalizePairingCode(code)),
      usedAt: null,
    });
    this.audit("pairing-created", "success", { pairingGrantId: grant.id, details: { scopes: grant.scopes } });
    return grant;
  }

  exchangePairingCode(code: string, label: string | undefined, remoteAddress: string | null): RemoteAccessAuthenticatedSession | null {
    const normalizedCode = normalizePairingCode(code);
    const consumedAt = this.now();
    this.maybePrune(consumedAt);
    const grant = normalizedCode
      ? this.options.store.consumeRemoteAccessPairingGrant(
          this.hashCredential("pairing", normalizedCode),
          consumedAt.toISOString(),
        )
      : null;
    if (!grant) {
      this.audit("pairing-failed", "failure", { remoteAddress });
      return null;
    }

    const token = randomBytes(32).toString("base64url");
    const sessionRecord: RemoteAccessSessionRecord = {
      id: randomUUID(),
      tokenHash: this.hashCredential("session", token),
      label: sanitizeLabel(label),
      scopes: grant.scopes,
      createdAt: consumedAt.toISOString(),
      expiresAt: new Date(consumedAt.getTime() + this.sessionTtlMs).toISOString(),
      lastUsedAt: consumedAt.toISOString(),
      revokedAt: null,
    };
    this.options.store.createRemoteAccessSession(sessionRecord);
    this.audit("pairing-consumed", "success", {
      sessionId: sessionRecord.id,
      pairingGrantId: grant.id,
      remoteAddress,
    });
    return { session: publicSession(sessionRecord), token };
  }

  authenticate(
    token: string | null,
    remoteAddress: string | null,
    options: { audit?: boolean; touch?: boolean } = {},
  ): RemoteAccessSession | null {
    if (!token) {
      return null;
    }
    const session = this.options.store.getRemoteAccessSessionByTokenHash(this.hashCredential("session", token));
    const authenticatedAt = this.now();
    this.maybePrune(authenticatedAt);
    if (!session || session.revokedAt || session.expiresAt <= authenticatedAt.toISOString()) {
      if (options.audit !== false) {
        this.audit("session-authentication-failed", "failure", { remoteAddress });
      }
      return null;
    }
    if (options.touch !== false) {
      this.options.store.touchRemoteAccessSession(session.id, authenticatedAt.toISOString());
    }
    if (options.audit !== false) {
      this.audit("session-authenticated", "success", { sessionId: session.id, remoteAddress });
    }
    return { ...publicSession(session), lastUsedAt: authenticatedAt.toISOString() };
  }

  listSessions(): RemoteAccessSession[] {
    this.maybePrune(this.now());
    return this.options.store.listRemoteAccessSessions();
  }

  revokeSession(sessionId: string, remoteAddress: string | null = null): boolean {
    const revokedAt = this.now();
    this.maybePrune(revokedAt);
    const revoked = this.options.store.revokeRemoteAccessSession(sessionId, revokedAt.toISOString());
    if (revoked) {
      this.audit("session-revoked", "success", { sessionId, remoteAddress });
    }
    return revoked;
  }

  private maybePrune(now: Date): void {
    const nowMs = now.getTime();
    if (nowMs - this.lastCleanupAt < this.cleanupIntervalMs) {
      return;
    }
    this.lastCleanupAt = nowMs;
    const retainedAfter = new Date(nowMs - this.recordRetentionMs).toISOString();
    this.options.store.pruneRemoteAccessRecords({
      expiredPairingGrantBefore: now.toISOString(),
      securityAuditBefore: retainedAfter,
      completedCommandBefore: retainedAfter,
    });
  }

  private hashCredential(kind: "pairing" | "session", credential: string): string {
    return createHmac("sha256", this.options.credentialKey)
      .update(`buildwarden:${kind}:v1:`)
      .update(credential)
      .digest("hex");
  }

  private audit(
    event: RemoteAccessAuditRecord["event"],
    outcome: RemoteAccessAuditRecord["outcome"],
    context: Partial<Pick<RemoteAccessAuditRecord, "sessionId" | "pairingGrantId" | "remoteAddress" | "details">>,
  ): void {
    this.options.store.addRemoteAccessAuditRecord({
      id: randomUUID(),
      event,
      outcome,
      sessionId: context.sessionId ?? null,
      pairingGrantId: context.pairingGrantId ?? null,
      remoteAddress: context.remoteAddress ?? null,
      details: context.details ?? null,
      createdAt: this.now().toISOString(),
    });
  }
}

export interface RemoteOperationErrorContext {
  method: string;
  requestId: string;
  error: unknown;
}

export interface RemoteIdempotencyStore {
  createRemoteCommandIdempotency(record: RemoteCommandIdempotencyRecord): boolean;
  getRemoteCommandIdempotency(sessionId: string, idempotencyKey: string): RemoteCommandIdempotencyRecord | null;
  completeRemoteCommandIdempotency(
    sessionId: string,
    idempotencyKey: string,
    responseJson: string,
    completedAt: string,
  ): boolean;
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const remoteCommandRequestHash = (method: string, args: unknown[]): string =>
  createHash("sha256").update(canonicalJson({ method, args })).digest("hex");

export class RemoteOperationRegistry {
  private readonly handlers = new Map<RemoteApiMethod, RegisteredRemoteOperation>();

  constructor(
    private readonly onOperationError?: (context: RemoteOperationErrorContext) => void,
    private readonly idempotencyStore?: RemoteIdempotencyStore,
  ) {}

  register<Method extends RemoteApiMethod>(
    method: Method,
    handler: RemoteOperationHandler<Method>,
    validateArgs: RemoteOperationArgsValidator<Method>,
    requiredScope: RemoteAccessScope = "state:read",
    mutating = false,
  ): void {
    this.handlers.set(method, {
      handler: handler as unknown as UntypedRemoteOperationHandler,
      validateArgs: validateArgs as UntypedRemoteOperationArgsValidator,
      requiredScope,
      mutating,
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

  async dispatch(
    payload: unknown,
    scopes: readonly RemoteAccessScope[] = [],
    sessionId?: string,
  ): Promise<RemoteRpcResponse> {
    const parsed = parseRemoteRpcRequest(payload);
    if (!parsed.ok) {
      return errorResponse(parsed.requestId, parsed.code, parsed.message);
    }

    const { request } = parsed;
    const operation = this.handlers.get(request.method);
    if (!operation) {
      return errorResponse(request.requestId, "method-not-found", "The requested operation is not available.");
    }
    if (!scopes.includes(operation.requiredScope)) {
      return errorResponse(request.requestId, "forbidden", "The session does not have permission for this operation.");
    }
    if (!operation.validateArgs(request.args)) {
      return errorResponse(request.requestId, "invalid-request", "The operation arguments are invalid.");
    }

    let persistedCommand: { sessionId: string; idempotencyKey: string } | null = null;
    if (operation.mutating) {
      if (!request.idempotencyKey || !sessionId || !this.idempotencyStore) {
        return errorResponse(
          request.requestId,
          "idempotency-required",
          "A persisted idempotency key is required for this command.",
        );
      }
      const requestHash = remoteCommandRequestHash(request.method, request.args);
      const created = this.idempotencyStore.createRemoteCommandIdempotency({
        sessionId,
        idempotencyKey: request.idempotencyKey,
        method: request.method,
        requestHash,
        responseJson: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
      if (!created) {
        const existing = this.idempotencyStore.getRemoteCommandIdempotency(sessionId, request.idempotencyKey);
        if (!existing || existing.method !== request.method || existing.requestHash !== requestHash) {
          return errorResponse(request.requestId, "idempotency-conflict", "The idempotency key belongs to another command.");
        }
        if (!existing.responseJson) {
          return errorResponse(request.requestId, "command-in-progress", "The command is already in progress.");
        }
        try {
          const replay = JSON.parse(existing.responseJson) as unknown;
          if (!isRemoteRpcResponse(replay)) {
            throw new Error("Invalid persisted response.");
          }
          return { ...replay, requestId: request.requestId };
        } catch {
          return errorResponse(request.requestId, "idempotency-conflict", "The persisted command response is invalid.");
        }
      }
      persistedCommand = { sessionId, idempotencyKey: request.idempotencyKey };
    }

    let response: RemoteRpcResponse;
    try {
      const result = await operation.handler(...request.args);
      response = {
        protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result: result === undefined ? null : result,
      };
    } catch (error) {
      this.onOperationError?.({ method: request.method, requestId: request.requestId, error });
      response = errorResponse(request.requestId, "operation-failed", "The operation failed.");
    }
    if (persistedCommand && this.idempotencyStore) {
      const completed = this.idempotencyStore.completeRemoteCommandIdempotency(
        persistedCommand.sessionId,
        persistedCommand.idempotencyKey,
        JSON.stringify(response),
        new Date().toISOString(),
      );
      if (!completed) {
        const error = new Error("The completed remote command response could not be persisted.");
        this.onOperationError?.({ method: request.method, requestId: request.requestId, error });
        return errorResponse(
          request.requestId,
          "operation-failed",
          "The command completed, but its replay result could not be persisted.",
        );
      }
    }
    return response;
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

const REMOTE_RPC_ERROR_CODES = new Set<RemoteRpcErrorCode>([
  "invalid-request",
  "protocol-mismatch",
  "method-not-found",
  "forbidden",
  "idempotency-required",
  "idempotency-conflict",
  "command-in-progress",
  "operation-failed",
]);

const isRemoteRpcResponse = (value: unknown): value is RemoteRpcResponse => {
  if (!isPlainObject(value) || value.protocolVersion !== REMOTE_ACCESS_PROTOCOL_VERSION ||
      typeof value.requestId !== "string" || typeof value.ok !== "boolean") {
    return false;
  }
  if (value.ok) {
    return "result" in value;
  }
  return isPlainObject(value.error) && typeof value.error.code === "string" &&
    REMOTE_RPC_ERROR_CODES.has(value.error.code as RemoteRpcErrorCode) && typeof value.error.message === "string";
};

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
  if (
    payload.idempotencyKey !== undefined &&
    (typeof payload.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(payload.idempotencyKey))
  ) {
    return { ok: false, requestId, code: "invalid-request", message: "The idempotencyKey is invalid." };
  }

  return {
    ok: true,
    request: {
      protocolVersion: REMOTE_ACCESS_PROTOCOL_VERSION,
      requestId,
      method: payload.method as RemoteApiMethod,
      args: payload.args,
      ...(typeof payload.idempotencyKey === "string" ? { idempotencyKey: payload.idempotencyKey } : {}),
    },
  };
};

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void => {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
};

const isAllowedSameOrigin = (originHeader: string | undefined, hostHeader: string | undefined): boolean => {
  if (!originHeader) {
    return true;
  }
  if (!hostHeader) {
    return false;
  }
  try {
    const origin = new URL(originHeader);
    return (origin.protocol === "http:" || origin.protocol === "https:") && origin.host.toLowerCase() === hostHeader.toLowerCase();
  } catch {
    return false;
  }
};

const getCookie = (request: IncomingMessage, name: string): string | null => {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) {
    return null;
  }
  for (const pair of cookieHeader.split(";")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex < 0 || pair.slice(0, separatorIndex).trim() !== name) {
      continue;
    }
    try {
      return decodeURIComponent(pair.slice(separatorIndex + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
};

const getSessionToken = (request: IncomingMessage): string | null => {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim() || null;
  }
  return getCookie(request, REMOTE_ACCESS_SESSION_COOKIE);
};

const sessionCookie = (token: string, expiresAt: string, secure: boolean): string => {
  const maxAgeSeconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  return [
    `${REMOTE_ACCESS_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${String(maxAgeSeconds)}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
};

const expiredSessionCookie = (): string =>
  `${REMOTE_ACCESS_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

const writeStaticResponse = (
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  contentLength: number,
  body: Buffer | undefined,
  cacheControl: string,
): void => {
  response.writeHead(statusCode, {
    "Cache-Control": cacheControl,
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
    "Content-Length": String(contentLength),
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(body);
};

const isAllowedLoopbackHostHeader = (hostHeader: string | undefined, expectedPort: number | undefined): boolean => {
  if (!hostHeader) {
    return false;
  }
  try {
    const url = new URL(`http://${hostHeader}`);
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === REMOTE_ACCESS_LOOPBACK_HOST || hostname === "localhost" || hostname === "[::1]";
    return loopback && (expectedPort === undefined || url.port === String(expectedPort));
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
  auth: RemoteAuthService;
  staticRoot?: string;
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
  private lifecycleTail: Promise<void> = Promise.resolve();
  private startPromise: Promise<RemoteAccessServerInfo> | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly pairingAttempts = new Map<string, number[]>();
  private sequence = 0;

  constructor(private readonly options: RemoteAccessServerOptions) {}

  getInfo(): RemoteAccessServerInfo | null {
    return this.info;
  }

  start(): Promise<RemoteAccessServerInfo> {
    if (this.stopPromise) {
      return this.stopPromise.then(() => this.start());
    }
    if (this.info) {
      return Promise.resolve(this.info);
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const startPromise = this.lifecycleTail.then(() => this.info ?? this.startNow());
    this.startPromise = startPromise;
    this.lifecycleTail = startPromise.then(() => undefined, () => undefined);
    void startPromise.then(
      () => {
        if (this.startPromise === startPromise) this.startPromise = null;
      },
      () => {
        if (this.startPromise === startPromise) this.startPromise = null;
      },
    );
    return startPromise;
  }

  private async startNow(): Promise<RemoteAccessServerInfo> {
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
    webSocketServer.on("error", (error) => this.options.onServerError?.(error));
    server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head, webSocketServer, startedAt));

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
      webSocketServer.close();
      throw error;
    }

    const address = server.address() as AddressInfo;
    this.server = server;
    this.webSocketServer = webSocketServer;
    this.info = {
      host: REMOTE_ACCESS_LOOPBACK_HOST,
      port: address.port,
      baseUrl: `http://${REMOTE_ACCESS_LOOPBACK_HOST}:${String(address.port)}`,
      startedAt,
    };
    return this.info;
  }

  stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const stopPromise = this.lifecycleTail.then(() => this.stopNow());
    this.stopPromise = stopPromise;
    this.lifecycleTail = stopPromise.then(() => undefined, () => undefined);
    void stopPromise.then(
      () => {
        if (this.stopPromise === stopPromise) this.stopPromise = null;
      },
      () => {
        if (this.stopPromise === stopPromise) this.stopPromise = null;
      },
    );
    return stopPromise;
  }

  private async stopNow(): Promise<void> {
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
      authentication: "session",
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
    if (!isAllowedLoopbackHostHeader(request.headers.host, this.info?.port)) {
      writeJson(response, 421, { error: "Loopback host required." });
      return;
    }
    if (!isAllowedSameOrigin(request.headers.origin, request.headers.host)) {
      writeJson(response, 403, { error: "Origin is not allowed." });
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
        authentication: "session",
        startedAt,
      };
      writeJson(response, 200, health);
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && !url.pathname.startsWith("/api/")) {
      if (await this.serveStaticAsset(url.pathname, response, request.method === "HEAD")) {
        return;
      }
      writeJson(response, 404, { error: "Web application asset not found." });
      return;
    }

    if (request.method === "POST" && url.pathname === REMOTE_ACCESS_PAIRING_PATH) {
      const remoteAddress = request.socket.remoteAddress ?? "unknown";
      if (!this.consumePairingAttempt(remoteAddress)) {
        writeJson(response, 429, { error: "Too many pairing attempts. Try again shortly." }, { "Retry-After": "60" });
        return;
      }
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        writeJson(response, 415, { error: "Content-Type must be application/json." });
        return;
      }
      try {
        const payload = await readJsonBody(request);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          writeJson(response, 400, { error: "Invalid pairing request." });
          return;
        }
        const input = payload as Record<string, unknown>;
        if (typeof input.code !== "string" || (input.label != null && typeof input.label !== "string")) {
          writeJson(response, 400, { error: "Invalid pairing request." });
          return;
        }
        const authenticated = this.options.auth.exchangePairingCode(
          input.code,
          typeof input.label === "string" ? input.label : undefined,
          request.socket.remoteAddress ?? null,
        );
        if (!authenticated) {
          writeJson(response, 401, { error: "Pairing code is invalid or expired." });
          return;
        }
        const secureCookie = request.headers.origin?.startsWith("https://") ?? false;
        writeJson(
          response,
          201,
          { session: authenticated.session },
          { "Set-Cookie": sessionCookie(authenticated.token, authenticated.session.expiresAt, secureCookie) },
        );
      } catch (error) {
        if (error instanceof RequestBodyError) {
          writeJson(response, error.statusCode, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    const session = this.options.auth.authenticate(getSessionToken(request), request.socket.remoteAddress ?? null);
    if (!session) {
      writeJson(response, 401, { error: "Authentication required." });
      return;
    }

    if (request.method === "GET" && url.pathname === REMOTE_ACCESS_SESSION_PATH) {
      writeJson(response, 200, { session });
      return;
    }

    if (request.method === "DELETE" && url.pathname === REMOTE_ACCESS_SESSION_PATH) {
      this.options.auth.revokeSession(session.id, request.socket.remoteAddress ?? null);
      writeJson(response, 200, { ok: true }, { "Set-Cookie": expiredSessionCookie() });
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
        writeJson(response, 200, await this.options.operations.dispatch(payload, session.scopes, session.id));
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

  private consumePairingAttempt(remoteAddress: string): boolean {
    const now = Date.now();
    const recentAttempts = (this.pairingAttempts.get(remoteAddress) ?? []).filter(
      (attemptedAt) => now - attemptedAt < PAIRING_RATE_LIMIT_WINDOW_MS,
    );
    if (recentAttempts.length >= PAIRING_RATE_LIMIT_ATTEMPTS) {
      this.pairingAttempts.set(remoteAddress, recentAttempts);
      return false;
    }
    recentAttempts.push(now);
    this.pairingAttempts.set(remoteAddress, recentAttempts);
    return true;
  }

  private async serveStaticAsset(pathname: string, response: ServerResponse, headOnly: boolean): Promise<boolean> {
    if (!this.options.staticRoot) {
      return false;
    }
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
    const root = resolve(this.options.staticRoot);
    const candidate = resolve(root, relativePath);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      return false;
    }
    try {
      const fileStat = await stat(candidate);
      if (!fileStat.isFile()) {
        return false;
      }
      const body = headOnly ? undefined : await readFile(candidate);
      const extension = extname(candidate).toLowerCase();
      writeStaticResponse(
        response,
        200,
        STATIC_CONTENT_TYPES[extension] ?? "application/octet-stream",
        body?.byteLength ?? fileStat.size,
        body,
        relativePath === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
      );
      return true;
    } catch {
      return false;
    }
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    webSocketServer: WebSocketServer,
    startedAt: string,
  ): void {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== REMOTE_ACCESS_WEBSOCKET_PATH) {
      rejectUpgrade(socket, 404, "Not Found", "WebSocket endpoint not found.");
      return;
    }
    if (!isAllowedLoopbackHostHeader(request.headers.host, this.info?.port)) {
      rejectUpgrade(socket, 421, "Misdirected Request", "Loopback host required.");
      return;
    }
    if (!isAllowedSameOrigin(request.headers.origin, request.headers.host)) {
      rejectUpgrade(socket, 403, "Forbidden", "Origin is not allowed.");
      return;
    }
    if (requestedProtocolVersion(request, url) !== String(REMOTE_ACCESS_PROTOCOL_VERSION)) {
      rejectUpgrade(socket, 426, "Upgrade Required", "A supported protocolVersion is required.");
      return;
    }
    const token = getSessionToken(request);
    const remoteAddress = request.socket.remoteAddress ?? null;
    const session = this.options.auth.authenticate(token, remoteAddress);
    if (!session) {
      rejectUpgrade(socket, 401, "Unauthorized", "Authentication required.");
      return;
    }
    if (!session.scopes.includes("state:read")) {
      rejectUpgrade(socket, 403, "Forbidden", "The session cannot read event streams.");
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      this.handleWebSocket(client, startedAt, token ?? "", remoteAddress);
    });
  }

  private handleWebSocket(socket: WebSocket, startedAt: string, token: string, remoteAddress: string | null): void {
    const subscriptions = new Set<RemoteStreamEventType>();
    const eventDispose = this.options.events?.subscribe((event) => {
      if (!subscriptions.has(event.event)) {
        return;
      }
      const session = this.options.auth.authenticate(token, remoteAddress, { audit: false, touch: false });
      if (!session?.scopes.includes("state:read")) {
        socket.close(1008, "Session is no longer authorized");
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
    socket.on("message", (data, isBinary) =>
      this.handleWebSocketMessage(socket, subscriptions, data, isBinary, token, remoteAddress));
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
    token: string,
    remoteAddress: string | null,
  ): void {
    const session = this.options.auth.authenticate(token, remoteAddress);
    if (!session?.scopes.includes("state:read")) {
      socket.close(1008, "Session is no longer authorized");
      return;
    }
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
