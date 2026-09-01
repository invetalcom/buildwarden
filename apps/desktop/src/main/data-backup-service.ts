import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import tar from "tar-stream";
import { BUILDWARDEN_DATABASE_SCHEMA_VERSION, BuildWardenDatabase } from "@buildwarden/db";
import {
  APP_SETTING_KEYS,
  serializeWelcomeCompletedCheckIdsSetting,
  type DataBackupExportResult,
  type DataBackupImportSelection,
} from "@buildwarden/shared";

const ARCHIVE_MAGIC = Buffer.from("BWARDEN_BACKUP_V1\n", "ascii");
const AUTH_TAG_LENGTH = 16;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 100 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 200_000;
const MIN_PASSWORD_LENGTH = 8;
const MANAGED_ARTIFACT_DIRECTORIES = ["folder-run-snapshots", "loop-ui-reviews", "orchestrations"] as const;

type ArchiveHeader = {
  formatVersion: 1;
  createdAt: string;
  appVersion: string;
  cipher: "aes-256-gcm";
  kdf: {
    name: "scrypt";
    saltBase64: string;
    cost: number;
    blockSize: number;
    parallelization: number;
  };
  ivBase64: string;
};

type BackupManifest = {
  formatVersion: 1;
  createdAt: string;
  appVersion: string;
  databaseSchemaVersion: number;
  sourceDataDirectory: string;
  artifactDirectories: string[];
};

type PendingDataRestore = {
  version: 1;
  stagingDirectory: string;
  createdAt: string;
};

type PendingDataRestoreMarkerOperations = {
  write(path: string, content: string): Promise<void>;
  move(source: string, destination: string): Promise<void>;
};

const defaultPendingDataRestoreMarkerOperations: PendingDataRestoreMarkerOperations = {
  write: (path, content) => writeFile(path, content, { encoding: "utf8", mode: 0o600 }),
  move: rename,
};

export interface DataBackupServiceOptions {
  database: BuildWardenDatabase;
  secretStore: {
    exportSecrets(): Promise<Record<string, string>>;
    writeEncryptedCopy(targetFilePath: string, secrets: Readonly<Record<string, string>>): Promise<void>;
  };
  dataDirectory: string;
  appVersion: string;
}

