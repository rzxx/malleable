import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  capabilityRegistry,
  type CapabilityFamily,
  type CapabilityRegistryEntry,
  type CapsuleManifest,
  type GrantDecision,
  type GrantLifetime,
  type PermissionEvent,
  type PermissionGrant
} from "@malleable/capsule-schema";
import { Result, TaggedError } from "better-result";

export type CapsulePermissionSubject = {
  readonly capsulePath: string;
  readonly manifest: CapsuleManifest;
  readonly realmId: string;
};

export type CapabilityDescriptor = {
  readonly access: readonly string[];
  readonly autoAllow: boolean;
  readonly capability: CapabilityFamily;
  readonly key: string;
  readonly label: string;
  readonly prompt: "ask" | "auto" | "explicit-trust";
  readonly risk: "critical" | "high" | "low" | "medium";
  readonly scope: Readonly<Record<string, unknown>>;
};

export type CapabilityDiff = {
  readonly added: readonly string[];
  readonly existing: readonly string[];
  readonly removed: readonly string[];
};

export type PermissionSummary = {
  readonly diff: CapabilityDiff;
  readonly events: readonly PermissionEvent[];
  readonly grants: readonly PermissionGrant[];
  readonly manifestHash: string;
  readonly requested: readonly CapabilityDescriptor[];
  readonly trusted: boolean;
};

class PermissionResolutionError extends TaggedError("PermissionResolutionError")<{
  descriptor?: CapabilityDescriptor;
  message: string;
  reason: string;
}>() {}

export type PermissionResolution = Result<
  {
    readonly descriptor: CapabilityDescriptor;
    readonly grant: PermissionGrant;
  },
  PermissionResolutionError
>;

const permissionFamilies = ["commands", "files", "network", "storage", "system"] as const;

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringValue(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw new Error(`Database row is missing string field: ${key}`);
  }

  return value;
}

export function readGrantDecision(value: string): GrantDecision {
  if (value !== "allow" && value !== "deny") {
    throw new Error(`Invalid grant decision: ${value}`);
  }

  return value;
}

export function readGrantLifetime(value: string): GrantLifetime {
  if (value !== "once" && value !== "session" && value !== "persistent") {
    throw new Error(`Invalid grant lifetime: ${value}`);
  }

  return value;
}

export function readCapabilityFamily(value: string): CapabilityFamily {
  switch (value) {
    case "commands":
    case "files":
    case "network":
    case "storage":
    case "system":
      return value;
    default:
      throw new Error(`Invalid capability family: ${value}`);
  }
}

function readRegistryEntry(
  capability: CapabilityFamily,
  scope: string
): CapabilityRegistryEntry | undefined {
  const entries: Readonly<Record<string, CapabilityRegistryEntry>> = capabilityRegistry[capability];
  return entries[scope];
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function manifestCapabilityHash(manifest: CapsuleManifest): string {
  return createHash("sha256").update(stableJson(manifest.capabilities)).digest("hex");
}

export function descriptorKey(
  capability: CapabilityFamily,
  scope: Readonly<Record<string, unknown>>,
  access: readonly string[]
): string {
  return `${capability}:${stableJson(scope)}:${stableJson([...access].toSorted())}`;
}

function scopeLabel(scope: Readonly<Record<string, unknown>>): string {
  const base = String(scope.scope);
  if (typeof scope.path === "string") {
    return `${base} ${scope.path}`;
  }

  if (typeof scope.command === "string") {
    return `${base} ${scope.command}`;
  }

  if (Array.isArray(scope.hosts)) {
    return `${base} ${scope.hosts.join(", ")}`;
  }

  return base;
}

function createDescriptor(
  capability: CapabilityFamily,
  request: { readonly access: readonly string[]; readonly scope: string } & Record<string, unknown>
): CapabilityDescriptor {
  const registryEntry = readRegistryEntry(capability, request.scope);
  if (!registryEntry) {
    throw new Error(`Unknown capability request: ${capability}.${request.scope}`);
  }

  const scope = Object.fromEntries(Object.entries(request).filter(([key]) => key !== "access"));
  const access = [...new Set(request.access)].toSorted();
  const key = descriptorKey(capability, scope, access);

  return {
    access,
    autoAllow: registryEntry.autoAllow,
    capability,
    key,
    label: `${capability}.${scopeLabel(scope)} ${access.join("/")}`,
    prompt: registryEntry.prompt,
    risk: registryEntry.risk,
    scope
  };
}

export function listCapabilityDescriptors(manifest: CapsuleManifest): CapabilityDescriptor[] {
  return permissionFamilies.flatMap((family) =>
    manifest.capabilities[family].map((request) =>
      createDescriptor(family, request as { access: readonly string[]; scope: string })
    )
  );
}

export function findCapabilityDescriptors(
  manifest: CapsuleManifest,
  capability: string
): CapabilityDescriptor[] {
  const normalized = capability.includes(".") ? capability : capability.replace(/^cap:/, "");
  return listCapabilityDescriptors(manifest).filter(
    (descriptor) =>
      descriptor.key === capability ||
      descriptor.label === capability ||
      descriptor.capability === normalized ||
      descriptor.scope.scope === normalized ||
      `${descriptor.capability}.${String(descriptor.scope.scope)}` === normalized
  );
}

function readJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function readJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return isJsonRecord(parsed) ? parsed : {};
}

