import { DatabaseSync } from "node:sqlite";

/**
 * Makes a closed database file look like one an earlier build left behind, so the next open runs
 * the schema migrations again. Tests that write legacy data into a file this build created need it:
 * the migrations are skipped for a file whose schema signature matches the running build.
 */
export const markDatabaseAsEarlierBuild = (path: string): void => {
  const raw = new DatabaseSync(path);
  try {
    raw.exec("drop table if exists schema_state");
  } finally {
    raw.close();
  }
};
