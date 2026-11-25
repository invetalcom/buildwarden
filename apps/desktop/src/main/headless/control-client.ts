import { createConnection } from "node:net";
import { HostNotRunningError, type HostControlRequest, type HostControlResponse } from "./control-protocol";

const NOT_RUNNING_CODES = new Set(["ENOENT", "ECONNREFUSED", "ENOTDIR"]);

const exchange = (socketPath: string, message: string): Promise<string> => new Promise((resolve, reject) => {
  let received = "";
  const socket = createConnection(socketPath, () => socket.write(message));
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    received += chunk;
  });
  socket.on("end", () => resolve(received));
  socket.on("error", (error: NodeJS.ErrnoException) => reject(NOT_RUNNING_CODES.has(error.code ?? "")
    ? new HostNotRunningError("BuildWarden is not running for this data directory. Start it with `buildwarden serve`.")
    : error));
});

/** Sends a request to the headless host that owns the data directory. */
export const createHostControlClient = (socketPath: string): HostControlRequest => async (method, ...input) => {
  const received = await exchange(socketPath, `${JSON.stringify({ method, input: input[0] })}\n`);
  if (!received.trim()) throw new Error("BuildWarden closed the connection before it answered.");
  const response = JSON.parse(received) as HostControlResponse;
  if (!response.ok) throw new Error(response.error);
  return response.result as never;
};
