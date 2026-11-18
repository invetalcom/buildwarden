import type { DeepLinkTarget } from "@buildwarden/shared";
import type { ResolvedDeepLink } from "@buildwarden/renderer";
import { serializeRoute, type MobileRoute } from "./mobile-router";

/**
 * A route that came from a shared link and still names a host-local ID. The mobile UI addresses
 * entities by instance-scoped IDs, so such a route is resolved first and then replaced in place.
 */
export interface PendingRouteLink {
  /** Stable while the same route is showing; used to tie a failed lookup to its route. */
  key: string;
  target: DeepLinkTarget;
  toRoute: (resolved: ResolvedDeepLink) => MobileRoute | null;
}

export const pendingRouteLink = (route: MobileRoute, isScoped: (id: string) => boolean): PendingRouteLink | null => {
  switch (route.name) {
    case "run":
      return isScoped(route.runId) ? null : {
        key: serializeRoute(route),
        target: { kind: "run", runId: route.runId, segment: route.segment },
        toRoute: (resolved) => resolved.kind === "run" ? { name: "run", runId: resolved.runId, segment: route.segment } : null,
      };
    case "chat":
      return isScoped(route.chatId) ? null : {
        key: serializeRoute(route),
        target: { kind: "chat", chatId: route.chatId },
        toRoute: (resolved) => resolved.kind === "chat" ? { name: "chat", chatId: resolved.chatId } : null,
      };
    case "project":
      return isScoped(route.projectId) ? null : {
        key: serializeRoute(route),
        target: { kind: "project", projectId: route.projectId },
        toRoute: (resolved) => resolved.kind === "project" ? { name: "project", projectId: resolved.projectId, tab: route.tab } : null,
      };
    default:
      return null;
  }
};

/** The route an in-app link pushes; {@link pendingRouteLink} then resolves its host-local ID. */
export const routeForDeepLinkTarget = (target: DeepLinkTarget): MobileRoute => {
  switch (target.kind) {
    case "run":
      return { name: "run", runId: target.runId, segment: target.segment ?? "activity" };
    case "chat":
      return { name: "chat", chatId: target.chatId };
    case "project":
      return { name: "project", projectId: target.projectId, tab: "overview" };
  }
};
