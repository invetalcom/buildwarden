import { useMemo, useSyncExternalStore } from "react";
import { resolveDesignPrompt, type ResolvedDesignPrompt } from "@buildwarden/shared";
import { getAppliedDesignScheme, subscribeAppliedDesignScheme } from "./design-scheme";

/**
 * The prompt options of the theme on the window, defaults filled in. It follows a draft in the
 * appearance editor as well, so the transcript previews a change before it is saved.
 */
export const usePromptStyle = (): ResolvedDesignPrompt => {
  const scheme = useSyncExternalStore(subscribeAppliedDesignScheme, getAppliedDesignScheme, getAppliedDesignScheme);
  return useMemo(() => resolveDesignPrompt(scheme?.customization?.prompt), [scheme]);
};
