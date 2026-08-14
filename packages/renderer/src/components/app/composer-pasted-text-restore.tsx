import { createContext, useContext, type ReactNode } from "react";

const ComposerPastedTextRestoreContext = createContext<((value: string) => void) | null>(null);

export const ComposerPastedTextRestoreProvider = ({
  children,
  onRestore,
}: {
  children: ReactNode;
  onRestore: (value: string) => void;
}) => (
  <ComposerPastedTextRestoreContext.Provider value={onRestore}>
    {children}
  </ComposerPastedTextRestoreContext.Provider>
);

// The hook intentionally shares the private context with its provider.
// eslint-disable-next-line react-refresh/only-export-components
export const useComposerPastedTextRestore = (): ((value: string) => void) | null =>
  useContext(ComposerPastedTextRestoreContext);
