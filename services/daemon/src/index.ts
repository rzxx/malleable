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

import { SharedCapsuleViteHost } from "./capsule-dev-host.js";
import {
  listCapabilityDescriptors,
  PermissionPlatform,
  type CapabilityDescriptor
} from "./permission-platform.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(currentDir, "../../..");
const realmsRoot = path.join(workspaceRoot, "realms");
const templatesRoot = path.join(workspaceRoot, "templates", "capsules");
const platformDataRoot = path.join(workspaceRoot, ".malleable");
const capsuleStateRuntimeSourcePath = path.join(
  workspaceRoot,
  "packages",
  "capsule-state",
  "src",
  "index.ts"
);
const capsuleSystemRuntimeSourcePath = path.join(
  workspaceRoot,
  "packages",
  "capsule-system",
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
const capsuleDevHost = new SharedCapsuleViteHost(workspaceRoot);
const permissionPlatform = new PermissionPlatform(
  path.join(platformDataRoot, "permissions.sqlite")
);
await permissionPlatform.open();
permissionPlatform.database.exec(`
  CREATE TABLE IF NOT EXISTS capsule_secrets (
    realm_id TEXT NOT NULL,
    capsule_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (realm_id, capsule_id, key)
  );
`);

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
      reload: "auto",
      type: "web"
    },
    path: path.join(templatesRoot, "web-react")
  },
  "web-vanilla": {
    defaultDescription: "A local TypeScript capsule created from a native web template.",
    entry: {
      framework: "vanilla",
      main: "src/main.ts",
      reload: "auto",
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

async function bundleCapsuleSystemRuntime(): Promise<string | undefined> {
  const bundle = await rolldown({
    input: capsuleSystemRuntimeSourcePath,
    logLevel: "silent",
    platform: "browser"
  }).catch(() => undefined);
  if (!bundle) {
    return undefined;
  }

  try {
    const result = await bundle.generate({
      entryFileNames: "system.js",
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

    const record = {
      manifest,
      realmId: realm,
      capsulePath,
      sourcePath:
        manifest.entry.type === "web"
          ? path.join(capsulePath, "src")
          : path.join(capsulePath, manifest.entry.path),
      launchUrl: `/capsules/${realm}/${manifest.id}/`
    };
    permissionPlatform.ensureAutoGrants(record);
    records.push(record);
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

function readOptionalStringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Invalid string field: ${key}`);
  }

  return value;
}

function readStringArrayField(
  source: Record<string, unknown>,
  key: string
): readonly string[] | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid string array field: ${key}`);
  }

  return value.map(String);
}

function readOptionalValueRow(row: unknown): string | undefined {
  const source = readJsonObject(row);
  if (!source) {
    return undefined;
  }

  const value = source.value;
  return typeof value === "string" ? value : undefined;
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

function isInsideOrEqual(filePath: string, rootPath: string): boolean {
  const resolvedFile = path.resolve(filePath);
  const resolvedRoot = path.resolve(rootPath);
  const relative = path.relative(resolvedRoot, resolvedFile);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function authorizeCapsuleRequest(
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

  return capsule;
}

async function authorizeStateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  access: "delete" | "read" | "write",
  operation: string,
  target: string
): Promise<CapsuleRecord | undefined> {
  const capsule = await authorizeCapsuleRequest(request, reply);
  if (!capsule) {
    return undefined;
  }

  const resolution = permissionPlatform.resolve(capsule, {
    access: [access],
    capability: "storage",
    descriptorMatches: (descriptor) => descriptor.scope.scope === "own-data",
    operation,
    target
  });
  if (resolution.isErr()) {
    await sendPermissionResolutionDenied(reply, resolution.error, operation, target);
    return undefined;
  }

  return capsule;
}

type FileScope =
  | "explicit-path"
  | "full-filesystem"
  | "own-data"
  | "own-source"
  | "realm-files"
  | "user-picked-directory"
  | "user-picked-file";

type FileOperationAuthorization = {
  readonly capsule: CapsuleRecord;
  readonly targetPath: string;
};

function isFileScope(value: string): value is FileScope {
  return (
    value === "explicit-path" ||
    value === "full-filesystem" ||
    value === "own-data" ||
    value === "own-source" ||
    value === "realm-files" ||
    value === "user-picked-directory" ||
    value === "user-picked-file"
  );
}

function readScopeString(descriptor: CapabilityDescriptor): FileScope | undefined {
  const scope = descriptor.scope.scope;
  return typeof scope === "string" && isFileScope(scope) ? scope : undefined;
}

function resolveFileTarget(
  capsule: CapsuleRecord,
  descriptor: CapabilityDescriptor,
  requestedPath: string
): string | undefined {
  const scope = readScopeString(descriptor);

  if (scope === "own-data") {
    const root = path.join(capsule.capsulePath, "data", "files");
    const resolved = path.resolve(root, requestedPath);
    return isInsideOrEqual(resolved, root) ? resolved : undefined;
  }

  if (scope === "own-source") {
    const root = capsule.capsulePath;
    const resolved = path.resolve(root, requestedPath);
    return isInsideOrEqual(resolved, root) ? resolved : undefined;
  }

  if (scope === "realm-files") {
    const root = path.join(realmsRoot, capsule.realmId, "files");
    const resolved = path.resolve(root, requestedPath);
    return isInsideOrEqual(resolved, root) ? resolved : undefined;
  }

  if (scope === "full-filesystem") {
    return path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : undefined;
  }

  if (
    scope === "explicit-path" ||
    scope === "user-picked-directory" ||
    scope === "user-picked-file"
  ) {
    const grantedPath = descriptor.scope.path;
    if (typeof grantedPath !== "string") {
      return undefined;
    }

    const root = path.resolve(grantedPath);
    if (scope === "user-picked-file") {
      if (!requestedPath || requestedPath === "." || path.resolve(requestedPath) === root) {
        return root;
      }

      return undefined;
    }

    const resolved = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(root, requestedPath);
    return isInsideOrEqual(resolved, root) ? resolved : undefined;
  }

  return undefined;
}

async function authorizeFileOperation(
  request: FastifyRequest,
  reply: FastifyReply,
  options: {
    readonly access: "delete" | "read" | "write";
    readonly operation: string;
    readonly requestedPath: string;
    readonly requestedScope?: string;
  }
): Promise<FileOperationAuthorization | undefined> {
  const capsule = await authorizeCapsuleRequest(request, reply);
  if (!capsule) {
    return undefined;
  }

  const candidates = listCapabilityDescriptors(capsule.manifest)
    .filter(
      (descriptor) =>
        descriptor.capability === "files" &&
        descriptor.access.includes(options.access) &&
        (!options.requestedScope || descriptor.scope.scope === options.requestedScope)
    )
    .map((descriptor) => ({
      descriptor,
      targetPath: resolveFileTarget(capsule, descriptor, options.requestedPath)
    }))
    .find((candidate) => candidate.targetPath);

  const resolution = permissionPlatform.resolve(capsule, {
    access: [options.access],
    capability: "files",
    descriptorMatches: candidates
      ? (descriptor) => descriptor.key === candidates.descriptor.key
      : () => false,
    operation: options.operation,
    target: candidates?.targetPath ?? options.requestedPath
  });

  if (resolution.isErr()) {
    await sendPermissionResolutionDenied(
      reply,
      resolution.error,
      options.operation,
      candidates?.targetPath ?? options.requestedPath
    );
    return undefined;
  }

  if (!candidates?.targetPath) {
    await reply.code(403).send({
      code: "permission-denied",
      error: "No declared file scope matched the requested path",
      operation: options.operation,
      reason: "No declared file scope matched the requested path",
      target: options.requestedPath
    });
    return undefined;
  }

  return {
    capsule,
    targetPath: candidates.targetPath
  };
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
      storage: [
        {
          access: ["delete", "read", "write"],
          scope: "own-data"
        }
      ],
      system: []
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

function captureCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly shell: boolean;
  }
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: options.shell,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const maxOutputLength = 512_000;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Command timed out"));
    }, 30_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-maxOutputLength);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-maxOutputLength);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stderr,
        stdout
      });
    });
  });
}

