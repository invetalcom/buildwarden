import { useEffect, useState } from "react";
import { APP_SETTING_KEYS, parseRevisionVerificationPolicy } from "@buildwarden/shared";
import type { BuildWardenClient } from "../../lib/buildwarden-client-core";

export const RevisionVerificationPolicy = ({ client, projectId }: { client: BuildWardenClient; projectId: string }) => {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setBusy(true);
    void client.getSnapshot().then((snapshot) => { if (alive) setEnabled(parseRevisionVerificationPolicy(snapshot.settings[APP_SETTING_KEYS.revisionVerificationPolicy])[projectId] === true); })
      .catch((e) => { if (alive) setError(String(e)); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [client, projectId]);
  const save = async (value: boolean) => {
    setBusy(true); setError("");
    try {
      await client.setProjectRevisionVerificationPolicy(projectId, value);
      setEnabled(value);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <div>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={enabled} disabled={busy || !client.capabilities.projectSettingsMutations} onChange={(e) => void save(e.target.checked)} />Require current revision to pass before commit or publish</label>
    <p className="mt-1 text-[11px] text-[var(--ec-faint)]">Edits or changed commands invalidate evidence. Committing unchanged contents preserves it. Ignored build artifacts and dependencies are outside the revision.</p>
    {error && <p role="alert" className="text-xs text-[var(--ec-danger)]">{error}</p>}
  </div>;
};