function readIdRow(row: unknown): string | undefined {
  if (!isJsonRecord(row)) {
    return undefined;
  }

  const id = row.id;
  return typeof id === "string" ? id : undefined;
}

function readDescriptorArray(value: string): CapabilityDescriptor[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  const descriptors: CapabilityDescriptor[] = [];
  for (const item of parsed) {
    if (!isJsonRecord(item)) {
      continue;
    }

    const capability = item.capability;
    const key = item.key;
    const label = item.label;
    const prompt = item.prompt;
    const risk = item.risk;
    const scope = item.scope;
    const access = item.access;
    const autoAllow = item.autoAllow;
    if (
      typeof capability !== "string" ||
      typeof key !== "string" ||
      typeof label !== "string" ||
      typeof prompt !== "string" ||
      typeof risk !== "string" ||
      typeof autoAllow !== "boolean" ||
      !isJsonRecord(scope) ||
      !Array.isArray(access) ||
      access.some((entry) => typeof entry !== "string")
    ) {
      continue;
    }

    if (
      (prompt !== "ask" && prompt !== "auto" && prompt !== "explicit-trust") ||
      (risk !== "critical" && risk !== "high" && risk !== "low" && risk !== "medium")
    ) {
      continue;
    }

    descriptors.push({
      access,
      autoAllow,
      capability: readCapabilityFamily(capability),
      key,
      label,
      prompt,
      risk,
      scope
    });
  }

  return descriptors;
}

function readSnapshotRequested(row: unknown): CapabilityDescriptor[] | undefined {
  if (!isJsonRecord(row)) {
    return undefined;
  }

  const requestedJson = row.requested_json;
  return typeof requestedJson === "string" ? readDescriptorArray(requestedJson) : undefined;
}

function parseGrantRow(row: unknown): PermissionGrant {
  if (!isJsonRecord(row)) {
    throw new Error("Invalid permission grant row");
  }

  return {
    access: readJsonArray(readStringValue(row, "access_json")),
    capability: readCapabilityFamily(readStringValue(row, "capability")),
    decision: readGrantDecision(readStringValue(row, "decision")),
    id: readStringValue(row, "id"),
    lifetime: readGrantLifetime(readStringValue(row, "lifetime")),
    manifestHash: readStringValue(row, "manifest_hash"),
    scope: readJsonObject(readStringValue(row, "scope_json"))
  };
}

function parseEventRow(row: unknown): PermissionEvent {
  if (!isJsonRecord(row)) {
    throw new Error("Invalid permission event row");
  }

  return {
    capability: readStringValue(row, "capability"),
    capsuleId: readStringValue(row, "capsule_id"),
    decision: readStringValue(row, "decision"),
    id: readStringValue(row, "id"),
    operation: readStringValue(row, "operation"),
    reason: readStringValue(row, "reason"),
    realmId: readStringValue(row, "realm_id"),
    target: readStringValue(row, "target"),
    timestamp: readStringValue(row, "timestamp")
  };
}

function includesAll(granted: readonly string[], requested: readonly string[]): boolean {
  return requested.every((access) => granted.includes(access));
}

function isSameScope(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>
) {
  return stableJson(left) === stableJson(right);
}

function isAllowingGrant(
  grant: PermissionGrant,
  descriptor: CapabilityDescriptor,
  manifestHash: string
): boolean {
  return (
    grant.capability === descriptor.capability &&
    grant.decision === "allow" &&
    grant.manifestHash === manifestHash &&
    isSameScope(grant.scope, descriptor.scope) &&
    includesAll(grant.access, descriptor.access)
  );
}

