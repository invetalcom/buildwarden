import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A small history-backed navigation stack for the mobile UI.
 *
 * The desktop UI keeps navigation in a bag of booleans inside `App.tsx`; on a phone the hardware
 * back button and the iOS back-swipe both need a real stack, so routes are serialised into the
 * location hash (`#/run/<id>/diff`). A hash is used rather than a path because the desktop host
 * serves the embedded build as plain static files with no SPA fallback — a real path would 404
 * on reload when a phone is connected directly to the host.
 */

export const MOBILE_TABS = ["home", "runs", "chats", "more"] as const;
export type MobileTab = (typeof MOBILE_TABS)[number];

export const RUN_SEGMENTS = ["activity", "diff", "files", "agents", "notes", "chat", "terminal"] as const;
export type RunSegment = (typeof RUN_SEGMENTS)[number];

export const PROJECT_TABS = [
  "overview",
  "runs",
  "tasks",
  "branches",
  "reviews",
  "loops",
  "activity",
  "for-later",
  "settings",
] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export const SETTINGS_SECTIONS = [
  "appearance",
  "models",
  "workspace",
  "skills",
  "orchestration",
  "network",
  "session",
  "about",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type MobileRoute =
  | { name: "home" }
  | { name: "runs" }
  | { name: "chats" }
  | { name: "more" }
  | { name: "run"; runId: string; segment: RunSegment }
  | { name: "chat"; chatId: string }
  | { name: "projects" }
  | { name: "project"; projectId: string; tab: ProjectTab }
  | { name: "bookmarks" }
  | { name: "search" }
  | { name: "new-run"; projectId?: string }
  | { name: "settings"; section?: SettingsSection };

export const HOME_ROUTE: MobileRoute = { name: "home" };

const includes = <T extends string>(values: readonly T[], candidate: string): candidate is T =>
  (values as readonly string[]).includes(candidate);

/** Which bottom tab should read as active for a given route. */
export const tabForRoute = (route: MobileRoute): MobileTab => {
  switch (route.name) {
    case "home":
    case "new-run":
      return "home";
    case "runs":
    case "run":
      return "runs";
    case "chats":
    case "chat":
      return "chats";
    default:
      return "more";
  }
};

export const serializeRoute = (route: MobileRoute): string => {
  switch (route.name) {
    case "home":
      return "/";
    case "run":
      return `/run/${encodeURIComponent(route.runId)}/${route.segment}`;
    case "chat":
      return `/chat/${encodeURIComponent(route.chatId)}`;
    case "project":
      return `/project/${encodeURIComponent(route.projectId)}/${route.tab}`;
    case "new-run":
      return route.projectId ? `/new-run/${encodeURIComponent(route.projectId)}` : "/new-run";
    case "settings":
      return route.section ? `/settings/${route.section}` : "/settings";
    default:
      return `/${route.name}`;
  }
};

export const parseRoute = (path: string): MobileRoute | null => {
  const segments = path.replace(/^#/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 0) {
    return HOME_ROUTE;
  }
  const [head, first, second] = segments;
  switch (head) {
    case "runs":
    case "chats":
    case "more":
    case "projects":
    case "bookmarks":
    case "search":
      return { name: head };
    case "run":
      return first ? { name: "run", runId: first, segment: includes(RUN_SEGMENTS, second ?? "") ? second as RunSegment : "activity" } : null;
    case "chat":
      return first ? { name: "chat", chatId: first } : null;
    case "project":
      return first ? { name: "project", projectId: first, tab: includes(PROJECT_TABS, second ?? "") ? second as ProjectTab : "overview" } : null;
    case "new-run":
      return first ? { name: "new-run", projectId: first } : { name: "new-run" };
    case "settings":
      return includes(SETTINGS_SECTIONS, first ?? "") ? { name: "settings", section: first as SettingsSection } : { name: "settings" };
    default:
      return null;
  }
};

export const routesEqual = (left: MobileRoute, right: MobileRoute): boolean =>
  serializeRoute(left) === serializeRoute(right);

/** Tab switches reset the stack to that tab's root; detail screens push onto it. */
export const applyTabSwitch = (stack: MobileRoute[], tab: MobileTab): MobileRoute[] => {
  const current = stack[stack.length - 1];
  if (current && tabForRoute(current) === tab && stack.length === 1) {
    return stack;
  }
  return [{ name: tab } as MobileRoute];
};

export interface MobileRouter {
  route: MobileRoute;
  stack: readonly MobileRoute[];
  canGoBack: boolean;
  activeTab: MobileTab;
  push: (route: MobileRoute) => void;
  replace: (route: MobileRoute) => void;
  back: () => void;
  selectTab: (tab: MobileTab) => void;
}

const readInitialStack = (): MobileRoute[] => {
  const fromHash = parseRoute(window.location.hash);
  return fromHash ? [fromHash] : [HOME_ROUTE];
};

export const useMobileRouter = (): MobileRouter => {
  const [stack, setStack] = useState<MobileRoute[]>(readInitialStack);
  /** Guards the hash-sync effect while a popstate is being applied, so back does not re-push. */
  const applyingHistory = useRef(false);

  const route = stack[stack.length - 1] ?? HOME_ROUTE;

  useEffect(() => {
    const onPopState = () => {
      const next = parseRoute(window.location.hash);
      // An unparseable hash leaves the stack alone, so the sync effect never runs to clear the
      // guard — set it only once there is a route to apply.
      if (!next) return;
      applyingHistory.current = true;
      setStack((current) => {
        // Back: drop the top entry when the previous one matches the new location.
        if (current.length > 1 && routesEqual(current[current.length - 2], next)) {
          return current.slice(0, -1);
        }
        return current.length > 1 ? [...current.slice(0, -1), next] : [next];
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const target = `#${serializeRoute(route)}`;
    if (applyingHistory.current) {
      applyingHistory.current = false;
      return;
    }
    if (window.location.hash !== target) {
      window.history.pushState(null, "", target);
    }
  }, [route]);

  const push = useCallback((next: MobileRoute) => {
    setStack((current) => (routesEqual(current[current.length - 1], next) ? current : [...current, next]));
  }, []);

  const replace = useCallback((next: MobileRoute) => {
    setStack((current) => [...current.slice(0, -1), next]);
  }, []);

  const back = useCallback(() => {
    setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
  }, []);

  const selectTab = useCallback((tab: MobileTab) => {
    setStack((current) => applyTabSwitch(current, tab));
  }, []);

  return {
    route,
    stack,
    canGoBack: stack.length > 1,
    activeTab: tabForRoute(route),
    push,
    replace,
    back,
    selectTab,
  };
};
