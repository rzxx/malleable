#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseCapsuleManifest,
  parseCreateCapsuleInput,
  type CapsuleManifest,
  type CapsuleTemplateId
} from "@malleable/capsule-schema";
import { openCapsuleStateDatabase } from "@malleable/capsule-state/node";
import {
  findCapabilityDescriptors,
  stableJson,
  type CapabilityDescriptor
} from "@malleable/permission-core";
import { copyCapsuleTemplate } from "@malleable/template-core";

type CapsuleRecord = {
  readonly capsulePath: string;
  readonly launchUrl: string;
  readonly manifest: CapsuleManifest;
  readonly realmId: string;
  readonly sourcePath: string;
};

type CliOptions = {
  readonly json: boolean;
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, readonly string[]>;
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(currentDir, "../../..");
const realmsRoot = path.join(workspaceRoot, "realms");
const templatesRoot = path.join(workspaceRoot, "templates", "capsules");
const platformDataRoot = path.join(workspaceRoot, ".malleable");
const daemonPort = Number(process.env.DAEMON_PORT ?? 4877);
const daemonBase = `http://127.0.0.1:${daemonPort}`;

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

function parseArgs(argv: readonly string[]): CliOptions {
  const positional: string[] = [];
  const parsedFlags = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }

    const raw = item.slice(2);
    const [name, inlineValue] = raw.split(/=(.*)/s, 2);
    const values = parsedFlags.get(name) ?? [];
    const next = argv[index + 1];
    if (inlineValue !== undefined) {
      values.push(inlineValue);
    } else if (next && !next.startsWith("--")) {
      values.push(next);
      index += 1;
    } else {
      values.push("true");
    }
    parsedFlags.set(name, values);
  }

  return {
    flags: parsedFlags,
    json: parsedFlags.has("json"),
    positional
  };
}

function flag(options: CliOptions, name: string): string | undefined {
  return options.flags.get(name)?.at(-1);
}

function flags(options: CliOptions, name: string): readonly string[] {
  return options.flags.get(name) ?? [];
}

function realmFlag(options: CliOptions): string {
  return safeSegment(flag(options, "realm") ?? "default");
}

function safeSegment(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(`Invalid id: ${value}`);
  }

  return value;
}