function commandDescriptorMatches(
  descriptor: CapabilityDescriptor,
  command: string,
  shell: boolean
): boolean {
  const scope = descriptor.scope.scope;
  if (scope === "full-process") {
    return true;
  }

  if (scope === "shell-command") {
    return shell;
  }

  return scope === "named-command" && descriptor.scope.command === command && !shell;
}

function networkDescriptorMatches(descriptor: CapabilityDescriptor, url: URL): boolean {
  const scope = descriptor.scope.scope;
  if (scope === "full-network") {
    return true;
  }

  if (scope === "listed-hosts") {
    return Array.isArray(descriptor.scope.hosts) && descriptor.scope.hosts.includes(url.host);
  }

  if (scope !== "private-network") {
    return false;
  }

  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname.startsWith("10.") ||
    url.hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname)
  );
}

function descriptorMatchesPermissionRequest(
  descriptor: CapabilityDescriptor,
  request: Record<string, unknown>
): boolean {
  if (descriptor.capability !== request.capability || descriptor.scope.scope !== request.scope) {
    return false;
  }

  if (typeof request.command === "string" && descriptor.scope.command !== request.command) {
    return false;
  }

  if (typeof request.path === "string" && descriptor.scope.path !== request.path) {
    return false;
  }

  if (Array.isArray(request.hosts)) {
    if (!Array.isArray(descriptor.scope.hosts)) {
      return false;
    }

    const descriptorHosts = descriptor.scope.hosts.map(String);
    if (
      !request.hosts.every((host) => typeof host === "string" && descriptorHosts.includes(host))
    ) {
      return false;
    }
  }

  return true;
}

