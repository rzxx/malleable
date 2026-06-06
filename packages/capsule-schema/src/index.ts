import { z } from "zod";

const WebFrameworkSchema = z.enum(["vanilla", "react"]);
const StorageScopeSchema = z.enum(["own-data", "realm-data", "shared-data"]);
const FilesScopeSchema = z.enum([
  "own-data",
  "own-source",
  "realm-files",
  "user-picked-file",
  "user-picked-directory",
  "explicit-path",
  "full-filesystem"
]);
const CommandsScopeSchema = z.enum(["named-command", "shell-command", "full-process"]);
const NetworkScopeSchema = z.enum(["listed-hosts", "private-network", "full-network"]);
const SystemScopeSchema = z.enum([
  "clipboard",
  "notifications",
  "open-external-url",
  "open-path",
  "dialogs",
  "secrets"
]);
const StorageAccessSchema = z.enum(["read", "write", "delete"]);
const FilesAccessSchema = z.enum(["read", "write", "delete"]);
const CommandsAccessSchema = z.enum(["run"]);
const NetworkAccessSchema = z.enum(["connect"]);
const SystemAccessSchema = z.enum(["read", "write", "run"]);
const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
const GrantLifetimeSchema = z.enum(["once", "session", "persistent"]);
const GrantDecisionSchema = z.enum(["allow", "deny"]);

const StaticEntrySchema = z.object({
  path: z.string().min(1),
  type: z.literal("static")
});

const WebEntrySchema = z.object({
  framework: WebFrameworkSchema.default("vanilla"),
  main: z.string().min(1),
  reload: z.literal("auto").default("auto"),
  type: z.literal("web")
});

const StorageCapabilityRequestSchema = z.object({
  access: z.array(StorageAccessSchema).min(1),
  scope: StorageScopeSchema
});

const FilesCapabilityRequestSchema = z
  .object({
    access: z.array(FilesAccessSchema).min(1),
    path: z.string().min(1).optional(),
    scope: FilesScopeSchema
  })
  .superRefine((value, context) => {
    const needsPath =
      value.scope === "explicit-path" ||
      value.scope === "user-picked-file" ||
      value.scope === "user-picked-directory";

    if (needsPath && !value.path) {
      context.addIssue({
        code: "custom",
        message: `${value.scope} requires a path`,
        path: ["path"]
      });
    }
  });

const CommandsCapabilityRequestSchema = z
  .object({
    access: z.array(CommandsAccessSchema).min(1),
    command: z.string().min(1).optional(),
    scope: CommandsScopeSchema
  })
  .superRefine((value, context) => {
    if (value.scope === "named-command" && !value.command) {
      context.addIssue({
        code: "custom",
        message: "named-command requires a command",
        path: ["command"]
      });
    }
  });

const NetworkCapabilityRequestSchema = z
  .object({
    access: z.array(NetworkAccessSchema).min(1),
    hosts: z.array(z.string().min(1)).optional(),
    scope: NetworkScopeSchema
  })
  .superRefine((value, context) => {
    if (value.scope === "listed-hosts" && (!value.hosts || value.hosts.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "listed-hosts requires at least one host",
        path: ["hosts"]
      });
    }
  });

const SystemCapabilityRequestSchema = z.object({
  access: z.array(SystemAccessSchema).min(1),
  scope: SystemScopeSchema
});

export const CapabilityRequestSchema = z.object({
  commands: z.array(CommandsCapabilityRequestSchema).default([]),
  files: z.array(FilesCapabilityRequestSchema).default([]),
  network: z.array(NetworkCapabilityRequestSchema).default([]),
  storage: z.array(StorageCapabilityRequestSchema).default([]),
  system: z.array(SystemCapabilityRequestSchema).default([])
});

export const CapsuleManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  entry: z.discriminatedUnion("type", [StaticEntrySchema, WebEntrySchema]),
  capabilities: CapabilityRequestSchema.default({
    commands: [],
    files: [],
    network: [],
    storage: [],
    system: []
  })
});

export const CapsuleTemplateIdSchema = z.enum(["basic-static", "web-react", "web-vanilla"]);

export const CreateCapsuleInputSchema = z.object({
  description: z.string().max(240).optional(),
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  name: z.string().trim().min(1).max(80),
  templateId: CapsuleTemplateIdSchema.default("web-react")
});

export const PermissionGrantSchema = z.object({
  access: z.array(z.string()).min(1),
  capability: z.enum(["commands", "files", "network", "storage", "system"]),
  decision: GrantDecisionSchema,
  id: z.string(),
  lifetime: GrantLifetimeSchema,
  manifestHash: z.string(),
  scope: z.record(z.string(), z.unknown())
});

export const PermissionEventSchema = z.object({
  capability: z.string(),
  capsuleId: z.string(),
  decision: z.string(),
  id: z.string(),
  operation: z.string(),
  reason: z.string(),
  realmId: z.string(),
  target: z.string(),
  timestamp: z.string()
});

export const CapabilityDiffSchema = z.object({
  added: z.array(z.string()),
  existing: z.array(z.string()),
  removed: z.array(z.string())
});