function safeStateKey(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid state key: ${value}`);
  }

  return value;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(source: unknown, key: string): string {
  if (!isJsonRecord(source)) {
    throw new Error("Expected object row");
  }

  const value = source[key];
  if (typeof value !== "string") {
    throw new Error(`Expected string field: ${key}`);
  }

  return value;
}

function readNumberField(source: unknown, key: string): number {
  if (!isJsonRecord(source)) {
    throw new Error("Expected object row");
  }

  const value = source[key];
  if (typeof value !== "number") {
    throw new Error(`Expected number field: ${key}`);
  }

  return value;
}

function readTemplateId(value: string | undefined): CapsuleTemplateId {
  const candidate = value ?? "web-react";
  switch (candidate) {
    case "basic-static":
    case "web-react":
    case "web-vanilla":
      return candidate;
    default:
      throw new Error(`Unknown capsule template: ${value}`);
  }
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

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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

async function listRealms() {
  const entries = await readdir(realmsRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ id: entry.name, path: path.join(realmsRoot, entry.name) }));
}

async function createRealm(realmId: string) {
  const realm = safeSegment(realmId);
  const realmPath = path.join(realmsRoot, realm);
  await mkdir(path.join(realmPath, "capsules"), { recursive: true });
  await mkdir(path.join(realmPath, "files"), { recursive: true });
  return { id: realm, path: realmPath };
}

async function inspectRealm(realmId: string) {
  const realm = safeSegment(realmId);
  const realmPath = path.join(realmsRoot, realm);
  const exists = Boolean(await stat(realmPath).catch(() => undefined));
  if (!exists) {
    throw new Error("Realm not found");
  }

  const capsules = await listCapsules(realm);
  return {
    capsuleCount: capsules.length,
    id: realm,
    path: realmPath
  };
}

async function deleteRealm(realmId: string) {
  const realm = safeSegment(realmId);
  if (realm === "default") {
    throw new Error("Refusing to delete the default realm");
  }

  const realmPath = path.join(realmsRoot, realm);
  await rm(realmPath, { force: false, recursive: true });
  return { deleted: true, id: realm, path: realmPath };
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
      capsulePath,
      launchUrl: `/capsules/${realm}/${manifest.id}/`,
      manifest,
      realmId: realm,
      sourcePath:
        manifest.entry.type === "web"
          ? path.join(capsulePath, "src")
          : path.join(capsulePath, manifest.entry.path)
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

async function findCapsule(realmId: string, capsuleId: string): Promise<CapsuleRecord> {
  const realm = safeSegment(realmId);
  const id = safeSegment(capsuleId);
  const capsule = (await listCapsules(realm)).find((candidate) => candidate.manifest.id === id);
  if (!capsule) {
    throw new Error("Capsule not found");
  }

  return capsule;
}

async function resolveCapsule(capsuleId: string, realmId?: string): Promise<CapsuleRecord> {
  if (realmId) {
    return findCapsule(realmId, capsuleId);
  }

  const realms = await listRealms();
  const matches: CapsuleRecord[] = [];
  for (const realm of realms) {
    const capsule = (await listCapsules(realm.id)).find(
      (candidate) => candidate.manifest.id === capsuleId
    );
    if (capsule) {
      matches.push(capsule);
    }
  }

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    throw new Error("Capsule id is ambiguous; pass --realm");
  }

  throw new Error("Capsule not found");
}

async function createCapsule(
  realmId: string,
  input: {
    readonly caps: readonly string[];
    readonly description?: string;
    readonly id?: string;
    readonly name: string;
    readonly templateId: CapsuleTemplateId;
  }
): Promise<CapsuleRecord> {
  const realm = safeSegment(realmId);
  const parsed = parseCreateCapsuleInput({
    description: input.description,
    id: input.id,
    name: input.name,
    templateId: input.templateId
  });
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
  await copyCapsuleTemplate(template.path, capsulePath);
  await mkdir(dataPath, { recursive: true });
  await writeFile(path.join(capsulePath, "capsule.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await rewriteTemplatePlaceholders(capsulePath, {
    __MALLEABLE_CAPSULE_DESCRIPTION_JSON__: JSON.stringify(description),
    __MALLEABLE_CAPSULE_NAME_JSON__: JSON.stringify(manifest.name),
    "{{CAPSULE_DESCRIPTION}}": escapeHtml(description),
    "{{CAPSULE_NAME}}": escapeHtml(manifest.name)
  });

  const capsule = await findCapsule(realm, capsuleId);
  for (const cap of input.caps) {
    if (cap !== "own-data") {
      throw new Error(`Capability must be declared in capsule.json before granting: ${cap}`);
    }
  }

  return capsule;
}

async function forkCapsule(capsule: CapsuleRecord, newName?: string): Promise<CapsuleRecord> {
  const forkId = await nextCapsuleId(
    capsule.realmId,
    slugify(newName ?? `${capsule.manifest.id}-copy`)
  );
  const forkPath = path.join(realmsRoot, capsule.realmId, "capsules", forkId);
  const forkManifest: CapsuleManifest = {
    ...capsule.manifest,
    description: capsule.manifest.description
      ? `Forked from ${capsule.manifest.name}. ${capsule.manifest.description}`
      : `Forked from ${capsule.manifest.name}.`,
    id: forkId,
    name: newName ?? `${capsule.manifest.name} Copy`
  };

  await cp(capsule.capsulePath, forkPath, { errorOnExist: true, recursive: true });
  await writeFile(
    path.join(forkPath, "capsule.json"),
    `${JSON.stringify(forkManifest, null, 2)}\n`
  );

  return findCapsule(capsule.realmId, forkId);
}

async function archiveCapsule(capsule: CapsuleRecord) {
  const archiveRoot = path.join(realmsRoot, capsule.realmId, "archive", "capsules");
  const archivePath = path.join(archiveRoot, `${capsule.manifest.id}-${timestampSegment()}`);
  await mkdir(archiveRoot, { recursive: true });
  await rename(capsule.capsulePath, archivePath);
  return { archived: true, id: capsule.manifest.id, path: archivePath };
}

async function deleteCapsule(capsule: CapsuleRecord) {
  await rm(capsule.capsulePath, { force: false, recursive: true });
  return { deleted: true, id: capsule.manifest.id, path: capsule.capsulePath };
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

function openUrl(url: string): void {
  openPath(url);
}

async function daemonJson(route: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${daemonBase}${route}`, init).catch(() => undefined);
  if (!response) {
    return undefined;
  }

  const text = await response.text();
  const payload = text ? parseJsonValue(text) : undefined;
  if (!response.ok) {
    const error = isJsonRecord(payload) ? payload.error : undefined;
    throw new Error(
      typeof error === "string" ? error : `Daemon request failed: ${response.status}`
    );
  }

  return payload;
}

