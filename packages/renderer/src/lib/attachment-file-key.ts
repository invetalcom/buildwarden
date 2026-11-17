// File metadata is not unique: two selected passages can share a name, size and timestamp.
// Object identity survives reordering/removal within a draft without retaining discarded files.
const keys = new WeakMap<File, string>();
let nextKey = 0;

export function attachmentFileKey(file: File): string {
  let key = keys.get(file);
  if (!key) {
    key = `attachment-${++nextKey}`;
    keys.set(file, key);
  }
  return key;
}