function sendPermissionResolutionDenied(
  reply: FastifyReply,
  error: {
    readonly descriptor?: CapabilityDescriptor;
    readonly reason: string;
  },
  operation: string,
  target: string
) {
  return reply.code(403).send({
    capability: error.descriptor?.capability,
    code: "permission-denied",
    error: error.reason,
    operation,
    reason: error.reason,
    target
  });
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

app.get("/capsule-runtime/system.js", async (_request, reply) => {
  const content = await bundleCapsuleSystemRuntime();
  if (!content) {
    return reply.code(404).send("Capsule system runtime could not be bundled");
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

async function replyFromVite(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.hijack();
  const handled = await capsuleDevHost.handleViteRequest(request.raw, reply.raw);
  if (!handled && !reply.raw.writableEnded) {
    reply.raw.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8"
    });
    reply.raw.end("File not found");
  }
}

app.get("/@vite/client", replyFromVite);
app.get("/@vite/*", replyFromVite);
app.get("/@react-refresh", replyFromVite);
app.get("/@id/*", replyFromVite);
app.get("/@fs/*", replyFromVite);
app.get("/node_modules/*", replyFromVite);
app.get("/packages/*", replyFromVite);
app.get("/realms/*", replyFromVite);
app.get("/__malleable_capsule_entry__/:realmId/:capsuleId", replyFromVite);
app.get("/__malleable_capsule_client__/:realmId/:capsuleId", replyFromVite);

app.get<{ Params: { storeName: string } }>(
  "/api/capsule-state/stores/:storeName/records",
  async (request, reply) => {
    const capsule = await authorizeStateRequest(
      request,
      reply,
      "read",
      "state.records.list",
      request.params.storeName
    );
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
    const capsule = await authorizeStateRequest(
      request,
      reply,
      "write",
      "state.records.insert",
      request.params.storeName
    );
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
    const capsule = await authorizeStateRequest(
      request,
      reply,
      "read",
      "state.records.get",
      `${request.params.storeName}/${request.params.id}`
    );
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
    const capsule = await authorizeStateRequest(
      request,
      reply,
      "write",
      "state.records.upsert",
      `${request.params.storeName}/${request.params.id}`
    );
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
    const capsule = await authorizeStateRequest(
      request,
      reply,
      "write",
      "state.records.update",
      `${request.params.storeName}/${request.params.id}`
    );
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
    const capsule = await authorizeStateRequest(
      request,
      reply,
      "delete",
      "state.records.delete",
      `${request.params.storeName}/${request.params.id}`
    );
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
    const capsule = await authorizeStateRequest(
      request,
      reply,
      "read",
      "state.value.get",
      request.params.storeName
    );
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
    const capsule = await authorizeStateRequest(
      request,
      reply,
      "write",
      "state.value.set",
      request.params.storeName
    );
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

app.post<{ Body: unknown }>("/api/capsule-system/permissions/ensure", async (request, reply) => {
  try {
    const body = readJsonObject(request.body);
    if (!body) {
      throw new Error("Permission request body must be an object");
    }

    const capsule = await authorizeCapsuleRequest(request, reply);
    if (!capsule) {
      return undefined;
    }

    const capability = readStringField(body, "capability");
    if (
      capability !== "commands" &&
      capability !== "files" &&
      capability !== "network" &&
      capability !== "storage" &&
      capability !== "system"
    ) {
      throw new Error("Capability family is invalid");
    }

    const access = readStringArrayField(body, "access");
    if (!access || access.length === 0) {
      throw new Error("Permission access must be a non-empty string array");
    }

    const scope = readStringField(body, "scope");
    const target = `${capability}.${scope} ${access.join("/")}`;
    const resolution = permissionPlatform.resolve(capsule, {
      access,
      capability,
      descriptorMatches: (descriptor) => descriptorMatchesPermissionRequest(descriptor, body),
      operation: "permissions.ensure",
      target
    });
    if (resolution.isErr()) {
      return sendPermissionResolutionDenied(reply, resolution.error, "permissions.ensure", target);
    }

    return {
      permission: {
        access: resolution.value.descriptor.access,
        capability: resolution.value.descriptor.capability,
        granted: true,
        scope: resolution.value.descriptor.scope
      }
    };
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Could not ensure permission"
    });
  }
});

app.post<{ Body: unknown }>("/api/capsule-system/files/read-directory", async (request, reply) => {
  try {
    const body = readJsonObject(request.body);
    if (!body) {
      throw new Error("File request body must be an object");
    }

    const requestedPath = readOptionalStringField(body, "path") ?? ".";
    const authorized = await authorizeFileOperation(request, reply, {
      access: "read",
      operation: "files.read-directory",
      requestedPath,
      requestedScope: readOptionalStringField(body, "scope")
    });
    if (!authorized) {
      return undefined;
    }

    const entries = await readdir(authorized.targetPath, { withFileTypes: true });
    return {
      entries: entries.map((entry) => ({
        kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
        name: entry.name
      }))
    };
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Could not read directory"
    });
  }
});