async function readDaemonStatus(capsule: CapsuleRecord): Promise<"running" | "stopped"> {
  const payload = await daemonJson(
    `/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/status`
  );
  const status = isJsonRecord(payload) ? payload.status : undefined;
  const state = isJsonRecord(status) && typeof status.state === "string" ? status.state : undefined;
  return state === "ready" || state === "dirty" ? "running" : "stopped";
}

function capabilitySummary(manifest: CapsuleManifest) {
  return {
    commands: manifest.capabilities.commands.length > 0,
    files: manifest.capabilities.files.map((item) =>
      "path" in item && typeof item.path === "string" ? `${item.scope}:${item.path}` : item.scope
    ),
    network: manifest.capabilities.network.length > 0,
    storage: manifest.capabilities.storage.map((item) => item.scope),
    system: manifest.capabilities.system.map((item) => item.scope)
  };
}

async function toAgentCapsule(capsule: CapsuleRecord, options: { includeManifest?: boolean } = {}) {
  const status = await readDaemonStatus(capsule).catch(() => "stopped" as const);
  const entry =
    capsule.manifest.entry.type === "web"
      ? {
          devUrl: `${daemonBase}${capsule.launchUrl}`,
          framework: capsule.manifest.entry.framework,
          kind: "web",
          main: capsule.manifest.entry.main
        }
      : {
          kind: "static",
          path: capsule.manifest.entry.path,
          url: `${daemonBase}${capsule.launchUrl}`
        };

  return {
    capabilities: capabilitySummary(capsule.manifest),
    entry,
    id: capsule.manifest.id,
    manifest: options.includeManifest ? capsule.manifest : undefined,
    name: capsule.manifest.name,
    path: capsule.capsulePath,
    realm: capsule.realmId,
    sourcePath: capsule.sourcePath,
    status
  };
}

function readPermissionsResponse(payload: unknown): Record<string, unknown> {
  if (!isJsonRecord(payload) || !isJsonRecord(payload.permissions)) {
    throw new Error("Daemon did not return a permission summary");
  }

  return payload.permissions;
}

async function readPermissionSummary(capsule: CapsuleRecord): Promise<Record<string, unknown>> {
  const payload = await daemonJson(
    `/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/permissions`
  );
  if (!payload) {
    throw new Error("Daemon is not running; permission commands require the permission broker");
  }

  return readPermissionsResponse(payload);
}

async function readRuntimeLogs(capsule: CapsuleRecord): Promise<unknown> {
  const payload = await daemonJson(
    `/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/logs`
  );
  if (!payload) {
    throw new Error("Daemon is not running; runtime logs require the daemon");
  }

  return isJsonRecord(payload) && "logs" in payload ? payload.logs : payload;
}

function readGrantRows(summary: Record<string, unknown>): Record<string, unknown>[] {
  const grants = summary.grants;
  return Array.isArray(grants) && grants.every(isJsonRecord) ? grants : [];
}

