import { useState } from "react";
import { Pencil } from "lucide-react";
import { useInstanceContext } from "@buildwarden/renderer";
import type { SessionTitleFields } from "@buildwarden/shared";
import { useMobileApp } from "./mobile-app-context";
import { SessionTitleSheet } from "../components/SessionTitleEditor";
import type { SheetAction } from "../components/Sheet";

/** Use the owning host's permissions even while the selected instance is changing. */
export const useSessionTitleEditor = (
  kind: "run" | "chat",
  session: (SessionTitleFields & { id: string; prompt: string }) | null,
  onSaved: () => Promise<void>,
) => {
  const { client: defaultClient } = useMobileApp();
  const instances = useInstanceContext();
  const client = session ? instances?.clientForEntity(session.id) ?? defaultClient : defaultClient;
  const [open, setOpen] = useState(false);
  const allowed = session?.titleGenerationEnabled && (kind === "run" ? client.capabilities.runMutations : client.capabilities.chatMutations);
  const actions: SheetAction[] = allowed ? [{
    label: "Rename or regenerate title",
    icon: <Pencil className="size-4" />,
    onSelect: () => setOpen(true),
  }] : [];
  return {
    actions,
    sheet: open && allowed && session ? <SessionTitleSheet key={`${kind}:${session.id}`} kind={kind} session={session} client={client}
      onClose={() => setOpen(false)} onSaved={onSaved} /> : null,
  };
};
