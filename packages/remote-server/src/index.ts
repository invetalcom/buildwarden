import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import {
  DEFAULT_REMOTE_ACCESS_PORT,
  REMOTE_ACCESS_HEALTH_PATH,
  REMOTE_ACCESS_LOOPBACK_HOST,
  REMOTE_ACCESS_PAIRING_PATH,
  REMOTE_ACCESS_PROTOCOL_VERSION,
  REMOTE_ACCESS_RPC_PATH,
  REMOTE_ACCESS_SESSION_COOKIE,
  REMOTE_ACCESS_SESSION_PATH,
  REMOTE_ACCESS_SCOPES,
  type RemoteAccessAuditRecord,
  type RemoteAccessHealth,
  type RemoteAccessPairingGrant,
  type RemoteAccessPairingGrantRecord,
  type RemoteAccessPairingInput,
  type RemoteAccessScope,
  type RemoteAccessSession,
  type RemoteAccessSessionRecord,
  type RemoteApiMethod,
  type RemoteApiMethodArgs,
  type RemoteApiMethodResult,
  type RemoteRpcErrorCode,
  type RemoteRpcRequest,
  type RemoteRpcResponse,
} from "@buildwarden/shared";

const MAX_REQUEST_BODY_BYTES = 1_048_576;
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIRING_RATE_LIMIT_WINDOW_MS = 60_000;
const PAIRING_RATE_LIMIT_ATTEMPTS = 5;

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

type UntypedRemoteOperationHandler = (...args: unknown[]) => Promise<unknown>;

export interface RemoteAuthStore {
  createRemoteAccessPairingGrant(record: RemoteAccessPairingGrantRecord): void;
  consumeRemoteAccessPairingGrant(tokenHash: string, consumedAt: string): RemoteAccessPairingGrantRecord | null;
  createRemoteAccessSession(record: RemoteAccessSessionRecord): void;
  getRemoteAccessSessionByTokenHash(tokenHash: string): RemoteAccessSessionRecord | null;
  listRemoteAccessSessions(): RemoteAccessSession[];
  touchRemoteAccessSession(sessionId: string, lastUsedAt: string): void;
  revokeRemoteAccessSession(sessionId: string, revokedAt: string): boolean;
  addRemoteAccessAuditRecord(record: RemoteAccessAuditRecord): void;
}

export interface RemoteAuthServiceOptions {
  store: RemoteAuthStore;
  credentialKey: Uint8Array;
  now?: () => Date;
  pairingTtlMs?: number;
  sessionTtlMs?: number;
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

  constructor(private readonly options: RemoteAuthServiceOptions) {
    if (options.credentialKey.byteLength < 32) {
      throw new Error("Remote authentication credential key must contain at least 32 bytes.");
    }
    this.now = options.now ?? (() => new Date());
    this.pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  createPairingGrant(input: RemoteAccessPairingInput = {}): RemoteAccessPairingGrant {
    const createdAt = this.now();
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

  authenticate(token: string | null, remoteAddress: string | null): RemoteAccessSession | null {
    if (!token) {
      return null;
    }
    const session = this.options.store.getRemoteAccessSessionByTokenHash(this.hashCredential("session", token));
    const authenticatedAt = this.now();
    if (!session || session.revokedAt || session.expiresAt <= authenticatedAt.toISOString()) {
      return null;
    }
    this.options.store.touchRemoteAccessSession(session.id, authenticatedAt.toISOString());
    this.audit("session-authenticated", "success", { sessionId: session.id, remoteAddress });
    return { ...publicSession(session), lastUsedAt: authenticatedAt.toISOString() };
  }

  listSessions(): RemoteAccessSession[] {
    return this.options.store.listRemoteAccessSessions();
  }

  revokeSession(sessionId: string, remoteAddress: string | null = null): boolean {
    const revoked = this.options.store.revokeRemoteAccessSession(sessionId, this.now().toISOString());
    if (revoked) {
      this.audit("session-revoked", "success", { sessionId, remoteAddress });
    }
    return revoked;
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

interface RegisteredRemoteOperation {
  handler: UntypedRemoteOperationHandler;
  requiredScope: RemoteAccessScope;
}

export class RemoteOperationRegistry {
  private readonly handlers = new Map<RemoteApiMethod, RegisteredRemoteOperation>();

  constructor(private readonly onOperationError?: (context: RemoteOperationErrorContext) => void) {}

  register<Method extends RemoteApiMethod>(
    method: Method,
    handler: RemoteOperationHandler<Method>,
    requiredScope: RemoteAccessScope = "state:read",
  ): void {
    this.handlers.set(method, { handler: handler as UntypedRemoteOperationHandler, requiredScope });
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
    return operation.handler(...args) as Promise<RemoteApiMethodResult<Method>>;
  }

  async dispatch(payload: unknown, scopes: readonly RemoteAccessScope[]): Promise<RemoteRpcResponse> {
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

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void => {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'",
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
  body: Buffer,
  cacheControl: string,
  headOnly: boolean,
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
    "Content-Length": String(body.byteLength),
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(headOnly ? undefined : body);
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
  auth: RemoteAuthService;
  staticRoot?: string;
  port?: number;
  onServerError?: (error: unknown) => void;
}

export class RemoteAccessServer {
  private server: Server | null = null;
  private info: RemoteAccessServerInfo | null = null;
  private readonly pairingAttempts = new Map<string, number[]>();

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
    if (!isAllowedSameOrigin(request.headers.origin, request.headers.host)) {
      writeJson(response, 403, { error: "Origin is not allowed." });
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
        authentication: "required",
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
      } catch {
        writeJson(response, 400, { error: "Invalid JSON request body." });
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

    if (request.method === "POST" && url.pathname === REMOTE_ACCESS_RPC_PATH) {
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        writeJson(response, 415, { error: "Content-Type must be application/json." });
        return;
      }
      try {
        const payload = await readJsonBody(request);
        const result = await this.options.operations.dispatch(payload, session.scopes);
        writeJson(response, 200, result);
      } catch {
        writeJson(response, 400, { error: "Invalid JSON request body." });
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
      const body = await readFile(candidate);
      const extension = extname(candidate).toLowerCase();
      writeStaticResponse(
        response,
        200,
        STATIC_CONTENT_TYPES[extension] ?? "application/octet-stream",
        body,
        relativePath === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
        headOnly,
      );
      return true;
    } catch {
      return false;
    }
  }
}
