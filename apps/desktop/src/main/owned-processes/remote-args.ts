import {
  isManageOwnedProcessesInput,
  isOwnedProcessOwner,
  type ManageOwnedProcessesInput,
  type OwnedProcessOwner,
  type OwnedProcessOwnerKind,
} from "@buildwarden/shared";

const MAX_PROCESS_ID_LENGTH = 128;

export const isOwnedProcessesRemoteArgs = (args: unknown[]): args is [OwnedProcessOwner] =>
  args.length === 1 && isOwnedProcessOwner(args[0]);

export const isOwnedProcessOutputRemoteArgs = (args: unknown[]): args is [OwnedProcessOwner, string] =>
  args.length === 2 && isOwnedProcessOwner(args[0]) &&
  typeof args[1] === "string" && args[1].length > 0 && args[1].length <= MAX_PROCESS_ID_LENGTH;

/**
 * Remote sessions manage run and chat processes through separate operations so each needs its
 * owner's operate scope; an input naming the other kind of owner is rejected.
 */
export const isManageOwnedProcessesRemoteArgs = (kind: OwnedProcessOwnerKind) =>
  (args: unknown[]): args is [ManageOwnedProcessesInput] =>
    args.length === 1 && isManageOwnedProcessesInput(args[0]) && args[0].owner.kind === kind &&
    (!("processId" in args[0]) || args[0].processId.length <= MAX_PROCESS_ID_LENGTH);
