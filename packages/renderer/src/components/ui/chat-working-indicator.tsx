import { AgentWorkingIndicator } from "./agent-working-indicator";

export const ChatWorkingIndicator = ({ label }: { label?: string }) => (
  <AgentWorkingIndicator className="chat-working-indicator" label={label} />
);