const assertPassword = (password: string): void => {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Backup passwords must contain at least ${String(MIN_PASSWORD_LENGTH)} characters.`);
  }
  if (password.length > 1_024) {
    throw new Error("The backup password is too long.");
  }
};

const deriveKey = (
  password: string,
  salt: Buffer,
  parameters: ArchiveHeader["kdf"],
): Promise<Buffer> => new Promise((resolveKey, reject) => {
  scrypt(
    password,
    salt,
    32,
    {
      N: parameters.cost,
      r: parameters.blockSize,
      p: parameters.parallelization,
      maxmem: 128 * 1024 * 1024,
    },
    (error, key) => error ? reject(error) : resolveKey(key),
  );
});

const encodeArchivePrefix = (header: ArchiveHeader): Buffer => {
  const headerBuffer = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBuffer.length > MAX_HEADER_BYTES) throw new Error("The backup header is too large.");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBuffer.length);
  return Buffer.concat([ARCHIVE_MAGIC, length, headerBuffer]);
};

const parseArchiveHeader = (value: unknown): ArchiveHeader => {
  if (!value || typeof value !== "object") throw new Error("The backup header is invalid.");
  const header = value as Partial<ArchiveHeader>;
  const kdf = header.kdf as Partial<ArchiveHeader["kdf"]> | undefined;
  if (
    header.formatVersion !== 1 ||
    typeof header.createdAt !== "string" ||
    typeof header.appVersion !== "string" ||
    header.cipher !== "aes-256-gcm" ||
    header.kdf?.name !== "scrypt" ||
    typeof kdf?.saltBase64 !== "string" ||
    kdf.cost !== 32_768 ||
    kdf.blockSize !== 8 ||
    kdf.parallelization !== 1 ||
    typeof header.ivBase64 !== "string"
  ) {
    throw new Error("This is not a supported BuildWarden backup.");
  }
  return header as ArchiveHeader;
};

const readArchiveHeader = async (filePath: string): Promise<{
  header: ArchiveHeader;
  prefix: Buffer;
  cipherStart: number;
  cipherEnd: number;
  authTag: Buffer;
}> => {
  const archiveStats = await stat(filePath);
  if (!archiveStats.isFile() || archiveStats.size > MAX_ARCHIVE_BYTES) {
    throw new Error("The selected backup is not a supported file size.");
  }
  const handle = await open(filePath, "r");
  try {
    const leading = Buffer.alloc(ARCHIVE_MAGIC.length + 4);
    const leadingRead = await handle.read(leading, 0, leading.length, 0);
    if (leadingRead.bytesRead !== leading.length || !leading.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)) {
      throw new Error("This is not a BuildWarden backup.");
    }
    const headerLength = leading.readUInt32BE(ARCHIVE_MAGIC.length);
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) throw new Error("The backup header is invalid.");
    const headerBuffer = Buffer.alloc(headerLength);
    const headerRead = await handle.read(headerBuffer, 0, headerLength, leading.length);
    if (headerRead.bytesRead !== headerLength) throw new Error("The backup file is incomplete.");
    const prefix = Buffer.concat([leading, headerBuffer]);
    const cipherStart = prefix.length;
    const cipherEnd = archiveStats.size - AUTH_TAG_LENGTH - 1;
    if (cipherEnd < cipherStart) throw new Error("The backup file is incomplete.");
    const authTag = Buffer.alloc(AUTH_TAG_LENGTH);
    const tagRead = await handle.read(authTag, 0, authTag.length, archiveStats.size - AUTH_TAG_LENGTH);
    if (tagRead.bytesRead !== AUTH_TAG_LENGTH) throw new Error("The backup authentication tag is missing.");
    return {
      header: parseArchiveHeader(JSON.parse(headerBuffer.toString("utf8"))),
      prefix,
      cipherStart,
      cipherEnd,
      authTag,
    };
  } finally {
    await handle.close();
  }
};

const addBufferEntry = (pack: tar.Pack, name: string, content: Buffer): Promise<void> =>
  new Promise((resolveEntry, reject) => {
    pack.entry({ name, size: content.length, mode: 0o600 }, content, (error) => {
      if (error) reject(error);
      else resolveEntry();
    });
  });

const addFileEntry = async (pack: tar.Pack, sourcePath: string, archivePath: string): Promise<void> => {
  const sourceStats = await stat(sourcePath);
  const entry = pack.entry({ name: archivePath, size: sourceStats.size, mode: sourceStats.mode & 0o777 });
  await pipeline(createReadStream(sourcePath), entry);
};

const addDirectoryFiles = async (pack: tar.Pack, sourceRoot: string, archiveRoot: string): Promise<void> => {
  const visit = async (directoryPath: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = join(directoryPath, entry.name);
      const relativePath = relativeDirectory ? posix.join(relativeDirectory, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await visit(sourcePath, relativePath);
      } else if (entry.isFile()) {
        await addFileEntry(pack, sourcePath, posix.join(archiveRoot, relativePath));
      }
    }
  };
  await visit(sourceRoot, "");
};

const allowedArchiveEntry = (name: string): boolean => {
  if (name === "manifest.json" || name === "database.sqlite" || name === "secrets.json") return true;
  return MANAGED_ARTIFACT_DIRECTORIES.some((directory) => name.startsWith(`artifacts/${directory}/`));
};

const safeExtractionPath = (root: string, archivePath: string): string => {
  const normalized = posix.normalize(archivePath.replaceAll("\\", "/"));
  if (
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    !allowedArchiveEntry(normalized)
  ) {
    throw new Error("The backup contains an unsafe or unsupported path.");
  }
  const target = resolve(root, ...normalized.split("/"));
  const resolvedRoot = resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error("The backup contains an unsafe path.");
  }
  return target;
};

const parseManifest = (value: unknown): BackupManifest => {
  if (!value || typeof value !== "object") throw new Error("The backup manifest is invalid.");
  const manifest = value as Partial<BackupManifest>;
  if (
    manifest.formatVersion !== 1 ||
    typeof manifest.createdAt !== "string" ||
    typeof manifest.appVersion !== "string" ||
    typeof manifest.databaseSchemaVersion !== "number" ||
    typeof manifest.sourceDataDirectory !== "string" ||
    !Array.isArray(manifest.artifactDirectories) ||
    !manifest.artifactDirectories.every((entry) => typeof entry === "string")
  ) {
    throw new Error("The backup manifest is invalid.");
  }
  return manifest as BackupManifest;
};

const parseSecrets = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The backup secrets are invalid.");
  const entries = Object.entries(value);
  if (!entries.every(([key, secret]) => key.length > 0 && typeof secret === "string")) {
    throw new Error("The backup secrets are invalid.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
};

const validateDatabase = (databasePath: string): number => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = database.prepare("pragma integrity_check").all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error("The backup database failed its integrity check.");
    }
    const foreignKeyErrors = database.prepare("pragma foreign_key_check").all();
    if (foreignKeyErrors.length > 0) throw new Error("The backup database contains invalid relationships.");
    const requiredTables = new Set(["projects", "provider_accounts", "models", "runs", "run_steps", "chats", "chat_steps", "app_settings"]);
    const tables = database.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>;
    for (const table of tables) requiredTables.delete(table.name);
    if (requiredTables.size > 0) throw new Error("The backup database is missing required tables.");
    const version = (database.prepare("pragma user_version").get() as { user_version: number }).user_version;
    if (version > BUILDWARDEN_DATABASE_SCHEMA_VERSION) {
      throw new Error("This backup was created by a newer BuildWarden database version.");
    }
    return version;
  } finally {
    database.close();
  }
};

export class DataBackupService {
  constructor(private readonly options: DataBackupServiceOptions) {}

  async inspect(filePath: string): Promise<DataBackupImportSelection> {
    const { header } = await readArchiveHeader(filePath);
    return { filePath, createdAt: header.createdAt, appVersion: header.appVersion };
  }

  async exportTo(filePath: string, password: string): Promise<DataBackupExportResult> {
    assertPassword(password);
    const stagingDirectory = await mkdtemp(join(this.options.dataDirectory, "backup-export-"));
    const snapshotPath = join(stagingDirectory, "database.sqlite");
    const temporaryOutputPath = `${filePath}.tmp-${randomBytes(6).toString("hex")}`;
    const createdAt = new Date().toISOString();
    try {
      this.options.database.createPortableSnapshot(snapshotPath);
      const secrets = await this.options.secretStore.exportSecrets();
      const artifactDirectories = MANAGED_ARTIFACT_DIRECTORIES.filter((directory) =>
        existsSync(join(this.options.dataDirectory, directory)));
      const manifest: BackupManifest = {
        formatVersion: 1,
        createdAt,
        appVersion: this.options.appVersion,
        databaseSchemaVersion: BUILDWARDEN_DATABASE_SCHEMA_VERSION,
        sourceDataDirectory: this.options.dataDirectory,
        artifactDirectories: [...artifactDirectories],
      };

      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const header: ArchiveHeader = {
        formatVersion: 1,
        createdAt,
        appVersion: this.options.appVersion,
        cipher: "aes-256-gcm",
        kdf: {
          name: "scrypt",
          saltBase64: salt.toString("base64"),
          cost: 32_768,
          blockSize: 8,
          parallelization: 1,
        },
        ivBase64: iv.toString("base64"),
      };
      const prefix = encodeArchivePrefix(header);
      const key = await deriveKey(password, salt, header.kdf);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(prefix);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(temporaryOutputPath, prefix, { mode: 0o600 });

      const pack = tar.pack();
      const archivePipeline = pipeline(
        pack,
        createGzip({ level: 6 }),
        cipher,
        createWriteStream(temporaryOutputPath, { flags: "a", mode: 0o600 }),
      );
      try {
        await addBufferEntry(pack, "manifest.json", Buffer.from(JSON.stringify(manifest), "utf8"));
        await addFileEntry(pack, snapshotPath, "database.sqlite");
        await addBufferEntry(pack, "secrets.json", Buffer.from(JSON.stringify(secrets), "utf8"));
        for (const directory of artifactDirectories) {
          await addDirectoryFiles(pack, join(this.options.dataDirectory, directory), `artifacts/${directory}`);
        }
        pack.finalize();
        await archivePipeline;
      } catch (error) {
        pack.destroy(error instanceof Error ? error : new Error(String(error)));
        await archivePipeline.catch(() => {});
        throw error;
      }
      await appendFile(temporaryOutputPath, cipher.getAuthTag());
      await rename(temporaryOutputPath, filePath);
      return { canceled: false, filePath, createdAt };
    } catch (error) {
      await rm(temporaryOutputPath, { force: true }).catch(() => {});
      throw error;
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }

  async stageImport(
    filePath: string,
    password: string,
    options: { skipWelcome?: boolean } = {},
  ): Promise<{ stagingDirectory: string; createdAt: string }> {
    assertPassword(password);
    const archive = await readArchiveHeader(filePath);
    const stagingDirectory = await mkdtemp(join(this.options.dataDirectory, "restore-staging-"));
    try {
      const key = await deriveKey(
        password,
        Buffer.from(archive.header.kdf.saltBase64, "base64"),
        archive.header.kdf,
      );
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(archive.header.ivBase64, "base64"),
      );
      decipher.setAAD(archive.prefix);
      decipher.setAuthTag(archive.authTag);

      let fileCount = 0;
      let extractedBytes = 0;
      const extract = tar.extract();
      extract.on("entry", (entryHeader, stream, next) => {
        void (async () => {
          fileCount += 1;
          extractedBytes += entryHeader.size ?? 0;
          if (fileCount > MAX_ARCHIVE_FILES || extractedBytes > MAX_EXTRACTED_BYTES) {
            throw new Error("The backup expands beyond the supported size limit.");
          }
          if (entryHeader.type !== "file") {
            stream.resume();
            next();
            return;
          }
          const targetPath = safeExtractionPath(stagingDirectory, entryHeader.name);
          await mkdir(dirname(targetPath), { recursive: true });
          await pipeline(stream, createWriteStream(targetPath, { flags: "wx", mode: 0o600 }));
          next();
        })().catch((error) => extract.destroy(error instanceof Error ? error : new Error(String(error))));
      });

      try {
        await pipeline(
          createReadStream(filePath, { start: archive.cipherStart, end: archive.cipherEnd }),
          decipher,
          createGunzip(),
          extract,
        );
      } catch (error) {
        if (error instanceof Error && /auth|authenticate|bad decrypt/i.test(error.message)) {
          throw new Error("The backup password is incorrect or the backup file is damaged.");
        }
        throw error;
      }

      const manifest = parseManifest(JSON.parse(await readFile(join(stagingDirectory, "manifest.json"), "utf8")));
      if (manifest.databaseSchemaVersion > BUILDWARDEN_DATABASE_SCHEMA_VERSION) {
        throw new Error("This backup was created by a newer BuildWarden version.");
      }
      const databasePath = join(stagingDirectory, "database.sqlite");
      validateDatabase(databasePath);
      const stagedDatabase = new BuildWardenDatabase(databasePath);
      await stagedDatabase.init();
      try {
        stagedDatabase.rebaseManagedArtifactPaths(manifest.sourceDataDirectory, this.options.dataDirectory);
        if (options.skipWelcome) {
          stagedDatabase.setSetting(
            APP_SETTING_KEYS.welcomeCompletedCheckIds,
            serializeWelcomeCompletedCheckIdsSetting(["provider-models", "project"]),
          );
        }
      } finally {
        await stagedDatabase.close();
      }
      validateDatabase(databasePath);

      const secrets = parseSecrets(JSON.parse(await readFile(join(stagingDirectory, "secrets.json"), "utf8")));
      await this.options.secretStore.writeEncryptedCopy(join(stagingDirectory, "restored-secrets.json"), secrets);
      await rm(join(stagingDirectory, "secrets.json"), { force: true });
      return { stagingDirectory, createdAt: manifest.createdAt };
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }
}

export const writePendingDataRestore = async (
  markerPath: string,
  stagingDirectory: string,
  operations: PendingDataRestoreMarkerOperations = defaultPendingDataRestoreMarkerOperations,
): Promise<void> => {
  const marker: PendingDataRestore = { version: 1, stagingDirectory, createdAt: new Date().toISOString() };
  const temporaryMarkerPath = `${markerPath}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    await operations.write(temporaryMarkerPath, JSON.stringify(marker));
    await operations.move(temporaryMarkerPath, markerPath);
  } catch (error) {
    await rm(temporaryMarkerPath, { force: true }).catch(() => {});
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
};

