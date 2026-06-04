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

export type CapsuleManifest = z.infer<typeof CapsuleManifestSchema>;

export function parseCapsuleManifest(input: unknown): CapsuleManifest {
  return CapsuleManifestSchema.parse(input);
}
