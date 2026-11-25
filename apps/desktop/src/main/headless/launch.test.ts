import { describe, expect, it } from "vitest";
import { headlessRestartArgs, passThroughSwitches, resolveLaunch, serveArgs } from "./launch";

const packaged = (...args: string[]) => resolveLaunch(["/opt/BuildWarden/buildwarden", ...args], false);
const development = (...args: string[]) => resolveLaunch(["electron", ...args], true);

describe("resolveLaunch", () => {
  it.each([
    [[]],
    [["buildwarden://run/1"]],
    [["/home/user/file.txt"]],
    [["--no-sandbox", "--user-data-dir=/tmp/x"]],
  ])("opens the desktop app for %j", (args) => {
    expect(packaged(...args)).toEqual({ kind: "desktop" });
  });

  it("does not take the development app path for a command", () => {
    expect(development(".")).toEqual({ kind: "desktop" });
    expect(development("apps")).toEqual({ kind: "desktop" });
    expect(development("--no-sandbox", ".", "serve")).toEqual({ kind: "serve", port: null, runMissed: false });
  });

  it("reads the port and ignores Chromium switches around the command", () => {
    expect(packaged("--no-sandbox", "serve", "--port", "5000", "--disable-gpu")).toEqual({ kind: "serve", port: 5000, runMissed: false });
    expect(packaged(...serveArgs({ port: 5000, runMissed: true }))).toEqual({ kind: "serve", port: 5000, runMissed: true });
  });

  it("leaves malformed serve arguments and unknown words to the command line", () => {
    expect(packaged("serve", "--port", "0")).toEqual({ kind: "command", args: ["serve", "--port", "0"] });
    expect(packaged("statsu")).toEqual({ kind: "command", args: ["statsu"] });
    expect(packaged("--help")).toEqual({ kind: "command", args: ["help"] });
  });

  it("keeps command options and drops the data directory, which Electron reads", () => {
    expect(packaged("--user-data-dir=/srv/bw", "proxy", "set", "http://p:1", "--password-stdin"))
      .toEqual({ kind: "command", args: ["proxy", "set", "http://p:1", "--password-stdin"] });
  });
});

describe("headlessRestartArgs", () => {
  it("adds the switches once and keeps the original arguments", () => {
    const args = headlessRestartArgs(["buildwarden", "--no-sandbox", "serve"], "linux");
    expect(args).toEqual(["--ozone-platform=headless", "--disable-gpu", "--password-store=basic", "--no-sandbox", "serve"]);
    expect(headlessRestartArgs(["buildwarden", ...args!], "linux")).toBeNull();
  });

  it("respects a chosen display platform and other operating systems", () => {
    expect(headlessRestartArgs(["buildwarden", "--ozone-platform=x11", "serve"], "linux")).toBeNull();
    expect(headlessRestartArgs(["buildwarden", "serve"], "darwin")).toBeNull();
  });
});

describe("passThroughSwitches", () => {
  it("repeats only Chromium switches", () => {
    expect(passThroughSwitches(["buildwarden", "--no-sandbox", "--user-data-dir=/srv/bw", "service", "install", "--port", "1"]))
      .toEqual(["--no-sandbox", "--user-data-dir=/srv/bw"]);
  });
});
