import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import cors from "@fastify/cors";
import {
  parseCapsuleManifest,
  parseCreateCapsuleInput,
  type CapsuleManifest,
  type CapsuleTemplateId
} from "@malleable/capsule-schema";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { lookup as lookupMime } from "mime-types";
import { rolldown } from "rolldown";

import { CapsuleDevHost } from "./capsule-dev-host.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(currentDir, "../../..");
const realmsRoot = path.join(workspaceRoot, "realms");
const templatesRoot = path.join(workspaceRoot, "templates", "capsules");
const capsuleStateRuntimeSourcePath = path.join(
  workspaceRoot,
  "packages",
  "capsule-state",
  "src",
  "index.ts"
);
const port = Number(process.env.DAEMON_PORT ?? 4877);

type CapsuleRecord = {
  manifest: CapsuleManifest;
  realmId: string;
  capsulePath: string;
  sourcePath: string;
  launchUrl: string;
};

type CapsuleSession = {
  capsuleId: string;
  realmId: string;
};

type StateRecordRow = {
  id: string;
  value: string;
};

type StateValueRow = {
  value: string;
};

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const capsuleSessions = new Map<string, CapsuleSession>();
const capsuleDevHost = new CapsuleDevHost(workspaceRoot);

const capsuleTemplates: Record<
  CapsuleTemplateId,
  {
    readonly defaultDescription: string;
    readonly entry: CapsuleManifest["entry"];
    readonly path: string;
  }
> = {
  "basic-static": {
    defaultDescription: "A local static capsule created from a template.",
    entry: {
      path: "public/index.html",
      type: "static"
    },
    path: path.join(templatesRoot, "basic-static")
  },
  "web-react": {
    defaultDescription: "A local React capsule created from a native TypeScript template.",
    entry: {
      framework: "react",
      main: "src/main.tsx",
      reload: "prompt",
      type: "web"
    },
    path: path.join(templatesRoot, "web-react")
  },
  "web-vanilla": {
    defaultDescription: "A local TypeScript capsule created from a native web template.",
    entry: {
      framework: "vanilla",
      main: "src/main.ts",
      reload: "prompt",
      type: "web"
    },
    path: path.join(templatesRoot, "web-vanilla")
  }
};

function safeSegment(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(`Invalid path segment: ${value}`);
  }

  return value;
}

function safeStateKey(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid state key: ${value}`);
  }

  return value;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");

  return slug || "capsule";
}

function timestampSegment(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

async function readManifest(capsulePath: string): Promise<CapsuleManifest> {
  const raw = await readFile(path.join(capsulePath, "capsule.json"), "utf8");
  return parseCapsuleManifest(JSON.parse(raw));
}

async function rewriteTemplatePlaceholders(
  targetPath: string,
  replacements: Readonly<Record<string, string>>
): Promise<void> {
  const entries = await readdir(targetPath, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(targetPath, entry.name);
      if (entry.isDirectory()) {
        await rewriteTemplatePlaceholders(entryPath, replacements);
        return;
      }

      if (!entry.isFile()) {
        return;
      }

      const extension = path.extname(entry.name);
      if (![".css", ".html", ".js", ".json", ".ts", ".tsx"].includes(extension)) {
        return;
      }

      const source = await readFile(entryPath, "utf8");
      let next = source;
      for (const [placeholder, replacement] of Object.entries(replacements)) {
        next = next.replaceAll(placeholder, replacement);
      }

      if (next !== source) {
        await writeFile(entryPath, next);
      }
    })
  );
}

async function bundleCapsuleStateRuntime(): Promise<string | undefined> {
  const bundle = await rolldown({
    input: capsuleStateRuntimeSourcePath,
    logLevel: "silent",
    platform: "browser"
  }).catch(() => undefined);
  if (!bundle) {
    return undefined;
  }

  try {
    const result = await bundle.generate({
      entryFileNames: "state.js",
      format: "esm"
    });
    const output = result.output.find((item) => item.type === "chunk");

    return output?.type === "chunk" ? output.code : undefined;
  } finally {
    await bundle.close();
  }
}

async function listRealms() {
  const entries = await readdir(realmsRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ id: entry.name, path: path.join(realmsRoot, entry.name) }));
}

async function listCapsules(realmId: string): Promise<CapsuleRecord[]> {
  const realm = safeSegment(realmId);
  const capsulesRoot = path.join(realmsRoot, realm, "capsules");
  const entries = await readdir(capsulesRoot, { withFileTypes: true }).catch(() => []);
  const records: CapsuleRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const capsulePath = path.join(capsulesRoot, entry.name);
    const manifest = await readManifest(capsulePath).catch(() => undefined);
    if (!manifest) {
      continue;
    }

    records.push({
      manifest,
      realmId: realm,
      capsulePath,
      sourcePath:
        manifest.entry.type === "web"
          ? path.join(capsulePath, "src")
          : path.join(capsulePath, manifest.entry.path),
      launchUrl: `/capsules/${realm}/${manifest.id}/`
    });
  }

  return records;
}

async function nextCapsuleId(realmId: string, preferredId: string): Promise<string> {
  const existing = new Set((await listCapsules(realmId)).map((capsule) => capsule.manifest.id));
  if (!existing.has(preferredId)) {
    return preferredId;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${preferredId}-${index}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not create unique capsule id");
}

async function findCapsule(realmId: string, capsuleId: string): Promise<CapsuleRecord | undefined> {
  const capsules = await listCapsules(realmId);
  return capsules.find((capsule) => capsule.manifest.id === capsuleId);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(value: unknown): Record<string, unknown> | undefined {
  return isJsonObject(value) ? value : undefined;
}

function readStringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing string field: ${key}`);
  }

  return value;
}