app.post<{ Body: unknown }>("/api/capsule-system/files/read-text-file", async (request, reply) => {
  try {
    const body = readJsonObject(request.body);
    if (!body) {
      throw new Error("File request body must be an object");
    }

    const requestedPath = readStringField(body, "path");
    const authorized = await authorizeFileOperation(request, reply, {
      access: "read",
      operation: "files.read-text-file",
      requestedPath,
      requestedScope: readOptionalStringField(body, "scope")
    });
    if (!authorized) {
      return undefined;
    }

    return {
      text: await readFile(authorized.targetPath, "utf8")
    };
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Could not read text file"
    });
  }
});

app.post<{ Body: unknown }>("/api/capsule-system/files/write-text-file", async (request, reply) => {
  try {
    const body = readJsonObject(request.body);
    if (!body) {
      throw new Error("File request body must be an object");
    }

    const requestedPath = readStringField(body, "path");
    const text = readStringField(body, "text");
    const authorized = await authorizeFileOperation(request, reply, {
      access: "write",
      operation: "files.write-text-file",
      requestedPath,
      requestedScope: readOptionalStringField(body, "scope")
    });
    if (!authorized) {
      return undefined;
    }

    await mkdir(path.dirname(authorized.targetPath), { recursive: true });
    await writeFile(authorized.targetPath, text, "utf8");
    return {
      written: true
    };
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Could not write text file"
    });
  }
});

