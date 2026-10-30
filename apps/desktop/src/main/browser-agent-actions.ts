import type { RunBrowserInput, RunBrowserViewport } from "@buildwarden/shared";

interface BrowserAgentActionContext {
  viewport: RunBrowserViewport;
  assertControl: () => void;
  navigate: (url: string, force: boolean) => Promise<void>;
  resolveTarget: (nodeId: number, snapshotId: string) => Promise<{ x: number; y: number }>;
  dispatch: (input: RunBrowserInput, release?: boolean) => Promise<void>;
}

const clickOrType = async (action: "click" | "type", args: Record<string, unknown>, context: BrowserAgentActionContext) => {
  if (action === "type" && (typeof args.text !== "string" || args.text.length > 16000)) {
    throw new Error("type requires text of at most 16000 characters.");
  }
  const point = Number.isInteger(args.nodeId) && typeof args.snapshotId === "string"
    ? await context.resolveTarget(Number(args.nodeId), args.snapshotId)
    : { x: Number(args.x), y: Number(args.y) };
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 ||
    point.x >= context.viewport.width || point.y >= context.viewport.height) {
    throw new Error("Provide a visible snapshot node or valid viewport x/y coordinates.");
  }
  context.assertControl();
  await context.dispatch({ type: "mouse", eventType: "mousePressed", ...point, button: "left", clickCount: 1 });
  // Release a pressed button even if the user takes over between events.
  await context.dispatch({ type: "mouse", eventType: "mouseReleased", ...point, button: "left", clickCount: 1 }, true);
  context.assertControl();
  if (action === "type") await context.dispatch({ type: "text", text: String(args.text) });
};

const scroll = async (args: Record<string, unknown>, context: BrowserAgentActionContext) => {
  if (typeof args.deltaY !== "number" || !Number.isFinite(args.deltaY)) throw new Error("scroll requires deltaY.");
  await context.dispatch({
    type: "wheel", x: context.viewport.width / 2, y: context.viewport.height / 2,
    deltaX: 0, deltaY: Math.max(-5000, Math.min(5000, args.deltaY)),
  });
};

const wait = async (args: Record<string, unknown>) => {
  const milliseconds = args.milliseconds;
  if (typeof milliseconds !== "number" || !Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 5000) {
    throw new Error("wait requires milliseconds between 0 and 5000.");
  }
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

/** Action-specific validation and input sequencing; the service owns session/control lifecycle. */
export const executeBrowserAgentAction = async (action: string, args: Record<string, unknown>, context: BrowserAgentActionContext): Promise<void> => {
  switch (action) {
    case "open":
    case "navigate":
      if (typeof args.url !== "string") throw new Error(`${action} requires a URL.`);
      await context.navigate(args.url, action === "navigate");
      return;
    case "click":
    case "type":
      await clickOrType(action, args, context);
      return;
    case "scroll":
      await scroll(args, context);
      return;
    case "wait":
      await wait(args);
      return;
    default:
      throw new Error(`Unknown browser action: ${action}`);
  }
};