function parseRecordRow(row: Record<string, unknown>): StateRecordRow {
  const id = row.id;
  const value = row.value;
  if (typeof id !== "string" || typeof value !== "string") {
    throw new Error("Invalid state record row");
  }

  return { id, value };
}

function parseValueRow(row: Record<string, unknown> | undefined): StateValueRow | undefined {
  if (!row) {
    return undefined;
  }

  const value = row.value;
  if (typeof value !== "string") {
    throw new Error("Invalid state value row");
  }

  return { value };
}

function parseStoredJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function serializeStoredJson(value: unknown): string {
  return JSON.stringify(value);
}

async function openStateDatabase(capsule: CapsuleRecord): Promise<DatabaseSync> {
  const dataPath = path.join(capsule.capsulePath, "data");
  await mkdir(dataPath, { recursive: true });

  const database = new DatabaseSync(path.join(dataPath, "state.sqlite"), {
    timeout: 5000
  });
  database.exec(`
    CREATE TABLE IF NOT EXISTS records (
      store TEXT NOT NULL,
      id TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL,
      PRIMARY KEY (store, id)
    );

    CREATE TABLE IF NOT EXISTS values_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
  `);

  return database;
}

async function withStateDatabase<TValue>(
  capsule: CapsuleRecord,
  read: (database: DatabaseSync) => TValue
): Promise<TValue> {
  const database = await openStateDatabase(capsule);
  try {
    return read(database);
  } finally {
    database.close();
  }
}

function readBearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  return authorization.slice("Bearer ".length);
}

