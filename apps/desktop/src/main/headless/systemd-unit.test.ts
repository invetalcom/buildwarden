import { describe, expect, it } from "vitest";
import { buildSystemdUnit } from "./systemd-unit";

describe("buildSystemdUnit", () => {
  it("quotes the command and escapes what systemd would expand", () => {
    const unit = buildSystemdUnit({
      command: ["/opt/Build Warden/buildwarden", "--user-data-dir=/srv/50%/$HOME", "serve"],
      environment: { PATH: "/usr/bin:/home/user/.local/bin", BUILDWARDEN_SECRET_KEY_FILE: "/srv/50% key" },
    });
    expect(unit).toContain('ExecStart="/opt/Build Warden/buildwarden" "--user-data-dir=/srv/50%%/$$HOME" "serve"\n');
    expect(unit).toContain('Environment="PATH=/usr/bin:/home/user/.local/bin"\n');
    expect(unit).toContain('Environment="BUILDWARDEN_SECRET_KEY_FILE=/srv/50%% key"\n');
    expect(unit).toContain("Environment=BUILDWARDEN_SUPERVISED=1\n");
    expect(unit).toContain("RestartForceExitStatus=75\n");
  });

  it("rejects line breaks, which would start another directive", () => {
    expect(() => buildSystemdUnit({ command: ["/opt/x"], environment: { PATH: "/bin\nExecStartPre=/bin/false" } })).toThrow("line breaks");
  });
});
