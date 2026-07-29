import { useEffect, useState } from "react";
import type { RunPublishOptions } from "@buildwarden/shared";
import { Sparkles } from "lucide-react";
import { useMobileApp } from "../../data/mobile-app-context";
import { useAction } from "../../data/use-action";
import { errorMessage } from "../../lib/format";
import { Sheet } from "../../components/Sheet";
import { Button, CenteredSpinner, InlineError, Input, Textarea } from "../../components/primitives";

/**
 * Commit / publish / pull-request flows as full-width sheets. The desktop renders these as centred
 * dialogs with side-by-side fields; on a phone each field owns a row and the primary action sits
 * in a pinned footer above the safe-area inset.
 */

export const CommitSheet = ({ runId, open, onClose, onDone }: { runId: string; open: boolean; onClose: () => void; onDone: () => Promise<void> }) => {
  const { client } = useMobileApp();
  const action = useAction();
  const [message, setMessage] = useState("");

  const suggest = async () => {
    const suggestion = await action.run(() => client.suggestCommitMessage(runId), "Could not suggest a message.");
    if (suggestion) setMessage(suggestion);
  };

  const submit = async () => {
    if (!message.trim()) return;
    const result = await action.run(() => client.commitRun(runId, message.trim()), "The commit did not go through.");
    if (result !== undefined) {
      setMessage("");
      onClose();
      await onDone();
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Commit changes"
      dismissable={!action.busy}
      footer={
        <Button block busy={action.busy} disabled={!message.trim()} onClick={() => void submit()}>
          Commit
        </Button>
      }
    >
      <div className="flex flex-col gap-2 px-4 py-3">
        {action.error ? <InlineError message={action.error} /> : null}
        <Textarea rows={5} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Commit message" />
        <Button tone="neutral" size="sm" busy={action.busy} onClick={() => void suggest()}>
          <Sparkles className="size-4" />
          Suggest from the diff
        </Button>
      </div>
    </Sheet>
  );
};

export const PublishBranchSheet = ({
  runId,
  defaultName,
  open,
  onClose,
  onDone,
}: {
  runId: string;
  defaultName: string;
  open: boolean;
  onClose: () => void;
  onDone: (result: string) => Promise<void>;
}) => {
  const { client } = useMobileApp();
  const action = useAction();
  const [name, setName] = useState(defaultName);

  useEffect(() => {
    if (open) setName(defaultName);
  }, [defaultName, open]);

  const submit = async () => {
    const result = await action.run(() => client.publishRunBranch(runId, name.trim() || undefined), "Could not publish the branch.");
    if (result !== undefined) {
      onClose();
      await onDone(result);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Publish branch"
      dismissable={!action.busy}
      footer={
        <Button block busy={action.busy} onClick={() => void submit()}>
          Push to origin
        </Button>
      }
    >
      <div className="flex flex-col gap-2 px-4 py-3">
        {action.error ? <InlineError message={action.error} /> : null}
        <label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">Branch name</label>
        <Input value={name} onChange={(event) => setName(event.target.value)} spellCheck={false} autoCapitalize="none" className="m-mono text-[13px]" />
      </div>
    </Sheet>
  );
};

export const PullRequestSheet = ({
  runId,
  open,
  onClose,
  onDone,
}: {
  runId: string;
  open: boolean;
  onClose: () => void;
  onDone: (url: string) => Promise<void>;
}) => {
  const { client } = useMobileApp();
  const action = useAction();
  const [options, setOptions] = useState<RunPublishOptions | null>(null);
  const [target, setTarget] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setOptionsError(null);
    void client
      .getRunPublishOptions(runId)
      .then((next) => {
        if (cancelled) return;
        setOptions(next);
        setTarget(next.defaultTargetBranch);
        setTitle(next.suggestedTitle);
        setDescription(next.defaultDescription);
      })
      // Without this the sheet sits on "Loading branches" forever after a dropped connection, and
      // the rejection escapes as an unhandled one.
      .catch((caught: unknown) => {
        if (!cancelled) setOptionsError(errorMessage(caught, "Could not load the branches for this run."));
      });
    return () => {
      cancelled = true;
    };
  }, [client, open, reloadNonce, runId]);

  const generate = async () => {
    const suggestion = await action.run(
      () => client.suggestRunPullRequestDescription(runId, target, title),
      "Could not draft a description.",
    );
    if (suggestion) setDescription(suggestion);
  };

  const submit = async () => {
    const url = await action.run(
      () => client.createRunPullRequest(runId, target, title.trim(), undefined, description),
      "The pull request was not created.",
    );
    if (url) {
      onClose();
      await onDone(url);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Create pull request"
      dismissable={!action.busy}
      footer={
        <Button block busy={action.busy} disabled={!title.trim() || !target} onClick={() => void submit()}>
          Create pull request
        </Button>
      }
    >
      {optionsError && !options ? (
        <InlineError message={optionsError} onRetry={() => setReloadNonce((current) => current + 1)} />
      ) : !options ? (
        <CenteredSpinner label="Loading branches" />
      ) : (
        <div className="flex flex-col gap-3 px-4 py-3">
          {action.error ? <InlineError message={action.error} /> : null}

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">Target branch</span>
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              className="m-tap w-full rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-3 text-[var(--ec-text)]"
            >
              {options.targetBranches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">Title</span>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">Description</span>
            <Textarea rows={6} value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>

          <Button tone="neutral" size="sm" busy={action.busy} onClick={() => void generate()}>
            <Sparkles className="size-4" />
            Draft with the run model
          </Button>
        </div>
      )}
    </Sheet>
  );
};