function grantMatchesDescriptor(
  grant: Record<string, unknown>,
  descriptor: CapabilityDescriptor
): boolean {
  return (
    grant.capability === descriptor.capability &&
    isJsonRecord(grant.scope) &&
    stableJson(grant.scope) === stableJson(descriptor.scope)
  );
}

async function grantCapability(
  capsule: CapsuleRecord,
  capability: string
): Promise<readonly unknown[]> {
  const descriptors = findCapabilityDescriptors(capsule.manifest, capability);
  if (descriptors.length === 0) {
    throw new Error(`Capability is not declared in capsule.json: ${capability}`);
  }

  const grants: unknown[] = [];
  for (const descriptor of descriptors) {
    const payload = await daemonJson(
      `/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/permissions/grants`,
      {
        body: JSON.stringify({
          decision: "allow",
          descriptorKey: descriptor.key,
          lifetime: "persistent"
        }),
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST"
      }
    );
    if (!payload) {
      throw new Error("Daemon is not running; permission commands require the permission broker");
    }

    if (isJsonRecord(payload) && "grant" in payload) {
      grants.push(payload.grant);
    }
  }

  return grants;
}

async function revokeCapability(capsule: CapsuleRecord, capability: string) {
  const descriptors = findCapabilityDescriptors(capsule.manifest, capability);
  const grantIds =
    descriptors.length === 0
      ? [capability]
      : readGrantRows(await readPermissionSummary(capsule))
          .filter((grant) =>
            descriptors.some((descriptor) => grantMatchesDescriptor(grant, descriptor))
          )
          .map((grant) => readStringField(grant, "id"));

  let revoked = 0;
  for (const grantId of grantIds) {
    const payload = await daemonJson(
      `/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/permissions/grants/${grantId}`,
      { method: "DELETE" }
    );
    if (!payload) {
      throw new Error("Daemon is not running; permission commands require the permission broker");
    }
    revoked += 1;
  }

  return { revoked };
}

async function readState(capsule: CapsuleRecord, key?: string) {
  const database = await openCapsuleStateDatabase(capsule);
  try {
    if (key) {
      const row = database
        .prepare("SELECT value, revision, updated_at FROM values_store WHERE key = ?")
        .get(safeStateKey(key));
      return row
        ? {
            key,
            revision: readNumberField(row, "revision"),
            updatedAt: readStringField(row, "updated_at"),
            value: JSON.parse(readStringField(row, "value")) as unknown
          }
        : { key, value: undefined };
    }

    const values = database
      .prepare("SELECT key, value, revision, updated_at FROM values_store")
      .all();
    return {
      values: Object.fromEntries(
        values.map((row) => [
          readStringField(row, "key"),
          JSON.parse(readStringField(row, "value")) as unknown
        ])
      )
    };
  } finally {
    database.close();
  }
}

async function setState(capsule: CapsuleRecord, key: string, rawValue: string) {
  const database = await openCapsuleStateDatabase(capsule);
  try {
    const parsed = parseJsonValue(rawValue);
    const now = new Date().toISOString();
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
      .run(safeStateKey(key), JSON.stringify(parsed), now);

    return { key, value: parsed, written: true };
  } finally {
    database.close();
  }
}

