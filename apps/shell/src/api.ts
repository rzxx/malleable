import {
  CapsuleManifestSchema,
  PermissionGrantSchema,
  type GrantDecision,
  type GrantLifetime,
  type PermissionGrant
} from "@malleable/capsule-schema";
import { z } from "zod";

export const apiBase = "http://127.0.0.1:4877";

const RealmSchema = z.object({
  id: z.string(),
  path: z.string()
});

const CapsuleSchema = z.object({
  capsulePath: z.string(),
  launchUrl: z.string(),
  manifest: CapsuleManifestSchema,
  realmId: z.string(),
  sourcePath: z.string()
});

const RealmsPayloadSchema = z.object({
  realms: z.array(RealmSchema)
});

const CapsulesPayloadSchema = z.object({
  capsules: z.array(CapsuleSchema)
});

const LaunchPayloadSchema = z.object({
  url: z.string()
});

const CapsuleStatusSchema = z.object({
  capsuleId: z.string(),
  error: z.string().optional(),
  realmId: z.string(),
  revision: z.number(),
  state: z.enum(["dirty", "error", "ready"])
});

const CapabilityDescriptorSchema = z.object({
  access: z.array(z.string()),
  autoAllow: z.boolean(),
  capability: z.enum(["commands", "files", "network", "storage", "system"]),
  key: z.string(),
  label: z.string(),
  prompt: z.enum(["ask", "auto", "explicit-trust"]),
  risk: z.enum(["critical", "high", "low", "medium"]),
  scope: z.record(z.string(), z.unknown())
});

const PermissionSummarySchema = z.object({
  diff: z.object({
    added: z.array(z.string()),
    existing: z.array(z.string()),
    removed: z.array(z.string())
  }),
  events: z.array(z.unknown()),
  grants: z.array(PermissionGrantSchema),
  manifestHash: z.string(),
  requested: z.array(CapabilityDescriptorSchema),
  trusted: z.boolean()
});

const PermissionPayloadSchema = z.object({
  permissions: PermissionSummarySchema
});

const ErrorPayloadSchema = z.object({
  error: z.string()
});

export type Realm = z.infer<typeof RealmSchema>;
export type Capsule = z.infer<typeof CapsuleSchema>;
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;
export type PermissionSummary = z.infer<typeof PermissionSummarySchema>;
export type CapsuleStatus = z.infer<typeof CapsuleStatusSchema>;
export type PermissionLifetime = Extract<GrantLifetime, "persistent" | "session">;
export type PermissionDecision = GrantDecision;
export type { PermissionGrant };

async function readJson(response: Response): Promise<unknown> {
  return await response.json();
}

function readError(payload: unknown): string | undefined {
  return ErrorPayloadSchema.safeParse(payload).data?.error;
}

async function requestJson(route: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${apiBase}${route}`, init);
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(readError(payload) ?? `Daemon request failed: ${response.status}`);
  }

  return payload;
}

export async function readRealms(): Promise<Realm[]> {
  return RealmsPayloadSchema.parse(await requestJson("/api/realms")).realms;
}

export async function readCapsules(realmId: string): Promise<Capsule[]> {
  return CapsulesPayloadSchema.parse(
    await requestJson(`/api/realms/${encodeURIComponent(realmId)}/capsules`)
  ).capsules;
}

export async function launchCapsule(capsule: Capsule): Promise<string> {
  return LaunchPayloadSchema.parse(
    await requestJson(`/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/launch`, {
      method: "POST"
    })
  ).url;
}

export async function readPermissions(capsule: Capsule): Promise<PermissionSummary> {
  return PermissionPayloadSchema.parse(
    await requestJson(`/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/permissions`)
  ).permissions;
}

export async function updatePermissionGrant(
  capsule: Capsule,
  descriptor: CapabilityDescriptor,
  lifetime: PermissionLifetime,
  decision: PermissionDecision = "allow"
): Promise<PermissionSummary> {
  return PermissionPayloadSchema.parse(
    await requestJson(
      `/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/permissions/grants`,
      {
        body: JSON.stringify({
          decision,
          descriptorKey: descriptor.key,
          lifetime
        }),
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST"
      }
    )
  ).permissions;
}

export async function setCapsuleTrust(
  capsule: Capsule,
  trusted: boolean
): Promise<PermissionSummary> {
  return PermissionPayloadSchema.parse(
    await requestJson(
      `/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/permissions/trust`,
      {
        body: JSON.stringify({ trusted }),
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST"
      }
    )
  ).permissions;
}

export async function acknowledgeManifestChanges(capsule: Capsule): Promise<PermissionSummary> {
  return PermissionPayloadSchema.parse(
    await requestJson(
      `/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/permissions/acknowledge`,
      { method: "POST" }
    )
  ).permissions;
}

export async function openCapsuleSource(capsule: Capsule): Promise<void> {
  await requestJson(`/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/source/open`, {
    method: "POST"
  });
}

export function parseCapsuleStatusEvent(data: string): CapsuleStatus | undefined {
  const parsed = CapsuleStatusSchema.safeParse(JSON.parse(data) as unknown);
  return parsed.success ? parsed.data : undefined;
}
