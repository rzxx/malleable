import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "@fastify/cors";
import { parseCapsuleManifest, type CapsuleManifest } from "@malleable/capsule-schema";
import Fastify from "fastify";
import { lookup as lookupMime } from "mime-types";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(currentDir, "../../..");
const realmsRoot = path.join(workspaceRoot, "realms");
const port = Number(process.env.DAEMON_PORT ?? 4877);

type CapsuleRecord = {
  manifest: CapsuleManifest;
  realmId: string;
  capsulePath: string;
  sourcePath: string;
  launchUrl: string;
};

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

function safeSegment(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(`Invalid path segment: ${value}`);
  }

  return value;
}

async function readManifest(capsulePath: string): Promise<CapsuleManifest> {
  const raw = await readFile(path.join(capsulePath, "capsule.json"), "utf8");
  return parseCapsuleManifest(JSON.parse(raw));
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
      sourcePath: capsulePath,
      launchUrl: `/capsules/${realm}/${manifest.id}/`
    });
  }

  return records;
}

async function findCapsule(realmId: string, capsuleId: string): Promise<CapsuleRecord | undefined> {
  const capsules = await listCapsules(realmId);
  return capsules.find((capsule) => capsule.manifest.id === capsuleId);
}

app.get("/api/health", async () => ({
  ok: true,
  workspaceRoot
}));

app.get("/api/realms", async () => ({
  realms: await listRealms()
}));

app.get<{ Params: { realmId: string } }>("/api/realms/:realmId/capsules", async (request) => ({
  capsules: await listCapsules(request.params.realmId)
}));

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
  "/api/realms/:realmId/capsules/:capsuleId/launch",
  async (request, reply) => {
    const capsule = await findCapsule(request.params.realmId, request.params.capsuleId);
    if (!capsule) {
      return reply.code(404).send({ error: "Capsule not found" });
    }
    return {
      status: "running",
      url: `http://127.0.0.1:${port}${capsule.launchUrl}`
    };
  }
);

app.get<{ Params: { realmId: string; capsuleId: string; "*": string } }>(
  "/capsules/:realmId/:capsuleId/*",
  async (request, reply) => {
    const capsule = await findCapsule(request.params.realmId, request.params.capsuleId);
    if (!capsule) {
      return reply.code(404).send("Capsule not found");
    }

    const requestedPath = request.params["*"] || capsule.manifest.entry.path;
    const publicRoot = path.join(capsule.capsulePath, "public");
    const resolved = path.resolve(publicRoot, requestedPath.replace(/^public[\\/]/, ""));

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