async function authorizeStateRequest(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<CapsuleRecord | undefined> {
  const token = readBearerToken(request);
  const session = token ? capsuleSessions.get(token) : undefined;
  if (!session) {
    await reply.code(401).send({ error: "Capsule state token is invalid" });
    return undefined;
  }

  const capsule = await findCapsule(session.realmId, session.capsuleId);
  if (!capsule) {
    await reply.code(404).send({ error: "Capsule not found" });
    return undefined;
  }

  if (!capsule.manifest.capabilities.storage.includes("own-data")) {
    await reply.code(403).send({ error: "Capsule has not declared own-data storage" });
    return undefined;
  }

  return capsule;
}

function createLaunchToken(capsule: CapsuleRecord): string {
  const token = randomUUID();
  capsuleSessions.set(token, {
    capsuleId: capsule.manifest.id,
    realmId: capsule.realmId
  });
  return token;
}

async function createCapsule(realmId: string, input: unknown): Promise<CapsuleRecord> {
  const realm = safeSegment(realmId);
  const parsed = parseCreateCapsuleInput(input);
  const template = capsuleTemplates[parsed.templateId];
  const capsuleId = await nextCapsuleId(realm, parsed.id ?? slugify(parsed.name));
  const capsulesRoot = path.join(realmsRoot, realm, "capsules");
  const capsulePath = path.join(capsulesRoot, capsuleId);
  const dataPath = path.join(capsulePath, "data");
  const description = parsed.description?.trim() || template.defaultDescription;
  const manifest: CapsuleManifest = {
    capabilities: {
      commands: [],
      files: [],
      network: [],
      storage: ["own-data"]
    },
    description,
    entry: template.entry,
    id: capsuleId,
    name: parsed.name,
    version: "0.0.1"
  };
  await mkdir(capsulesRoot, { recursive: true });
  await cp(template.path, capsulePath, { errorOnExist: true, recursive: true });
  await mkdir(dataPath, { recursive: true });

  await writeFile(path.join(capsulePath, "capsule.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await rewriteTemplatePlaceholders(capsulePath, {
    __MALLEABLE_CAPSULE_DESCRIPTION_JSON__: JSON.stringify(description),
    __MALLEABLE_CAPSULE_NAME_JSON__: JSON.stringify(manifest.name),
    "{{CAPSULE_DESCRIPTION}}": escapeHtml(description),
    "{{CAPSULE_NAME}}": escapeHtml(manifest.name)
  });

  const capsule = await findCapsule(realm, capsuleId);
  if (!capsule) {
    throw new Error("Created capsule could not be loaded");
  }

  return capsule;
}

async function forkCapsule(realmId: string, capsuleId: string): Promise<CapsuleRecord> {
  const realm = safeSegment(realmId);
  const capsule = await findCapsule(realm, safeSegment(capsuleId));
  if (!capsule) {
    throw new Error("Capsule not found");
  }

  const forkId = await nextCapsuleId(realm, `${capsule.manifest.id}-copy`);
  const forkPath = path.join(realmsRoot, realm, "capsules", forkId);
  const forkManifest: CapsuleManifest = {
    ...capsule.manifest,
    description: capsule.manifest.description
      ? `Forked from ${capsule.manifest.name}. ${capsule.manifest.description}`
      : `Forked from ${capsule.manifest.name}.`,
    id: forkId,
    name: `${capsule.manifest.name} Copy`
  };

  await cp(capsule.capsulePath, forkPath, { errorOnExist: true, recursive: true });
  await writeFile(
    path.join(forkPath, "capsule.json"),
    `${JSON.stringify(forkManifest, null, 2)}\n`
  );

  const fork = await findCapsule(realm, forkId);
  if (!fork) {
    throw new Error("Forked capsule could not be loaded");
  }

  return fork;
}

async function archiveCapsule(realmId: string, capsuleId: string): Promise<string> {
  const realm = safeSegment(realmId);
  const capsule = await findCapsule(realm, safeSegment(capsuleId));
  if (!capsule) {
    throw new Error("Capsule not found");
  }

  const archiveRoot = path.join(realmsRoot, realm, "archive", "capsules");
  const archivePath = path.join(archiveRoot, `${capsule.manifest.id}-${timestampSegment()}`);

  await mkdir(archiveRoot, { recursive: true });
  await rename(capsule.capsulePath, archivePath);

  return archivePath;
}

async function deleteCapsule(realmId: string, capsuleId: string): Promise<void> {
  const realm = safeSegment(realmId);
  const capsule = await findCapsule(realm, safeSegment(capsuleId));
  if (!capsule) {
    throw new Error("Capsule not found");
  }

  await rm(capsule.capsulePath, { force: false, recursive: true });
}

function openPath(targetPath: string): void {
  if (process.platform === "win32") {
    spawn("explorer.exe", [targetPath], { detached: true, stdio: "ignore" }).unref();
    return;
  }

  if (process.platform === "darwin") {
    spawn("open", [targetPath], { detached: true, stdio: "ignore" }).unref();
    return;
  }

  spawn("xdg-open", [targetPath], { detached: true, stdio: "ignore" }).unref();
}

app.get("/api/health", async () => ({
  ok: true,
  workspaceRoot
}));

app.get("/capsule-runtime/state.js", async (_request, reply) => {
  const content = await bundleCapsuleStateRuntime();
  if (!content) {
    return reply.code(404).send("Capsule state runtime could not be bundled");
  }

  reply.header("Content-Type", "text/javascript; charset=utf-8");
  return reply.send(content);
});

app.get("/api/capsule-events", async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream"
  });
  reply.raw.write(": connected\n\n");

  const unsubscribe = capsuleDevHost.subscribe((status) => {
    reply.raw.write(`event: capsule\ndata: ${JSON.stringify(status)}\n\n`);
  });

  request.raw.on("close", unsubscribe);
});

