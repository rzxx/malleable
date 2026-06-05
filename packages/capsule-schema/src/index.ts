import { z } from "zod";

const WebFrameworkSchema = z.enum(["vanilla", "react", "solid", "svelte"]);

const StaticEntrySchema = z.object({
  path: z.string().min(1),
  type: z.literal("static")
});

const WebEntrySchema = z.object({
  framework: WebFrameworkSchema.default("vanilla"),
  main: z.string().min(1),
  reload: z.enum(["prompt", "hmr"]).default("prompt"),
  type: z.literal("web")
});

export const CapsuleManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  entry: z.discriminatedUnion("type", [StaticEntrySchema, WebEntrySchema]),
  capabilities: z.object({
    storage: z.array(z.enum(["own-data"])).default([]),
    network: z.array(z.string()).default([]),
    commands: z.array(z.string()).default([]),
    files: z.array(z.string()).default([])
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

export type CapsuleManifest = z.infer<typeof CapsuleManifestSchema>;
export type CapsuleTemplateId = z.infer<typeof CapsuleTemplateIdSchema>;
export type CreateCapsuleInput = z.infer<typeof CreateCapsuleInputSchema>;

export function parseCapsuleManifest(input: unknown): CapsuleManifest {
  return CapsuleManifestSchema.parse(input);
}

export function parseCreateCapsuleInput(input: unknown): CreateCapsuleInput {
  return CreateCapsuleInputSchema.parse(input);
}