async function exportState(capsule: CapsuleRecord) {
  const database = await openCapsuleStateDatabase(capsule);
  try {
    const records = database
      .prepare("SELECT store, id, value, revision, updated_at FROM records")
      .all();
    const values = database
      .prepare("SELECT key, value, revision, updated_at FROM values_store")
      .all();
    return {
      records: records.map((row) => {
        return {
          id: readStringField(row, "id"),
          revision: readNumberField(row, "revision"),
          store: readStringField(row, "store"),
          updatedAt: readStringField(row, "updated_at"),
          value: JSON.parse(readStringField(row, "value")) as unknown
        };
      }),
      values: values.map((row) => {
        return {
          key: readStringField(row, "key"),
          revision: readNumberField(row, "revision"),
          updatedAt: readStringField(row, "updated_at"),
          value: JSON.parse(readStringField(row, "value")) as unknown
        };
      })
    };
  } finally {
    database.close();
  }
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

async function snapshotCapsule(capsule: CapsuleRecord) {
  const snapshotId = timestampSegment();
  const snapshotPath = path.join(
    platformDataRoot,
    "snapshots",
    capsule.realmId,
    capsule.manifest.id,
    snapshotId
  );
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await cp(capsule.capsulePath, snapshotPath, { errorOnExist: true, recursive: true });
  return { id: snapshotId, path: snapshotPath };
}

async function restoreCapsule(capsule: CapsuleRecord, snapshotId: string) {
  const safeSnapshot = safeSegment(snapshotId.replaceAll(/[^a-z0-9-]/g, "-"));
  if (safeSnapshot !== snapshotId) {
    throw new Error("Invalid snapshot id");
  }

  const snapshotPath = path.join(
    platformDataRoot,
    "snapshots",
    capsule.realmId,
    capsule.manifest.id,
    snapshotId
  );
  if (!(await stat(snapshotPath).catch(() => undefined))) {
    throw new Error("Snapshot not found");
  }

  await rm(capsule.capsulePath, { force: false, recursive: true });
  await cp(snapshotPath, capsule.capsulePath, { errorOnExist: true, recursive: true });
  return { restored: true, snapshotId };
}

async function applyCapsulePatch(capsule: CapsuleRecord, patchPath: string) {
  const source = JSON.parse(await readFile(path.resolve(patchPath), "utf8")) as unknown;
  if (!isJsonRecord(source)) {
    throw new Error("Patch must be a JSON object");
  }

  const files = source.files;
  if (!isJsonRecord(files)) {
    throw new Error("Patch must include a files object");
  }

  const written: string[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    if (typeof content !== "string") {
      throw new Error(`Patch file content must be a string: ${relativePath}`);
    }

    const target = path.resolve(capsule.capsulePath, relativePath);
    const root = path.resolve(capsule.capsulePath);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Patch file is outside capsule: ${relativePath}`);
    }

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    written.push(relativePath);
  }

  return { patched: true, written };
}

function print(value: unknown, options: CliOptions): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(stripUndefined(value), null, 2)}\n`);
    return;
  }

  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
    return;
  }

  process.stdout.write(`${formatText(value)}\n`);
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, stripUndefined(child)])
    );
  }
  return value;
}

function formatText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(formatText).join("\n");
  }
  if (!value || typeof value !== "object") {
    return String(value);
  }

  if (isJsonRecord(value)) {
    const id = value.id;
    const name = value.name;
    const realm = value.realm;
    const status = value.status;
    if (typeof id === "string" && typeof name === "string" && typeof realm === "string") {
      return `${id}\t${name}\t${realm}\t${typeof status === "string" ? status : ""}`.trimEnd();
    }
  }
  if (isJsonRecord(value) && typeof value.path === "string") {
    return value.path;
  }
  return JSON.stringify(stripUndefined(value), null, 2);
}

async function commandStatus(options: CliOptions) {
  const health = await daemonJson("/api/health");
  const healthWorkspaceRoot =
    isJsonRecord(health) && typeof health.workspaceRoot === "string"
      ? health.workspaceRoot
      : undefined;
  const realms = await listRealms();
  const capsules = (await Promise.all(realms.map((realm) => listCapsules(realm.id)))).flat();
  print(
    {
      capsules: capsules.length,
      daemon: healthWorkspaceRoot
        ? { running: true, url: daemonBase, workspaceRoot: healthWorkspaceRoot }
        : { running: false },
      realms: realms.length,
      workspaceRoot
    },
    options
  );
}