const moveIfExists = async (source: string, destination: string): Promise<boolean> => {
  if (!existsSync(source)) return false;
  await mkdir(dirname(destination), { recursive: true });
  await rename(source, destination);
  return true;
};

const removeIfExists = async (targetPath: string): Promise<void> => {
  if (existsSync(targetPath)) await rm(targetPath, { recursive: true, force: true });
};

export const applyPendingDataRestore = async (input: {
  markerPath: string;
  dataDirectory: string;
  databaseFileName: string;
  secretsFileName: string;
}): Promise<boolean> => {
  if (!existsSync(input.markerPath)) return false;
  let parsedMarker: unknown;
  const serializedMarker = await readFile(input.markerPath, "utf8");
  try {
    parsedMarker = JSON.parse(serializedMarker) as unknown;
  } catch (error) {
    await rm(input.markerPath, { force: true });
    throw new Error("The pending data restore marker is invalid.", { cause: error });
  }
  if (parsedMarker === null || typeof parsedMarker !== "object" || Array.isArray(parsedMarker)) {
    await rm(input.markerPath, { force: true });
    throw new Error("The pending data restore marker is invalid.");
  }
  const marker = parsedMarker as Partial<PendingDataRestore>;
  if (marker.version !== 1 || typeof marker.stagingDirectory !== "string") {
    await rm(input.markerPath, { force: true });
    throw new Error("The pending data restore marker is invalid.");
  }
  const dataDirectory = resolve(input.dataDirectory);
  const stagingDirectory = resolve(marker.stagingDirectory);
  if (!stagingDirectory.startsWith(`${dataDirectory}${sep}`) || !existsSync(stagingDirectory)) {
    await rm(input.markerPath, { force: true });
    throw new Error("The pending data restore staging directory is unavailable.");
  }

  const rollbackDirectory = join(dataDirectory, `restore-rollback-${Date.now().toString(36)}`);
  const activeItems = [
    { active: join(dataDirectory, input.databaseFileName), staged: join(stagingDirectory, "database.sqlite"), name: input.databaseFileName },
    { active: join(dataDirectory, input.secretsFileName), staged: join(stagingDirectory, "restored-secrets.json"), name: input.secretsFileName },
    ...MANAGED_ARTIFACT_DIRECTORIES.map((name) => ({
      active: join(dataDirectory, name),
      staged: join(stagingDirectory, "artifacts", name),
      name,
    })),
  ];
  const sidecars = [`${input.databaseFileName}-wal`, `${input.databaseFileName}-shm`].map((name) => ({
    active: join(dataDirectory, name),
    staged: "",
    name,
  }));
  const movedOld: typeof activeItems = [];
  const activated: typeof activeItems = [];

  try {
    await mkdir(rollbackDirectory, { recursive: true });
    for (const item of [...activeItems, ...sidecars]) {
      if (await moveIfExists(item.active, join(rollbackDirectory, item.name))) movedOld.push(item);
    }
    for (const item of activeItems) {
      if (await moveIfExists(item.staged, item.active)) activated.push(item);
    }
    if (!existsSync(join(dataDirectory, input.databaseFileName)) || !existsSync(join(dataDirectory, input.secretsFileName))) {
      throw new Error("The staged restore is missing its database or secret store.");
    }
    await rm(input.markerPath, { force: true });
    await rm(stagingDirectory, { recursive: true, force: true });
    return true;
  } catch (error) {
    for (const item of activated.reverse()) await removeIfExists(item.active);
    for (const item of movedOld.reverse()) {
      await moveIfExists(join(rollbackDirectory, item.name), item.active).catch(() => false);
    }
    await rm(input.markerPath, { force: true });
    throw error;
  }
};