app.get<{ Params: { storeName: string } }>(
  "/api/capsule-state/stores/:storeName/records",
  async (request, reply) => {
    const capsule = await authorizeStateRequest(request, reply);
    if (!capsule) {
      return undefined;
    }

    const storeName = safeStateKey(request.params.storeName);
    return await withStateDatabase(capsule, (database) => {
      const rows = database
        .prepare("SELECT id, value FROM records WHERE store = ? ORDER BY updated_at DESC")
        .all(storeName)
        .map(parseRecordRow);

      return {
        records: rows.map((row) => parseStoredJson(row.value))
      };
    });
  }
);

app.post<{ Body: unknown; Params: { storeName: string } }>(
  "/api/capsule-state/stores/:storeName/records",
  async (request, reply) => {
    const capsule = await authorizeStateRequest(request, reply);
    if (!capsule) {
      return undefined;
    }

    try {
      const storeName = safeStateKey(request.params.storeName);
      const body = readJsonObject(request.body);
      if (!body) {
        throw new Error("Record body must be an object");
      }

      const id = readStringField(body, "id");
      const record = body.record;
      const now = new Date().toISOString();

      return await withStateDatabase(capsule, (database) => {
        const existing = database
          .prepare("SELECT id FROM records WHERE store = ? AND id = ?")
          .get(storeName, id);
        if (existing) {
          return reply.code(409).send({ error: "Record already exists" });
        }

        database
          .prepare(
            "INSERT INTO records (store, id, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, 1)"
          )
          .run(storeName, id, serializeStoredJson(record), now, now);

        return {
          record
        };
      });
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not insert record"
      });
    }
  }
);

app.get<{ Params: { id: string; storeName: string } }>(
  "/api/capsule-state/stores/:storeName/records/:id",
  async (request, reply) => {
    const capsule = await authorizeStateRequest(request, reply);
    if (!capsule) {
      return undefined;
    }

    const storeName = safeStateKey(request.params.storeName);
    const id = request.params.id;
    return await withStateDatabase(capsule, (database) => {
      const row = database
        .prepare("SELECT id, value FROM records WHERE store = ? AND id = ?")
        .get(storeName, id);
      if (!row) {
        return {};
      }

      return {
        record: parseStoredJson(parseRecordRow(row).value)
      };
    });
  }
);

app.put<{ Body: unknown; Params: { id: string; storeName: string } }>(
  "/api/capsule-state/stores/:storeName/records/:id",
  async (request, reply) => {
    const capsule = await authorizeStateRequest(request, reply);
    if (!capsule) {
      return undefined;
    }

    try {
      const storeName = safeStateKey(request.params.storeName);
      const id = request.params.id;
      const body = readJsonObject(request.body);
      if (!body) {
        throw new Error("Record body must be an object");
      }

      const record = body.record;
      const now = new Date().toISOString();

      return await withStateDatabase(capsule, (database) => {
        database
          .prepare(
            `
            INSERT INTO records (store, id, value, created_at, updated_at, revision)
            VALUES (?, ?, ?, ?, ?, 1)
            ON CONFLICT(store, id) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at,
              revision = records.revision + 1
          `
          )
          .run(storeName, id, serializeStoredJson(record), now, now);

        return {
          record
        };
      });
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not upsert record"
      });
    }
  }
);

app.patch<{ Body: unknown; Params: { id: string; storeName: string } }>(
  "/api/capsule-state/stores/:storeName/records/:id",
  async (request, reply) => {
    const capsule = await authorizeStateRequest(request, reply);
    if (!capsule) {
      return undefined;
    }

    try {
      const storeName = safeStateKey(request.params.storeName);
      const id = request.params.id;
      const body = readJsonObject(request.body);
      if (!body) {
        throw new Error("Record body must be an object");
      }

      const record = body.record;
      const now = new Date().toISOString();

      return await withStateDatabase(capsule, (database) => {
        const result = database
          .prepare(
            "UPDATE records SET value = ?, updated_at = ?, revision = revision + 1 WHERE store = ? AND id = ?"
          )
          .run(serializeStoredJson(record), now, storeName, id);

        if (result.changes === 0) {
          return reply.code(404).send({ error: "Record not found" });
        }

        return {
          record
        };
      });
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not update record"
      });
    }
  }
);

