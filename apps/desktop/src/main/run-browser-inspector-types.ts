import type { WebContents } from "electron";
import type {
  RunBrowserBounds,
  RunBrowserElementCapture,
  RunBrowserElementSummary,
  RunBrowserFrameworkHint,
  RunBrowserLocatorSegment,
} from "@buildwarden/shared";

export type PageElementData = {
  locatorSegments: RunBrowserLocatorSegment[];
  fallback: string;
  tagName: string;
  visibleText: string;
  sanitizedHtml: string;
  attributes: Record<string, string>;
  computedStyles: Record<string, string>;
  ancestry: string[];
  frameworkHints: RunBrowserFrameworkHint[];
  bounds: RunBrowserBounds;
  url: string;
  title: string;
};

export type CachedCapture = { capture: RunBrowserElementCapture; expiresAt: number };
export type AttachedFrameTarget = { frameId: string; url: string; parentSessionId?: string };
export type AnnotationTarget = {
  backendNodeId: number;
  objectId: string;
  token: string;
  annotationNumber: number;
  sessionId?: string;
};
export type AnnotationBindingPayload = { type: "commit" | "resume"; token: string; comment?: string };

export interface RunBrowserInspectorOptions {
  runId: string;
  webContents: WebContents;
  onInspectingChange: (inspecting: boolean) => void;
  onSelection: (captureId: string, summary: RunBrowserElementSummary) => void;
  onError: (message: string, recoverable: boolean) => void;
}