function isDeniedGrant(grant: PermissionGrant, descriptor: CapabilityDescriptor): boolean {
  return (
    grant.capability === descriptor.capability &&
    grant.decision === "deny" &&
    isSameScope(grant.scope, descriptor.scope)
  );
}

export async function openPermissionDatabase(databasePath: string): Promise<DatabaseSync> {
  await mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath, {
    timeout: 5000
  });
  database.exec(`
    CREATE TABLE IF NOT EXISTS permission_grants (
      id TEXT PRIMARY KEY,
      realm_id TEXT NOT NULL,
      capsule_id TEXT NOT NULL,
      capsule_path TEXT NOT NULL,
      capability TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      access_json TEXT NOT NULL,
      decision TEXT NOT NULL,
      lifetime TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE INDEX IF NOT EXISTS permission_grants_capsule
      ON permission_grants (realm_id, capsule_id);

    CREATE TABLE IF NOT EXISTS permission_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      realm_id TEXT NOT NULL,
      capsule_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      operation TEXT NOT NULL,
      target TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS permission_events_capsule
      ON permission_events (realm_id, capsule_id, timestamp);

    CREATE TABLE IF NOT EXISTS permission_manifest_snapshots (
      realm_id TEXT NOT NULL,
      capsule_id TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      requested_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (realm_id, capsule_id)
    );

    CREATE TABLE IF NOT EXISTS trusted_capsules (
      realm_id TEXT NOT NULL,
      capsule_id TEXT NOT NULL,
      trusted_at TEXT NOT NULL,
      PRIMARY KEY (realm_id, capsule_id)
    );
  `);

  return database;
}

export class PermissionBroker {
  readonly #databasePath: string;
  #database: DatabaseSync | undefined;

  constructor(databasePath: string) {
    this.#databasePath = databasePath;
  }

  async open(): Promise<void> {
    this.#database = await openPermissionDatabase(this.#databasePath);
    this.database
      .prepare("DELETE FROM permission_grants WHERE lifetime IN ('once', 'session')")
      .run();
  }

  get database(): DatabaseSync {
    if (!this.#database) {
      throw new Error("Permission broker database has not been opened");
    }

    return this.#database;
  }

  close(): void {
    this.#database?.close();
    this.#database = undefined;
  }

  readGrants(capsule: CapsulePermissionSubject): PermissionGrant[] {
    return this.database
      .prepare(
        `
        SELECT id, capability, scope_json, access_json, decision, lifetime, manifest_hash
        FROM permission_grants
        WHERE realm_id = ? AND capsule_id = ?
        ORDER BY updated_at DESC
      `
      )
      .all(capsule.realmId, capsule.manifest.id)
      .map(parseGrantRow);
  }

  readEvents(capsule: CapsulePermissionSubject, limit = 80): PermissionEvent[] {
    return this.database
      .prepare(
        `
        SELECT id, timestamp, realm_id, capsule_id, capability, operation, target, decision, reason
        FROM permission_events
        WHERE realm_id = ? AND capsule_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `
      )
      .all(capsule.realmId, capsule.manifest.id, limit)
      .map(parseEventRow);
  }

  isTrusted(capsule: CapsulePermissionSubject): boolean {
    return Boolean(
      this.database
        .prepare("SELECT trusted_at FROM trusted_capsules WHERE realm_id = ? AND capsule_id = ?")
        .get(capsule.realmId, capsule.manifest.id)
    );
  }

  setTrusted(capsule: CapsulePermissionSubject, trusted: boolean): void {
    if (!trusted) {
      this.database
        .prepare("DELETE FROM trusted_capsules WHERE realm_id = ? AND capsule_id = ?")
        .run(capsule.realmId, capsule.manifest.id);
      return;
    }

    this.database
      .prepare(
        `
        INSERT INTO trusted_capsules (realm_id, capsule_id, trusted_at)
        VALUES (?, ?, ?)
        ON CONFLICT(realm_id, capsule_id) DO UPDATE SET trusted_at = excluded.trusted_at
      `
      )
      .run(capsule.realmId, capsule.manifest.id, new Date().toISOString());
  }

