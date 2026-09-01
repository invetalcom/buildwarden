import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WelcomeDialog, type WelcomeDialogProps } from "./WelcomeDialog";

const introProps = (): WelcomeDialogProps => ({
  stepKey: "intro",
  stepIndex: 0,
  steps: ["intro", "about", "provider-models", "project", "done"],
  completedCheckIds: [],
  skippedCheckIds: [],
  providerModelsProps: {} as WelcomeDialogProps["providerModelsProps"],
  providerModelsOpenPanel: "connection",
  projectSetupProps: {} as WelcomeDialogProps["projectSetupProps"],
  onProviderModelsOpenPanelChange: vi.fn(),
  onBack: vi.fn(),
  onNext: vi.fn(),
  onSkipCheck: vi.fn(),
  onFinish: vi.fn(),
});

describe("WelcomeDialog backup controls", () => {
  it("does not render restore controls when native backup actions are unavailable", () => {
    const markup = renderToStaticMarkup(<WelcomeDialog {...introProps()} />);

    expect(markup).not.toContain("Restore Backup");
    expect(markup).toContain("Get started");
  });

  it("renders restore controls when native backup actions are available", () => {
    const markup = renderToStaticMarkup(
      <WelcomeDialog
        {...introProps()}
        dataBackupProps={{
          disabled: false,
          onExport: vi.fn(async () => ({ canceled: true })),
          onSelectImport: vi.fn(async () => null),
          onImport: vi.fn(async () => undefined),
        }}
      />,
    );

    expect(markup).toContain("Restore Backup");
  });
});