app.delete<{ Params: { id: string; storeName: string } }>(
  "/api/capsule-state/stores/:storeName/records/:id",
  async (request, reply) => {
    const capsule = await authorizeStateRequest(request, reply);
    if (!capsule) {
      return undefined;
    }

    const storeName = safeStateKey(request.params.storeName);
    const id = request.params.id;
    return await withStateDatabase(capsule, (database) => {
      database.prepare("DELETE FROM records WHERE store = ? AND id = ?").run(storeName, id);

      return {
        deleted: true
      };
    });
  }
);

app.get<{ Params: { storeName: string } }>(
  "/api/capsule-state/stores/:storeName/value",
  async (request, reply) => {
    const capsule = await authorizeStateRequest(request, reply);
    if (!capsule) {
      return undefined;
    }

    const storeName = safeStateKey(request.params.storeName);
    return await withStateDatabase(capsule, (database) => {
      const row = parseValueRow(
        database.prepare("SELECT value FROM values_store WHERE key = ?").get(storeName)
      );
      if (!row) {
        return {};
      }

      return {
        value: parseStoredJson(row.value)
      };
    });
  }
);

app.put<{ Body: unknown; Params: { storeName: string } }>(
  "/api/capsule-state/stores/:storeName/value",
  async (request, reply) => {
    const capsule = await authorizeStateRequest(request, reply);
    if (!capsule) {
      return undefined;
    }

    try {
      const storeName = safeStateKey(request.params.storeName);
      const body = readJsonObject(request.body);
      if (!body) {
        throw new Error("Value body must be an object");
      }

      const nextValue = body.value;
      const now = new Date().toISOString();

      return await withStateDatabase(capsule, (database) => {
        database
          .prepare(
            `
            INSERT INTO values_store (key, value, updated_at, revision)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at,
              revision = values_store.revision + 1
          `
          )
          .run(storeName, serializeStoredJson(nextValue), now);

        return {
          value: nextValue
        };
      });
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not set value"
      });
    }
  }
);

app.get("/api/realms", async () => ({
  realms: await listRealms()
}));

app.get<{ Params: { realmId: string } }>("/api/realms/:realmId/capsules", async (request) => ({
  capsules: await listCapsules(request.params.realmId)
}));

app.post<{ Body: unknown; Params: { realmId: string } }>(
  "/api/realms/:realmId/capsules",
  async (request, reply) => {
    try {
      return { capsule: await createCapsule(request.params.realmId, request.body) };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not create capsule"
      });
    }
  }
);

app.get<{ Params: { realmId: string; capsuleId: string } }>(
  "/api/realms/:realmId/capsules/:capsuleId",
  async (request, reply) => {
    const capsule = await findCapsule(request.params.realmId, request.params.capsuleId);
    if (!capsule) {
      return reply.code(404).send({ error: "Capsule not found" });
    }
    return { capsule };
  }
);

app.post<{ Params: { realmId: string; capsuleId: string } }>(
  "/api/realms/:realmId/capsules/:capsuleId/fork",
  async (request, reply) => {
    try {
      return { capsule: await forkCapsule(request.params.realmId, request.params.capsuleId) };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not fork capsule"
      });
    }
  }
);

app.post<{ Params: { realmId: string; capsuleId: string } }>(
  "/api/realms/:realmId/capsules/:capsuleId/build",
  async (request, reply) => {
    const capsule = await findCapsule(request.params.realmId, request.params.capsuleId);
    if (!capsule) {
      return reply.code(404).send({ error: "Capsule not found" });
    }

    try {
      await capsuleDevHost.rebuild(capsule);
      return {
        built: true,
        status: capsuleDevHost.readStatus(capsule)
      };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not build capsule"
      });
    }
  }
);

