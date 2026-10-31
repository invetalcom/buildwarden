// Usage: node scripts/benchmark-packaged-startup.mjs path/to/BuildWarden.exe
// Measures bootstrap-to-ready in the actual packaged archive, with fresh profiles.
// Inspector attachment time and OS process creation are excluded. No production files change.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executable = resolve(process.argv[2] ?? "apps/desktop/release/win-unpacked/BuildWarden.exe");
const root = mkdtempSync(join(tmpdir(), "bw-benchmark-"));
console.log(`Isolated profiles retained at ${root}`);

async function measure(label, profile, disabled) {
  mkdirSync(profile, { recursive: true });
  const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_COMPILE_CACHE;
  if (disabled) env.NODE_DISABLE_COMPILE_CACHE = "1";
  else delete env.NODE_DISABLE_COMPILE_CACHE;
  const child = spawn(executable, ["--inspect-brk=127.0.0.1:0"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let socket;
  let output = "";
  let connecting = false;
  let result;
  let failure;
  const deadline = setTimeout(() => { failure = new Error(`Startup timed out: ${output.slice(-1500)}`); child.kill(); }, 30000);
  const exited = new Promise((done) => child.once("close", done));
  child.once("error", (error) => { failure = error; });
  child.stderr.on("data", async (chunk) => {
    output += chunk;
    const measured = output.match(/BW_STARTUP_RESULT (\{[^\r\n]+\})/);
    if (measured) result = JSON.parse(measured[1]);
    const url = output.match(/ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/)?.[0];
    if (!url || connecting) return;
    connecting = true;
    try {
      socket = new WebSocket(url);
      let sequence = 0;
      const pending = new Map();
      const send = (method, params = {}) => new Promise((done) => {
        pending.set(++sequence, done);
        socket.send(JSON.stringify({ id: sequence, method, params }));
      });
      let breakpoint;
      socket.onmessage = async ({ data }) => {
        const message = JSON.parse(data);
        if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); return; }
        if (message.method !== "Debugger.paused") return;
        if (!message.params.hitBreakpoints?.includes(breakpoint)) { await send("Debugger.resume"); return; }
        const setup = await send("Debugger.evaluateOnCallFrame", {
          callFrameId: message.params.callFrames[0].callFrameId,
          expression: `(() => {
            const require = process.getBuiltinModule('module').createRequire(${JSON.stringify(executable)});
            const { app, BrowserWindow } = require('electron');
            app.setPath('userData', ${JSON.stringify(profile)});
            BrowserWindow.prototype.show = function() {};
            const started = performance.now(); let readyMs;
            app.once('ready', () => { readyMs = performance.now() - started; });
            app.once('browser-window-created', (_event, window) => {
              window.once('ready-to-show', () => {
                console.error('BW_STARTUP_RESULT ' + JSON.stringify({readyMs, windowMs: performance.now() - started, packaged: app.isPackaged}));
                app.quit();
              });
            });
          })()`,
        });
        if (setup.error || setup.result?.exceptionDetails) {
          failure = new Error(JSON.stringify(setup)); child.kill(); return;
        }
        await send("Debugger.resume");
        socket.close();
      };
      await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
      await send("Debugger.enable");
      const response = await send("Debugger.setBreakpointByUrl", { urlRegex: "[/\\\\]out[/\\\\]main[/\\\\]bootstrap\\.js$", lineNumber: 0 });
      breakpoint = response.result?.breakpointId;
      await send("Runtime.runIfWaitingForDebugger");
    } catch (error) { failure = error; child.kill(); }
  });
  const code = await exited;
  clearTimeout(deadline);
  socket?.close();
  if (failure) throw failure;
  if (code !== 0 || !result) throw new Error(`No startup result (${code}): ${output.slice(-2000)}`);
  console.log(JSON.stringify({ label, ...result }));
}

await measure("disabled", join(root, "disabled"), true);
await measure("disabled-warm-profile", join(root, "disabled"), true);
await measure("cold", join(root, "cached"), false);
await measure("warm", join(root, "cached"), false);