async function commandDoctor(options: CliOptions) {
  const templatesOk = (
    await Promise.all(
      Object.values(capsuleTemplates).map(async (template) =>
        Boolean(await stat(template.path).catch(() => undefined))
      )
    )
  ).every(Boolean);
  const checks = [];
  checks.push({
    ok: Boolean(await stat(workspaceRoot).catch(() => undefined)),
    subject: "workspace"
  });
  checks.push({ ok: Boolean(await stat(realmsRoot).catch(() => undefined)), subject: "realms" });
  checks.push({
    ok: Boolean(await stat(templatesRoot).catch(() => undefined)),
    subject: "templates"
  });
  checks.push({ ok: Boolean(await daemonJson("/api/health")), subject: "daemon" });
  checks.push({ ok: templatesOk, subject: "capsule templates" });
  print({ checks, ok: checks.every((check) => check.ok), workspaceRoot }, options);
}

async function commandRealm(options: CliOptions) {
  const [action, name] = options.positional.slice(1);
  switch (action) {
    case "list":
      print(await listRealms(), options);
      return;
    case "create":
      if (!name) {
        throw new Error("Usage: malleable realm create <name>");
      }
      print(await createRealm(name), options);
      return;
    case "inspect":
      if (!name) {
        throw new Error("Usage: malleable realm inspect <name>");
      }
      print(await inspectRealm(name), options);
      return;
    case "delete":
      if (!name) {
        throw new Error("Usage: malleable realm delete <name>");
      }
      print(await deleteRealm(name), options);
      return;
    default:
      throw new Error("Usage: malleable realm <list|create|inspect|delete>");
  }
}

async function commandCapsule(options: CliOptions) {
  const [action, id, extra] = options.positional.slice(1);
  const realm = flag(options, "realm");

  switch (action) {
    case "list": {
      const capsules = await listCapsules(realmFlag(options));
      print(await Promise.all(capsules.map((capsule) => toAgentCapsule(capsule))), options);
      return;
    }
    case "create": {
      const name = flag(options, "name") ?? id;
      if (!name) {
        throw new Error(
          "Usage: malleable capsule create <name> --template web-react --realm default"
        );
      }
      const capsule = await createCapsule(realmFlag(options), {
        caps: flags(options, "cap"),
        description: flag(options, "description"),
        id: flag(options, "id"),
        name,
        templateId: readTemplateId(flag(options, "template"))
      });
      print(await toAgentCapsule(capsule, { includeManifest: options.json }), options);
      return;
    }
    case "inspect": {
      if (!id) {
        throw new Error("Usage: malleable capsule inspect <id>");
      }
      const capsule = await resolveCapsule(id, realm);
      print(await toAgentCapsule(capsule, { includeManifest: options.json }), options);
      return;
    }
    case "path": {
      if (!id) {
        throw new Error("Usage: malleable capsule path <id>");
      }
      print((await resolveCapsule(id, realm)).capsulePath, options);
      return;
    }
    case "open": {
      if (!id) {
        throw new Error("Usage: malleable capsule open <id>");
      }
      const capsule = await resolveCapsule(id, realm);
      openPath(capsule.sourcePath);
      print({ opened: true, path: capsule.sourcePath }, options);
      return;
    }
    case "run": {
      if (!id) {
        throw new Error("Usage: malleable capsule run <id>");
      }
      const capsule = await resolveCapsule(id, realm);
      const payload = await daemonJson(
        `/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/launch`,
        { method: "POST" }
      );
      if (!isJsonRecord(payload) || typeof payload.url !== "string") {
        throw new Error("Daemon is not running. Start it with `pnpm dev` before running capsules.");
      }
      if (flag(options, "open") === "true") {
        openUrl(payload.url);
      }
      const agentCapsule = await toAgentCapsule(capsule);
      print(
        {
          ...agentCapsule,
          entry: { ...agentCapsule.entry, devUrl: payload.url },
          status: "running",
          url: payload.url
        },
        options
      );
      return;
    }
    case "stop": {
      if (!id) {
        throw new Error("Usage: malleable capsule stop <id>");
      }
      const capsule = await resolveCapsule(id, realm);
      const payload = await daemonJson(
        `/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/launch`,
        { method: "DELETE" }
      );
      if (!payload) {
        throw new Error("Daemon is not running");
      }
      print(payload, options);
      return;
    }
    case "delete": {
      if (!id) {
        throw new Error("Usage: malleable capsule delete <id>");
      }
      print(await deleteCapsule(await resolveCapsule(id, realm)), options);
      return;
    }
    case "archive": {
      if (!id) {
        throw new Error("Usage: malleable capsule archive <id>");
      }
      print(await archiveCapsule(await resolveCapsule(id, realm)), options);
      return;
    }
    case "fork": {
      if (!id) {
        throw new Error("Usage: malleable capsule fork <id> <new-name>");
      }
      const fork = await forkCapsule(await resolveCapsule(id, realm), extra);
      print(await toAgentCapsule(fork, { includeManifest: options.json }), options);
      return;
    }
    case "permissions": {
      if (!id) {
        throw new Error("Usage: malleable capsule permissions <id>");
      }
      print(await readPermissionSummary(await resolveCapsule(id, realm)), options);
      return;
    }
    case "grant": {
      if (!id || !extra) {
        throw new Error("Usage: malleable capsule grant <id> <capability>");
      }
      print({ grants: await grantCapability(await resolveCapsule(id, realm), extra) }, options);
      return;
    }
    case "revoke": {
      if (!id || !extra) {
        throw new Error("Usage: malleable capsule revoke <id> <capability>");
      }
      print(await revokeCapability(await resolveCapsule(id, realm), extra), options);
      return;
    }
    case "logs": {
      if (!id) {
        throw new Error("Usage: malleable capsule logs <id>");
      }
      print(await readRuntimeLogs(await resolveCapsule(id, realm)), options);
      return;
    }
    case "snapshot": {
      if (!id) {
        throw new Error("Usage: malleable capsule snapshot <id>");
      }
      print(await snapshotCapsule(await resolveCapsule(id, realm)), options);
      return;
    }
    case "restore": {
      if (!id || !extra) {
        throw new Error("Usage: malleable capsule restore <id> <snapshot-id>");
      }
      print(await restoreCapsule(await resolveCapsule(id, realm), extra), options);
      return;
    }
    case "patch": {
      if (!id || !flag(options, "from")) {
        throw new Error("Usage: malleable capsule patch <id> --from ./patch.json");
      }
      print(
        await applyCapsulePatch(await resolveCapsule(id, realm), flag(options, "from") ?? ""),
        options
      );
      return;
    }
    case "state": {
      await commandCapsuleState(options);
      return;
    }
    default:
      throw new Error(
        "Usage: malleable capsule <list|create|inspect|path|open|run|stop|delete|archive|fork|permissions|grant|revoke|logs|snapshot|restore|patch|state>"
      );
  }
}

