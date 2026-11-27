export { AttentionInbox } from "./components/app/AttentionInbox";
export { App } from "./App";
export { useComposerDraft, type ComposerDraft } from "./lib/use-composer-draft";
export { ComposerDraftStatus } from "./components/app/ComposerDraftStatus";
export { InstanceContextProvider, InstanceBadge, InstanceTargetSelector, useInstanceContext, type InstanceContextValue, type InstanceSummary } from "./lib/instance-context";
export { scopedId, parseScopedId, mapEntityIds } from "./lib/instance-identity";
export { IncompleteHostSearchError } from "./lib/use-host-search";
export { DeepLinkNavigationContext, type ResolvedDeepLink } from "./lib/deep-links";
export { useResolveDeepLink } from "./lib/use-resolve-deep-link";
export { copyDeepLink } from "./lib/clipboard";
export { RemoteHostProjectDialog } from "./components/app/RemoteHostProjectDialog";
export { DesignSchemeEditor } from "./components/app/DesignSchemeEditor";
export { UsageChartLegend, UsageChartViewControl, UsageLineChart, UsageSeriesTable, UsageStackedBarChart, type UsageChartView } from "./components/app/UsageCharts";
export { WorkspaceSetupProfiles } from "./components/app/WorkspaceSetupProfiles";
export { Button } from "./components/ui/button";
export { Badge } from "./components/ui/badge";
export { LiveDot, LoadingBar, Spinner, StatusDot, type IndicatorRunState } from "./components/ui/motion";
export { ErrorNotification } from "./components/app/ErrorNotification";
export { ModalDialog } from "./components/ui/modal-dialog";
export { Input } from "./components/ui/input";
export { ColorInput } from "./components/ui/color-input";
export { Textarea } from "./components/ui/textarea";
export { Slider } from "./components/ui/slider";
export { applyDesignSchemeToDocument, designSchemeCssVariables, readCachedBrowserDesignScheme } from "./lib/design-scheme";
export { BuildWardenClientProvider, useBuildWardenClient } from "./lib/buildwarden-client";
export {
  createElectronBuildWardenClient,
  setActiveBuildWardenClient,
  type BuildWardenClient,
  type BuildWardenClientCapabilities,
} from "./lib/buildwarden-client-core";
export {
  createRemoteBuildWardenClient,
  remoteDraftScope,
  isRemoteBrowserSetting,
  readRemoteUiSettings,
  RemoteSessionExpiredError,
  type RemoteBuildWardenClientOptions,
} from "./lib/remote-buildwarden-client";

export { RunVerificationPanel } from "./components/app/RunVerificationPanel";
export { RunEmbeddedBrowser } from "./components/app/RunEmbeddedBrowser";
export { RunBrowserPreviewTile } from "./components/app/RunBrowserPreviewTile";
export { BrowserElementAttachmentPreview } from "./components/app/BrowserElementAttachmentPreview";
export { ToolResultImages } from "./components/app/ToolResultImages";
export { browserElementPayloadsForProvider, validateBrowserElementCaptureAddition } from "./lib/browser-element-attachments";

export { composerDraftStore } from "./lib/composer-draft-store";
export { FollowUpQueuePanel } from "./components/app/FollowUpQueuePanel";
export { useOwnedProcesses, useProcessClock, type OwnedProcessesState } from "./components/app/use-owned-processes";
export {
  buildProcessTree,
  describeProcessCommand,
  formatProcessCpu,
  formatProcessDuration,
  formatProcessMemory,
  localhostUrl,
  PROCESS_ROLE_LABELS,
  processStatusPresentation,
  summarizeProcesses,
  WORKSPACE_ATTRIBUTION_HINT,
  type ProcessTreeRow,
} from "./components/app/owned-processes-model";
export { describeFollowUpQueueNotice } from "./components/app/follow-up-queue-notice";