app.post<{ Body: unknown }>("/api/capsule-system/files/delete-path", async (request, reply) => {
  try {
    const body = readJsonObject(request.body);
    if (!body) {
      throw new Error("File request body must be an object");
    }

    const requestedPath = readStringField(body, "path");
    const authorized = await authorizeFileOperation(request, reply, {
      access: "delete",
      operation: "files.delete-path",
      requestedPath,
      requestedScope: readOptionalStringField(body, "scope")
    });
    if (!authorized) {
      return undefined;
    }

    await rm(authorized.targetPath, {
      force: false,
      recursive: body.recursive === true
    });
    return {
      deleted: true
    };
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Could not delete path"
    });
  }
});

app.post<{ Body: unknown }>("/api/capsule-system/commands/run", async (request, reply) => {
  try {
    const body = readJsonObject(request.body);
    if (!body) {
      throw new Error("Command request body must be an object");
    }

    const capsule = await authorizeCapsuleRequest(request, reply);
    if (!capsule) {
      return undefined;
    }

    const command = readStringField(body, "command");
    const args = readStringArrayField(body, "args") ?? [];
    const shell = body.shell === true;
    const resolution = permissionPlatform.resolve(capsule, {
      access: ["run"],
      capability: "commands",
      descriptorMatches: (descriptor) => commandDescriptorMatches(descriptor, command, shell),
      operation: shell ? "commands.run-shell" : "commands.run",
      target: shell ? command : [command, ...args].join(" ")
    });
    if (resolution.isErr()) {
      return sendPermissionResolutionDenied(
        reply,
        resolution.error,
        shell ? "commands.run-shell" : "commands.run",
        shell ? command : [command, ...args].join(" ")
      );
    }

    return await captureCommand(command, shell ? [] : args, { shell });
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Could not run command"
    });
  }
});

app.post<{ Body: unknown }>("/api/capsule-system/network/fetch", async (request, reply) => {
  try {
    const body = readJsonObject(request.body);
    if (!body) {
      throw new Error("Network request body must be an object");
    }

    const capsule = await authorizeCapsuleRequest(request, reply);
    if (!capsule) {
      return undefined;
    }

    const url = new URL(readStringField(body, "url"));
    const method = readOptionalStringField(body, "method") ?? "GET";
    const resolution = permissionPlatform.resolve(capsule, {
      access: ["connect"],
      capability: "network",
      descriptorMatches: (descriptor) => networkDescriptorMatches(descriptor, url),
      operation: "network.fetch",
      target: url.toString()
    });
    if (resolution.isErr()) {
      return sendPermissionResolutionDenied(
        reply,
        resolution.error,
        "network.fetch",
        url.toString()
      );
    }

    const response = await fetch(url, {
      body: typeof body.body === "string" ? body.body : undefined,
      method
    });
    return {
      body: await response.text(),
      headers: Object.fromEntries(response.headers.entries()),
      status: response.status
    };
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Could not make network request"
    });
  }
});

app.post<{ Body: unknown }>(
  "/api/capsule-system/system/open-external-url",
  async (request, reply) => {
    try {
      const body = readJsonObject(request.body);
      if (!body) {
        throw new Error("System request body must be an object");
      }

      const capsule = await authorizeCapsuleRequest(request, reply);
      if (!capsule) {
        return undefined;
      }

      const url = new URL(readStringField(body, "url"));
      const resolution = permissionPlatform.resolve(capsule, {
        access: ["run"],
        capability: "system",
        descriptorMatches: (descriptor) => descriptor.scope.scope === "open-external-url",
        operation: "system.open-external-url",
        target: url.toString()
      });
      if (resolution.isErr()) {
        return sendPermissionResolutionDenied(
          reply,
          resolution.error,
          "system.open-external-url",
          url.toString()
        );
      }

      openPath(url.toString());
      return { opened: true };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not open external URL"
      });
    }
  }
);