app.post<{ Params: { realmId: string; capsuleId: string } }>(
  "/api/realms/:realmId/capsules/:capsuleId/launch",
  async (request, reply) => {
    const capsule = await findCapsule(request.params.realmId, request.params.capsuleId);
    if (!capsule) {
      return reply.code(404).send({ error: "Capsule not found" });
    }
    try {
      await capsuleDevHost.prepare(capsule);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not build capsule"
      });
    }

    const token = createLaunchToken(capsule);
    return {
      status: "running",
      url: `http://127.0.0.1:${port}${capsule.launchUrl}#malleableToken=${encodeURIComponent(token)}`
    };
  }
);

app.post<{ Params: { realmId: string; capsuleId: string } }>(
  "/api/realms/:realmId/capsules/:capsuleId/source/open",
  async (request, reply) => {
    const capsule = await findCapsule(request.params.realmId, request.params.capsuleId);
    if (!capsule) {
      return reply.code(404).send({ error: "Capsule not found" });
    }

    openPath(capsule.sourcePath);
    return { opened: true, path: capsule.sourcePath };
  }
);

app.post<{ Params: { realmId: string; capsuleId: string } }>(
  "/api/realms/:realmId/capsules/:capsuleId/archive",
  async (request, reply) => {
    try {
      return {
        archived: true,
        path: await archiveCapsule(request.params.realmId, request.params.capsuleId)
      };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not archive capsule"
      });
    }
  }
);

app.delete<{ Params: { realmId: string; capsuleId: string } }>(
  "/api/realms/:realmId/capsules/:capsuleId",
  async (request, reply) => {
    try {
      await deleteCapsule(request.params.realmId, request.params.capsuleId);
      return { deleted: true };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not delete capsule"
      });
    }
  }
);

app.get<{ Params: { realmId: string; capsuleId: string; "*": string } }>(
  "/capsules/:realmId/:capsuleId/*",
  async (request, reply) => {
    const capsule = await findCapsule(request.params.realmId, request.params.capsuleId);
    if (!capsule) {
      return reply.code(404).send("Capsule not found");
    }

    const requestedPath = request.params["*"] || "";

    if (capsule.manifest.entry.type === "web") {
      await capsuleDevHost.prepare(capsule);

      if (!requestedPath || requestedPath === "index.html") {
        reply.header("Content-Type", "text/html; charset=utf-8");
        return reply.send(capsuleDevHost.renderHtml(capsule));
      }

      if (requestedPath.startsWith("__malleable__/")) {
        const asset = capsuleDevHost.readAsset(
          capsule,
          requestedPath.slice("__malleable__/".length)
        );
        if (!asset) {
          return reply.code(404).send("Capsule asset not found");
        }

        reply.header("Content-Type", asset.contentType);
        return reply.send(Buffer.from(asset.contents));
      }

      if (requestedPath.startsWith("assets/")) {
        const assetsRoot = path.join(capsule.capsulePath, "assets");
        const resolved = path.resolve(capsule.capsulePath, requestedPath);
        if (!resolved.startsWith(assetsRoot)) {
          return reply.code(403).send("Outside capsule assets directory");
        }

        const content = await readFile(resolved).catch(() => undefined);
        if (!content) {
          return reply.code(404).send("File not found");
        }

        reply.header("Content-Type", lookupMime(resolved) || "application/octet-stream");
        return reply.send(content);
      }

      return reply.code(404).send("File not found");
    }

    const staticRequestedPath = requestedPath || capsule.manifest.entry.path;
    const publicRoot = path.join(capsule.capsulePath, "public");
    const resolved = path.resolve(publicRoot, staticRequestedPath.replace(/^public[\\/]/, ""));

    if (!resolved.startsWith(publicRoot)) {
      return reply.code(403).send("Outside capsule public directory");
    }

    const fileStat = await stat(resolved).catch(() => undefined);
    const filePath = fileStat?.isDirectory() ? path.join(resolved, "index.html") : resolved;
    const content = await readFile(filePath).catch(() => undefined);

    if (!content) {
      return reply.code(404).send("File not found");
    }

    reply.header("Content-Type", lookupMime(filePath) || "application/octet-stream");
    return reply.send(content);
  }
);

app.get<{ Params: { realmId: string; capsuleId: string } }>(
  "/capsules/:realmId/:capsuleId",
  async (_request, reply) => reply.redirect("./")
);

await app.listen({ port, host: "127.0.0.1" });
