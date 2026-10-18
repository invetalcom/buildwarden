import { Loader2 } from "lucide-react";

export const ChatWorkingIndicator = ({ label = "Working..." }: { label?: string }) => (
  <div className="chat-working-indicator" role="status" aria-live="polite">
    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
    <span>{label}</span>
  </div>
);
