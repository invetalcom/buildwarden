import { useState, type FormEvent } from "react";
import type {
  DataBackupExportResult,
  DataBackupImportInput,
  DataBackupImportSelection,
} from "@buildwarden/shared";
import { Download, Loader2, Upload } from "lucide-react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";

type BackupDialogState =
  | { mode: "export" }
  | { mode: "import"; selection: DataBackupImportSelection };

export interface DataBackupControlsProps {
  disabled: boolean;
  onExport: (password: string) => Promise<DataBackupExportResult>;
  onSelectImport: () => Promise<DataBackupImportSelection | null>;
  onImport: (input: DataBackupImportInput) => Promise<void>;
  presentation?: "settings" | "welcome";
  onImportComplete?: () => void;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const DataBackupControls = ({
  disabled,
  onExport,
  onSelectImport,
  onImport,
  presentation = "settings",
  onImportComplete,
}: DataBackupControlsProps) => {
  const [dialog, setDialog] = useState<BackupDialogState | null>(null);
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const closeDialog = (force = false): void => {
    if (busy && !force) return;
    setDialog(null);
    setPassword("");
    setPasswordConfirmation("");
    setError(null);
  };

  const openExport = (): void => {
    setNotice(null);
    setError(null);
    setPassword("");
    setPasswordConfirmation("");
    setDialog({ mode: "export" });
  };

  const chooseImport = async (): Promise<void> => {
    setSelecting(true);
    setNotice(null);
    setError(null);
    try {
      const selection = await onSelectImport();
      if (!selection) return;
      setPassword("");
      setPasswordConfirmation("");
      setDialog({ mode: "import", selection });
    } catch (selectionError) {
      setError(errorMessage(selectionError));
    } finally {
      setSelecting(false);
    }
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!dialog) return;
    if (password.length < 8) {
      setError("Use a password with at least 8 characters.");
      return;
    }
    if (dialog.mode === "export" && password !== passwordConfirmation) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (dialog.mode === "export") {
        const result = await onExport(password);
        if (!result.canceled) {
          setNotice(result.filePath ? `Backup exported to ${result.filePath}` : "Backup exported.");
        }
        closeDialog(true);
      } else {
        await onImport({
          filePath: dialog.selection.filePath,
          password,
          ...(presentation === "welcome" ? { skipWelcome: true } : {}),
        });
        onImportComplete?.();
      }
    } catch (operationError) {
      setError(errorMessage(operationError));
    } finally {
      setBusy(false);
    }
  };

  const dialogTitle = dialog?.mode === "export" ? "Protect exported data" : "Import BuildWarden data";
  const canSubmit = Boolean(dialog && password.length >= 8 && (dialog.mode === "import" || password === passwordConfirmation));

  return (
    <>
      <div className={presentation === "welcome" ? "" : "w-full md:max-w-[54rem]"}>
        <div className="flex flex-wrap justify-start gap-2 md:justify-end">
          {presentation === "settings" ? (
            <Button type="button" variant="secondary" size="sm" disabled={disabled || busy} onClick={openExport}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Export all data
            </Button>
          ) : null}
          <Button type="button" variant="secondary" size="sm" disabled={disabled || busy || selecting} onClick={() => void chooseImport()}>
            {selecting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}
            {presentation === "welcome" ? "Restore Backup" : "Import backup"}
          </Button>
        </div>
        {notice ? <p className="mt-2 break-all text-xs text-[var(--ec-success)] md:text-right">{notice}</p> : null}
        {!dialog && error ? <p className="mt-2 text-xs text-[var(--ec-danger)] md:text-right">{error}</p> : null}
      </div>

      {dialog ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="data-backup-dialog-title"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeDialog();
            }
          }}
        >
          <Card className="w-full max-w-lg !bg-[var(--ec-panel)] p-5 shadow-[var(--ec-popover-shadow)]">
            <p className="text-xs uppercase tracking-[0.25em] text-[var(--ec-muted)]">
              {dialog.mode === "export" ? "Encrypted backup" : "Restore backup"}
            </p>
            <h3 id="data-backup-dialog-title" className="mt-2 text-xl font-semibold text-[var(--ec-text)]">{dialogTitle}</h3>
            <p className="mt-3 text-sm leading-relaxed text-[var(--ec-muted)]">
              {dialog.mode === "export"
                ? "The backup contains chats, agent runs, settings, attachments, API keys, and Git hosting tokens. Source repositories and worktrees are not copied. Choose a password required to import it."
                : "Importing replaces the current BuildWarden data and restarts the app. A local rollback copy of the current data is retained."}
            </p>
            {dialog.mode === "import" ? (
              <div className="mt-3 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2 text-xs text-[var(--ec-muted)]">
                <p className="truncate font-medium text-[var(--ec-text)]" title={dialog.selection.filePath}>{dialog.selection.filePath}</p>
                <p className="mt-1">Created {new Date(dialog.selection.createdAt).toLocaleString()} with BuildWarden {dialog.selection.appVersion}</p>
              </div>
            ) : null}
            <form className="mt-4 space-y-3" onSubmit={(event) => void submit(event)}>
              <label className="block text-sm">
                <span className="mb-1 block text-[var(--ec-text)]">Backup password</span>
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoFocus
                  autoComplete="new-password"
                  disabled={busy}
                  placeholder="At least 8 characters"
                />
              </label>
              {dialog.mode === "export" ? (
                <label className="block text-sm">
                  <span className="mb-1 block text-[var(--ec-text)]">Confirm password</span>
                  <Input
                    type="password"
                    value={passwordConfirmation}
                    onChange={(event) => setPasswordConfirmation(event.target.value)}
                    autoComplete="new-password"
                    disabled={busy}
                  />
                </label>
              ) : null}
              {error ? <p className="text-xs text-[var(--ec-danger)]">{error}</p> : null}
              <div className="flex items-center justify-end gap-3 pt-2">
                <Button type="button" variant="outline" disabled={busy} onClick={() => closeDialog()}>Cancel</Button>
                <Button type="submit" variant={dialog.mode === "import" ? "danger" : "default"} disabled={busy || !canSubmit}>
                  {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  {dialog.mode === "export" ? "Choose export location" : "Import and restart"}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      ) : null}
    </>
  );
};