app.post<{ Body: unknown }>("/api/capsule-system/system/open-path", async (request, reply) => {
  try {
    const body = readJsonObject(request.body);
    if (!body) {
      throw new Error("System request body must be an object");
    }

    const capsule = await authorizeCapsuleRequest(request, reply);
    if (!capsule) {
      return undefined;
    }

    const targetPath = readStringField(body, "path");
    const resolution = permissionPlatform.resolve(capsule, {
      access: ["run"],
      capability: "system",
      descriptorMatches: (descriptor) => descriptor.scope.scope === "open-path",
      operation: "system.open-path",
      target: targetPath
    });
    if (resolution.isErr()) {
      return sendPermissionResolutionDenied(
        reply,
        resolution.error,
        "system.open-path",
        targetPath
      );
    }

    openPath(targetPath);
    return { opened: true };
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Could not open path"
    });
  }
});

app.post<{ Body: unknown }>("/api/capsule-system/system/secrets/get", async (request, reply) => {
  try {
    const body = readJsonObject(request.body);
    if (!body) {
      throw new Error("Secret request body must be an object");
    }

    const capsule = await authorizeCapsuleRequest(request, reply);
    if (!capsule) {
      return undefined;
    }

    const key = safeStateKey(readStringField(body, "key"));
    const resolution = permissionPlatform.resolve(capsule, {
      access: ["read"],
      capability: "system",
      descriptorMatches: (descriptor) => descriptor.scope.scope === "secrets",
      operation: "system.secrets.get",
      target: key
    });
    if (resolution.isErr()) {
      return sendPermissionResolutionDenied(reply, resolution.error, "system.secrets.get", key);
    }

    const value = readOptionalValueRow(
      permissionPlatform.database
        .prepare(
          "SELECT value FROM capsule_secrets WHERE realm_id = ? AND capsule_id = ? AND key = ?"
        )
        .get(capsule.realmId, capsule.manifest.id, key)
    );
    return {
      value
    };
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Could not read secret"
    });
  }
});

app.post<{ Body: unknown }>("/api/capsule-system/system/secrets/set", async (request, reply) => {
  try {
    const body = readJsonObject(request.body);
    if (!body) {
      throw new Error("Secret request body must be an object");
    }

    const capsule = await authorizeCapsuleRequest(request, reply);
    if (!capsule) {
      return undefined;
    }

    const key = safeStateKey(readStringField(body, "key"));
    const value = readStringField(body, "value");
    const resolution = permissionPlatform.resolve(capsule, {
      access: ["write"],
      capability: "system",
      descriptorMatches: (descriptor) => descriptor.scope.scope === "secrets",
      operation: "system.secrets.set",
      target: key
    });
    if (resolution.isErr()) {
      return sendPermissionResolutionDenied(reply, resolution.error, "system.secrets.set", key);
    }

    permissionPlatform.database
      .prepare(
        `
        INSERT INTO capsule_secrets (realm_id, capsule_id, key, value, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(realm_id, capsule_id, key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `
      )
      .run(capsule.realmId, capsule.manifest.id, key, value, new Date().toISOString());
    return {
      written: true
    };
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Could not write secret"
    });
  }
});

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
    permissionPlatform.ensureAutoGrants(capsule);
    return { capsule };
  }
);

app.get<{ Params: { realmId: string; capsuleId: string } }>(
  "/api/realms/:realmId/capsules/:capsuleId/permissions",
  async (request, reply) => {
    const capsule = await findCapsule(request.params.realmId, request.params.capsuleId);
    if (!capsule) {
      return reply.code(404).send({ error: "Capsule not found" });
    }

    return {
      permissions: permissionPlatform.readSummary(capsule)
    };
  }
);