  ensureAutoGrants(capsule: CapsulePermissionSubject): void {
    const manifestHash = manifestCapabilityHash(capsule.manifest);
    const grants = this.readGrants(capsule);
    for (const descriptor of listCapabilityDescriptors(capsule.manifest)) {
      if (
        !descriptor.autoAllow ||
        grants.some((grant) => isAllowingGrant(grant, descriptor, manifestHash))
      ) {
        continue;
      }

      this.upsertGrant(capsule, descriptor, {
        decision: "allow",
        lifetime: "persistent",
        manifestHash
      });
    }

    this.ensureSnapshot(capsule);
  }

  grantAllDeclared(capsule: CapsulePermissionSubject, lifetime: GrantLifetime): void {
    const manifestHash = manifestCapabilityHash(capsule.manifest);
    for (const descriptor of listCapabilityDescriptors(capsule.manifest)) {
      this.upsertGrant(capsule, descriptor, {
        decision: "allow",
        lifetime,
        manifestHash
      });
    }

    this.updateSnapshot(capsule);
  }

  upsertGrant(
    capsule: CapsulePermissionSubject,
    descriptor: CapabilityDescriptor,
    options: {
      readonly decision: GrantDecision;
      readonly lifetime: GrantLifetime;
      readonly manifestHash?: string;
    }
  ): PermissionGrant {
    const now = new Date().toISOString();
    const manifestHash = options.manifestHash ?? manifestCapabilityHash(capsule.manifest);
    const existingGrantId = readIdRow(
      this.database
        .prepare(
          `
        SELECT id
        FROM permission_grants
        WHERE realm_id = ? AND capsule_id = ? AND capability = ? AND scope_json = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `
        )
        .get(
          capsule.realmId,
          capsule.manifest.id,
          descriptor.capability,
          stableJson(descriptor.scope)
        )
    );

    const grantId = existingGrantId ?? randomUUID();
    this.database
      .prepare(
        `
        INSERT INTO permission_grants (
          id, realm_id, capsule_id, capsule_path, capability, scope_json, access_json,
          decision, lifetime, manifest_hash, granted_at, updated_at, last_used_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
          capsule_path = excluded.capsule_path,
          access_json = excluded.access_json,
          decision = excluded.decision,
          lifetime = excluded.lifetime,
          manifest_hash = excluded.manifest_hash,
          updated_at = excluded.updated_at
      `
      )
      .run(
        grantId,
        capsule.realmId,
        capsule.manifest.id,
        capsule.capsulePath,
        descriptor.capability,
        stableJson(descriptor.scope),
        stableJson(descriptor.access),
        options.decision,
        options.lifetime,
        manifestHash,
        now,
        now
      );

    this.updateSnapshot(capsule);
    return {
      access: [...descriptor.access],
      capability: descriptor.capability,
      decision: options.decision,
      id: grantId,
      lifetime: options.lifetime,
      manifestHash,
      scope: { ...descriptor.scope }
    };
  }

  revokeGrant(grantId: string): void {
    this.database.prepare("DELETE FROM permission_grants WHERE id = ?").run(grantId);
  }

  resolve(
    capsule: CapsulePermissionSubject,
    options: {
      readonly access: readonly string[];
      readonly capability: CapabilityFamily;
      readonly descriptorMatches?: (descriptor: CapabilityDescriptor) => boolean;
      readonly operation: string;
      readonly target: string;
    }
  ): PermissionResolution {
    this.ensureAutoGrants(capsule);

    const descriptor = listCapabilityDescriptors(capsule.manifest).find(
      (candidate) =>
        candidate.capability === options.capability &&
        includesAll(candidate.access, options.access) &&
        (options.descriptorMatches?.(candidate) ?? true)
    );

    if (!descriptor) {
      this.logEvent(capsule, {
        capability: options.capability,
        decision: "deny",
        operation: options.operation,
        reason: "Capability was not declared in capsule.json",
        target: options.target
      });
      return Result.err(
        new PermissionResolutionError({
          message: "Capability was not declared in capsule.json",
          reason: "Capability was not declared in capsule.json"
        })
      );
    }

    const manifestHash = manifestCapabilityHash(capsule.manifest);
    const grants = this.readGrants(capsule);
    const denied = grants.find((grant) => isDeniedGrant(grant, descriptor));
    if (denied) {
      this.logEvent(capsule, {
        capability: descriptor.capability,
        decision: "deny",
        operation: options.operation,
        reason: "Permission grant is denied",
        target: options.target
      });
      return Result.err(
        new PermissionResolutionError({
          descriptor,
          message: "Permission grant is denied",
          reason: "Permission grant is denied"
        })
      );
    }

    const grant = grants.find((candidate) => isAllowingGrant(candidate, descriptor, manifestHash));
    if (!grant) {
      this.logEvent(capsule, {
        capability: descriptor.capability,
        decision: "deny",
        operation: options.operation,
        reason: "Capability has not been granted",
        target: options.target
      });
      const reason =
        descriptor.prompt === "explicit-trust"
          ? "Capability requires an explicit trust grant"
          : "Capability has not been granted";
      return Result.err(
        new PermissionResolutionError({
          descriptor,
          message: reason,
          reason
        })
      );
    }

    this.database
      .prepare("UPDATE permission_grants SET last_used_at = ? WHERE id = ?")
      .run(new Date().toISOString(), grant.id);
    if (grant.lifetime === "once") {
      this.revokeGrant(grant.id);
    }

    this.logEvent(capsule, {
      capability: descriptor.capability,
      decision: "allow",
      operation: options.operation,
      reason: "Permission grant allowed operation",
      target: options.target
    });
    return Result.ok({
      descriptor,
      grant
    });
  }

