import { useEffect, useMemo, useState } from "react";
import {
  APP_SETTING_KEYS,
  parseWelcomeCompletedCheckIdsSetting,
  serializeWelcomeCompletedCheckIdsSetting,
  type AppSnapshot,
  type DesktopApi,
} from "@buildwarden/shared";
import { useStableCallback } from "../../lib/use-stable-callback";
import { reportRendererError } from "../../lib/report-renderer-error";
import type { WelcomeStepKey } from "./WelcomeDialog";
import type { ProviderModelsOpenPanel } from "./settings-provider-models-tab";
import {
  WELCOME_CHECK_DEFINITIONS,
  getSatisfiedWelcomeCheckIds,
  orderWelcomeCheckIds,
  type WelcomeCheckId,
} from "./welcome-checks";

export interface WelcomeFlowDeps {
  buildwarden: DesktopApi | undefined;
  snapshot: AppSnapshot;
  snapshotLoaded: boolean;
  disabled?: boolean;
}

/**
 * Drives the first-run welcome dialog: which checks are still pending, which
 * step is shown, and persisting completed checks so the dialog stays dismissed
 * across restarts once everything is set up.
 */
export const useWelcomeFlow = ({ buildwarden, snapshot, snapshotLoaded, disabled = false }: WelcomeFlowDeps) => {
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [welcomeFinishedForSession, setWelcomeFinishedForSession] = useState(false);
  const [welcomeStepIndex, setWelcomeStepIndex] = useState(0);
  const [welcomeSkippedCheckIds, setWelcomeSkippedCheckIds] = useState<WelcomeCheckId[]>([]);
  const [welcomeProviderModelsOpenPanel, setWelcomeProviderModelsOpenPanel] =
    useState<ProviderModelsOpenPanel>("connection");

  const welcomeCompletedCheckIds = useMemo(
    () => orderWelcomeCheckIds(parseWelcomeCompletedCheckIdsSetting(snapshot.settings[APP_SETTING_KEYS.welcomeCompletedCheckIds])),
    [snapshot.settings],
  );
  const welcomeSatisfiedCheckIds = useMemo(() => getSatisfiedWelcomeCheckIds(snapshot), [snapshot]);
  const welcomeKnownCompletedCheckIds = useMemo(
    () => orderWelcomeCheckIds([...welcomeCompletedCheckIds, ...welcomeSatisfiedCheckIds]),
    [welcomeCompletedCheckIds, welcomeSatisfiedCheckIds],
  );
  const welcomeKnownCompletedSet = useMemo(() => new Set(welcomeKnownCompletedCheckIds), [welcomeKnownCompletedCheckIds]);
  const welcomePendingChecks = useMemo(
    () => WELCOME_CHECK_DEFINITIONS.filter((check) => !welcomeKnownCompletedSet.has(check.id)),
    [welcomeKnownCompletedSet],
  );
  const welcomeStepKeys = useMemo<WelcomeStepKey[]>(
    () => ["intro", ...welcomePendingChecks.map((check) => check.id), "done"],
    [welcomePendingChecks],
  );
  const welcomeStepKey = welcomeStepKeys[Math.min(welcomeStepIndex, welcomeStepKeys.length - 1)] ?? "intro";

  useEffect(() => {
    if (disabled || !buildwarden || !snapshotLoaded) {
      return;
    }
    const serializedCurrent = serializeWelcomeCompletedCheckIdsSetting(welcomeCompletedCheckIds);
    const serializedNext = serializeWelcomeCompletedCheckIdsSetting(welcomeKnownCompletedCheckIds);
    if (serializedCurrent === serializedNext) {
      return;
    }
    void buildwarden.setAppSetting(APP_SETTING_KEYS.welcomeCompletedCheckIds, serializedNext).catch((caught) => {
      reportRendererError("renderer.welcome.persist-completed-checks", caught);
    });
  }, [buildwarden, disabled, snapshotLoaded, welcomeCompletedCheckIds, welcomeKnownCompletedCheckIds]);

  useEffect(() => {
    if (disabled || !snapshotLoaded || welcomeFinishedForSession || welcomeOpen || welcomePendingChecks.length === 0) {
      return;
    }
    setWelcomeSkippedCheckIds([]);
    setWelcomeStepIndex(0);
    setWelcomeOpen(true);
  }, [disabled, snapshotLoaded, welcomeFinishedForSession, welcomeOpen, welcomePendingChecks.length]);

  useEffect(() => {
    if (welcomeStepIndex < welcomeStepKeys.length) {
      return;
    }
    setWelcomeStepIndex(Math.max(0, welcomeStepKeys.length - 1));
  }, [welcomeStepIndex, welcomeStepKeys.length]);

  useEffect(() => {
    if (snapshot.providerAccounts.length === 0) {
      setWelcomeProviderModelsOpenPanel("connection");
      return;
    }
    if (snapshot.models.length === 0) {
      setWelcomeProviderModelsOpenPanel("model");
    }
  }, [snapshot.models.length, snapshot.providerAccounts.length]);

  const handleWelcomeIntroNext = useStableCallback(() => {
    setWelcomeStepIndex((current) => Math.min(current + 1, welcomeStepKeys.length - 1));
  });
  const handleWelcomeBack = useStableCallback(() => {
    setWelcomeStepIndex((current) => Math.max(0, current - 1));
  });
  const handleWelcomeSkipCheck = useStableCallback((checkId: WelcomeCheckId) => {
    setWelcomeSkippedCheckIds((current) => (current.includes(checkId) ? current : [...current, checkId]));
    setWelcomeStepIndex((current) => Math.min(current + 1, welcomeStepKeys.length - 1));
  });
  const handleWelcomeFinish = useStableCallback(() => {
    setWelcomeOpen(false);
    setWelcomeFinishedForSession(true);
  });

  return {
    welcomeOpen,
    welcomeStepIndex,
    welcomeStepKey,
    welcomeStepKeys,
    welcomeKnownCompletedCheckIds,
    welcomeSkippedCheckIds,
    welcomeProviderModelsOpenPanel,
    setWelcomeProviderModelsOpenPanel,
    handleWelcomeIntroNext,
    handleWelcomeBack,
    handleWelcomeSkipCheck,
    handleWelcomeFinish,
  };
};