app.post<{ Body: unknown; Params: { realmId: string; capsuleId: string } }>(
  "/api/realms/:realmId/capsules/:capsuleId/permissions/grants",
  async (request, reply) => {
    try {
      const capsule = await findCapsule(request.params.realmId, request.params.capsuleId);
      if (!capsule) {
        return reply.code(404).send({ error: "Capsule not found" });
      }

      const body = readJsonObject(request.body);
      if (!body) {
        throw new Error("Grant body must be an object");
      }

      const descriptor = permissionPlatform.findDescriptor(
        capsule,
        readStringField(body, "descriptorKey")
      );
      if (!descriptor) {
        return reply.code(404).send({ error: "Requested capability was not found" });
      }

      const lifetime = readStringField(body, "lifetime");
      if (lifetime !== "once" && lifetime !== "session" && lifetime !== "persistent") {
        throw new Error("Grant lifetime is invalid");
      }

      const decision = readOptionalStringField(body, "decision") ?? "allow";
      if (decision !== "allow" && decision !== "deny") {
        throw new Error("Grant decision is invalid");
      }

      const grant = permissionPlatform.upsertGrant(capsule, descriptor, {
        decision,
        lifetime
      });
      return {
        grant,
        permissions: permissionPlatform.readSummary(capsule)
      };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not update grant"
      });
    }
  }
);

app.post<{ Body: unknown; Params: { realmId: string; capsuleId: string } }>(
  "/api/realms/:realmId/capsules/:capsuleId/permissions/trust",
  async (request, reply) => {
    try {
      const capsule = await findCapsule(request.params.realmId, request.params.capsuleId);
      if (!capsule) {
        return reply.code(404).send({ error: "Capsule not found" });
      }

      const body = readJsonObject(request.body);
      if (!body) {
        throw new Error("Trust body must be an object");
      }

      const trusted = body.trusted === true;
      permissionPlatform.setTrusted(capsule, trusted);
      if (trusted) {
        permissionPlatform.grantAllDeclared(capsule, "persistent");
      }

      return {
        permissions: permissionPlatform.readSummary(capsule)
      };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not update trust"
      });
    }
  }
);

app.post<{ Params: { realmId: string; capsuleId: string } }>(
  "/api/realms/:realmId/capsules/:capsuleId/permissions/acknowledge",
  async (request, reply) => {
    const capsule = await findCapsule(request.params.realmId, request.params.capsuleId);
    if (!capsule) {
      return reply.code(404).send({ error: "Capsule not found" });
    }

    permissionPlatform.acknowledgeManifest(capsule);
    return {
      permissions: permissionPlatform.readSummary(capsule)
    };
  }
);

app.delete<{ Params: { capsuleId: string; grantId: string; realmId: string } }>(
  "/api/realms/:realmId/capsules/:capsuleId/permissions/grants/:grantId",
  async (request, reply) => {
    const capsule = await findCapsule(request.params.realmId, request.params.capsuleId);
    if (!capsule) {
      return reply.code(404).send({ error: "Capsule not found" });
    }

    permissionPlatform.revokeGrant(request.params.grantId);
    return {
      permissions: permissionPlatform.readSummary(capsule)
    };
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
  "/api/realms/:realmId/capsules/:capsuleId/launch",
  async (request, reply) => {
    const capsule = await findCapsule(request.params.realmId, request.params.capsuleId);
    if (!capsule) {
      return reply.code(404).send({ error: "Capsule not found" });
    }
    try {
      await capsuleDevHost.activate(capsule);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not launch capsule"
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
      if (!requestedPath || requestedPath === "index.html") {
        reply.header("Cache-Control", "no-store");
        reply.header("Content-Type", "text/html; charset=utf-8");
        return reply.send(await capsuleDevHost.renderHtml(capsule));
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