  readSummary(capsule: CapsulePermissionSubject): PermissionSummary {
    this.ensureAutoGrants(capsule);
    const requested = listCapabilityDescriptors(capsule.manifest);
    const currentKeys = new Set(requested.map((descriptor) => descriptor.key));
    const previous =
      readSnapshotRequested(
        this.database
          .prepare(
            `
        SELECT requested_json
        FROM permission_manifest_snapshots
        WHERE realm_id = ? AND capsule_id = ?
      `
          )
          .get(capsule.realmId, capsule.manifest.id)
      ) ?? requested;
    const previousKeys = new Set(previous.map((descriptor) => descriptor.key));
    const grants = this.readGrants(capsule);
    const manifestHash = manifestCapabilityHash(capsule.manifest);

    return {
      diff: {
        added: requested
          .filter((descriptor) => !previousKeys.has(descriptor.key))
          .map((descriptor) => descriptor.label),
        existing: requested
          .filter((descriptor) =>
            grants.some((grant) => isAllowingGrant(grant, descriptor, manifestHash))
          )
          .map((descriptor) => descriptor.label),
        removed: previous
          .filter((descriptor) => !currentKeys.has(descriptor.key))
          .map((descriptor) => descriptor.label)
      },
      events: this.readEvents(capsule),
      grants,
      manifestHash,
      requested,
      trusted: this.isTrusted(capsule)
    };
  }

  findDescriptor(capsule: CapsulePermissionSubject, key: string): CapabilityDescriptor | undefined {
    return listCapabilityDescriptors(capsule.manifest).find((descriptor) => descriptor.key === key);
  }

  acknowledgeManifest(capsule: CapsulePermissionSubject): void {
    this.updateSnapshot(capsule);
  }

  private ensureSnapshot(capsule: CapsulePermissionSubject): void {
    const existing = this.database
      .prepare(
        "SELECT manifest_hash FROM permission_manifest_snapshots WHERE realm_id = ? AND capsule_id = ?"
      )
      .get(capsule.realmId, capsule.manifest.id);
    if (!existing) {
      this.updateSnapshot(capsule);
    }
  }

  private updateSnapshot(capsule: CapsulePermissionSubject): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `
        INSERT INTO permission_manifest_snapshots (
          realm_id, capsule_id, manifest_hash, requested_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(realm_id, capsule_id) DO UPDATE SET
          manifest_hash = excluded.manifest_hash,
          requested_json = excluded.requested_json,
          updated_at = excluded.updated_at
      `
      )
      .run(
        capsule.realmId,
        capsule.manifest.id,
        manifestCapabilityHash(capsule.manifest),
        stableJson(listCapabilityDescriptors(capsule.manifest)),
        now
      );
  }

  private logEvent(
    capsule: CapsulePermissionSubject,
    event: {
      readonly capability: string;
      readonly decision: "allow" | "deny";
      readonly operation: string;
      readonly reason: string;
      readonly target: string;
    }
  ): void {
    this.database
      .prepare(
        `
        INSERT INTO permission_events (
          id, timestamp, realm_id, capsule_id, capability, operation, target, decision, reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        randomUUID(),
        new Date().toISOString(),
        capsule.realmId,
        capsule.manifest.id,
        event.capability,
        event.operation,
        event.target,
        event.decision,
        event.reason
      );
  }
}