async function commandCapsuleState(options: CliOptions) {
  const [, , subAction, id, key, value] = options.positional;
  const realm = flag(options, "realm");
  if (!id) {
    throw new Error("Usage: malleable capsule state <get|set|export> <id>");
  }

  const capsule = await resolveCapsule(id, realm);
  switch (subAction) {
    case "get":
      print(await readState(capsule, key), options);
      return;
    case "set":
      if (!key || value === undefined) {
        throw new Error("Usage: malleable capsule state set <id> <key> <value>");
      }
      print(await setState(capsule, key, value), options);
      return;
    case "export":
      print(await exportState(capsule), options);
      return;
    default:
      throw new Error("Usage: malleable capsule state <get|set|export> <id>");
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [command] = options.positional;

  switch (command) {
    case "status":
      await commandStatus(options);
      return;
    case "doctor":
      await commandDoctor(options);
      return;
    case "realm":
      await commandRealm(options);
      return;
    case "capsule":
      await commandCapsule(options);
      return;
    case undefined:
    case "help":
    case "--help":
      print(
        "Usage: malleable <status|doctor|realm|capsule> [--json]\nRun `malleable capsule inspect <id> --json` for agent-readable capsule context.",
        options
      );
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Command failed";
  if (process.argv.includes("--json")) {
    process.stderr.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = 1;
});
