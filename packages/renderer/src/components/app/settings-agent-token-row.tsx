import { useState } from "react";
import type { RemoteAccessAgentToken, RemoteAccessScope } from "@buildwarden/shared";
import { Bot, Copy } from "lucide-react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Spinner } from "../ui/motion";
import { SegmentedControl } from "../ui/segmented-control";
import { SettingsRow } from "./settings-layout";

const AGENT_ACCESS_OPTIONS = [
  { value: "read", label: "Read only" },
  { value: "runs", label: "Start runs" },
] as const;

const AGENT_SCOPES: Record<(typeof AGENT_ACCESS_OPTIONS)[number]["value"], RemoteAccessScope[]> = {
  read: ["state:read"],
  // Approvals stay with the user: an outside agent cannot approve its own runs' commands.
  runs: ["state:read", "run:operate"],
};

/** The command that adds BuildWarden to Claude Code with this token. */
const claudeMcpAddCommand = (token: RemoteAccessAgentToken): string =>
  `claude mcp add --transport http buildwarden ${token.mcpUrl} --header "Authorization: Bearer ${token.token}"`;

/** Issues a session for an MCP client outside the app and shows how to connect it. */
export function AgentTokenRow({ enabled, onIssued }: { enabled: boolean; onIssued: () => Promise<void> }) {
  const buildwarden = useBuildWardenClient();
  const [access, setAccess] = useState<(typeof AGENT_ACCESS_OPTIONS)[number]["value"]>("runs");
  const [token, setToken] = useState<RemoteAccessAgentToken | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const issue = async () => {
    setWorking(true);
    setError(null);
    try {
      setToken(await buildwarden.createRemoteAccessAgentToken({ label: "Outside agent (MCP)", scopes: AGENT_SCOPES[access] }));
      await onIssued();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The agent token could not be created.");
    } finally {
      setWorking(false);
    }
  };
  return (
    <SettingsRow
      align="start"
      title="Connect an outside agent"
      description={(
        <>
          <p>Claude Code, Codex or any MCP client can list projects, start and follow runs, and send follow-ups through BuildWarden&apos;s MCP endpoint.</p>
          <p className="text-[var(--ec-faint)]">The token is shown once and appears under paired devices, where you can revoke it. Commands its runs want to execute still wait for your approval.</p>
        </>
      )}
    >
      <div className="flex w-full flex-col items-start gap-2 md:items-end">
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <SegmentedControl label="Agent access" options={AGENT_ACCESS_OPTIONS} value={access} onChange={setAccess} disabled={!enabled || working} />
          <Button type="button" size="xs" disabled={!enabled || working} onClick={() => void issue()}>
            {working ? <Spinner className="mr-1.5 size-3.5" /> : <Bot className="mr-1.5 size-3.5" />}
            Create agent token
          </Button>
        </div>
        {token ? (
          <div className="flex w-full max-w-md items-center gap-1 rounded-md bg-[var(--ec-panel-soft)] py-0.5 pr-0.5 pl-2.5">
            <code className="min-w-0 flex-1 truncate text-[11px] text-[var(--ec-text)]" title={token.mcpUrl}>{token.mcpUrl}</code>
            <Button type="button" variant="ghost" size="xs" title="Copy the Claude Code command" onClick={() => void navigator.clipboard.writeText(claudeMcpAddCommand(token))}>
              <Copy className="mr-1 size-3.5" />claude mcp add
            </Button>
            <Button type="button" variant="ghost" size="xs" title="Copy the bearer token" onClick={() => void navigator.clipboard.writeText(token.token)}>
              <Copy className="mr-1 size-3.5" />Token
            </Button>
          </div>
        ) : null}
        {error ? <p className="text-[11px] text-[var(--ec-danger)]" role="alert">{error}</p> : null}
      </div>
    </SettingsRow>
  );
}