export type CapabilityFamily = keyof z.infer<typeof CapabilityRequestSchema>;
export type CapsuleManifest = z.infer<typeof CapsuleManifestSchema>;
export type CapsuleTemplateId = z.infer<typeof CapsuleTemplateIdSchema>;
export type CommandsCapabilityRequest = z.infer<typeof CommandsCapabilityRequestSchema>;
export type CreateCapsuleInput = z.infer<typeof CreateCapsuleInputSchema>;
export type FilesCapabilityRequest = z.infer<typeof FilesCapabilityRequestSchema>;
export type GrantDecision = z.infer<typeof GrantDecisionSchema>;
export type GrantLifetime = z.infer<typeof GrantLifetimeSchema>;
export type NetworkCapabilityRequest = z.infer<typeof NetworkCapabilityRequestSchema>;
export type PermissionEvent = z.infer<typeof PermissionEventSchema>;
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type StorageCapabilityRequest = z.infer<typeof StorageCapabilityRequestSchema>;
export type SystemCapabilityRequest = z.infer<typeof SystemCapabilityRequestSchema>;

export type CapabilityRegistryEntry = {
  readonly access: readonly string[];
  readonly autoAllow: boolean;
  readonly canPersist: boolean;
  readonly id: string;
  readonly prompt: "auto" | "ask" | "explicit-trust";
  readonly risk: RiskLevel;
};

export const capabilityRegistry = {
  commands: {
    "full-process": {
      access: ["run"],
      autoAllow: false,
      canPersist: true,
      id: "commands.full-process",
      prompt: "explicit-trust",
      risk: "critical"
    },
    "named-command": {
      access: ["run"],
      autoAllow: false,
      canPersist: true,
      id: "commands.named-command",
      prompt: "ask",
      risk: "high"
    },
    "shell-command": {
      access: ["run"],
      autoAllow: false,
      canPersist: true,
      id: "commands.shell-command",
      prompt: "explicit-trust",
      risk: "critical"
    }
  },
  files: {
    "explicit-path": {
      access: ["read", "write", "delete"],
      autoAllow: false,
      canPersist: true,
      id: "files.explicit-path",
      prompt: "ask",
      risk: "high"
    },
    "full-filesystem": {
      access: ["read", "write", "delete"],
      autoAllow: false,
      canPersist: true,
      id: "files.full-filesystem",
      prompt: "explicit-trust",
      risk: "critical"
    },
    "own-data": {
      access: ["read", "write", "delete"],
      autoAllow: true,
      canPersist: true,
      id: "files.own-data",
      prompt: "auto",
      risk: "low"
    },
    "own-source": {
      access: ["read", "write"],
      autoAllow: true,
      canPersist: true,
      id: "files.own-source",
      prompt: "auto",
      risk: "low"
    },
    "realm-files": {
      access: ["read", "write", "delete"],
      autoAllow: false,
      canPersist: true,
      id: "files.realm-files",
      prompt: "ask",
      risk: "medium"
    },
    "user-picked-directory": {
      access: ["read", "write", "delete"],
      autoAllow: false,
      canPersist: true,
      id: "files.user-picked-directory",
      prompt: "ask",
      risk: "medium"
    },
    "user-picked-file": {
      access: ["read", "write", "delete"],
      autoAllow: false,
      canPersist: true,
      id: "files.user-picked-file",
      prompt: "ask",
      risk: "medium"
    }
  },
  network: {
    "full-network": {
      access: ["connect"],
      autoAllow: false,
      canPersist: true,
      id: "network.full-network",
      prompt: "explicit-trust",
      risk: "critical"
    },
    "listed-hosts": {
      access: ["connect"],
      autoAllow: false,
      canPersist: true,
      id: "network.listed-hosts",
      prompt: "ask",
      risk: "medium"
    },
    "private-network": {
      access: ["connect"],
      autoAllow: false,
      canPersist: true,
      id: "network.private-network",
      prompt: "ask",
      risk: "high"
    }
  },
  storage: {
    "own-data": {
      access: ["read", "write", "delete"],
      autoAllow: true,
      canPersist: true,
      id: "storage.own-data",
      prompt: "auto",
      risk: "low"
    },
    "realm-data": {
      access: ["read", "write", "delete"],
      autoAllow: false,
      canPersist: true,
      id: "storage.realm-data",
      prompt: "ask",
      risk: "medium"
    },
    "shared-data": {
      access: ["read", "write", "delete"],
      autoAllow: false,
      canPersist: true,
      id: "storage.shared-data",
      prompt: "ask",
      risk: "medium"
    }
  },
  system: {
    clipboard: {
      access: ["read", "write"],
      autoAllow: false,
      canPersist: true,
      id: "system.clipboard",
      prompt: "ask",
      risk: "medium"
    },
    dialogs: {
      access: ["run"],
      autoAllow: false,
      canPersist: false,
      id: "system.dialogs",
      prompt: "ask",
      risk: "medium"
    },
    notifications: {
      access: ["run"],
      autoAllow: false,
      canPersist: true,
      id: "system.notifications",
      prompt: "ask",
      risk: "medium"
    },
    "open-external-url": {
      access: ["run"],
      autoAllow: false,
      canPersist: true,
      id: "system.open-external-url",
      prompt: "ask",
      risk: "medium"
    },
    "open-path": {
      access: ["run"],
      autoAllow: false,
      canPersist: true,
      id: "system.open-path",
      prompt: "ask",
      risk: "high"
    },
    secrets: {
      access: ["read", "write"],
      autoAllow: false,
      canPersist: true,
      id: "system.secrets",
      prompt: "explicit-trust",
      risk: "critical"
    }
  }
} as const satisfies Record<CapabilityFamily, Record<string, CapabilityRegistryEntry>>;

export function parseCapsuleManifest(input: unknown): CapsuleManifest {
  return CapsuleManifestSchema.parse(input);
}

export function parseCreateCapsuleInput(input: unknown): CreateCapsuleInput {
  return CreateCapsuleInputSchema.parse(input);
}
