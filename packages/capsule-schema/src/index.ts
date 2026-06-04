import { z } from "zod";

export const CapsuleManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  entry: z.object({
    type: z.literal("static"),
    path: z.string().min(1)
  }),
  capabilities: z.object({
    storage: z.array(z.enum(["own-data"])).default([]),
    network: z.array(z.string()).default([]),
    commands: z.array(z.string()).default([]),
    files: z.array(z.string()).default([])
  })
});

export const CreateCapsuleInputSchema = z.object({
  description: z.string().max(240).optional(),
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  name: z.string().trim().min(1).max(80),
  templateId: z.literal("basic-static").default("basic-static")
});

export type CapsuleManifest = z.infer<typeof CapsuleManifestSchema>;
export type CreateCapsuleInput = z.infer<typeof CreateCapsuleInputSchema>;

export function parseCapsuleManifest(input: unknown): CapsuleManifest {
  return CapsuleManifestSchema.parse(input);
}

export function parseCreateCapsuleInput(input: unknown): CreateCapsuleInput {
  return CreateCapsuleInputSchema.parse(input);
}
