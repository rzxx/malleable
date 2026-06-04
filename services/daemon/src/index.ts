import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "@fastify/cors";
import {
  parseCapsuleManifest,
  parseCreateCapsuleInput,
  type CapsuleManifest
} from "@malleable/capsule-schema";
import Fastify from "fastify";
import { lookup as lookupMime } from "mime-types";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(currentDir, "../../..");
const realmsRoot = path.join(workspaceRoot, "realms");
const templatePath = path.join(workspaceRoot, "templates", "capsules", "basic-static");
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

async function createCapsule(realmId: string, input: unknown): Promise<CapsuleRecord> {
  const realm = safeSegment(realmId);
  const parsed = parseCreateCapsuleInput(input);
  const capsuleId = await nextCapsuleId(realm, parsed.id ?? slugify(parsed.name));
  const capsulesRoot = path.join(realmsRoot, realm, "capsules");
  const capsulePath = path.join(capsulesRoot, capsuleId);
  const publicPath = path.join(capsulePath, "public");
  const dataPath = path.join(capsulePath, "data");
  const description =
    parsed.description?.trim() || "A local static capsule created from a template.";
  const manifest: CapsuleManifest = {
    capabilities: {
      commands: [],
      files: [],
      network: [],
      storage: ["own-data"]
    },
    description,
    entry: {
      path: "public/index.html",
      type: "static"
    },
    id: capsuleId,
    name: parsed.name,
    version: "0.0.1"
  };
  const template = await readFile(path.join(templatePath, "public", "index.html"), "utf8");
  const html = template
    .replaceAll("{{CAPSULE_NAME}}", escapeHtml(manifest.name))
    .replaceAll("{{CAPSULE_DESCRIPTION}}", escapeHtml(description));

  await mkdir(publicPath, { recursive: true });
  await mkdir(dataPath, { recursive: true });
  await writeFile(path.join(capsulePath, "capsule.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(publicPath, "index.html"), html);

  const capsule = await findCapsule(realm, capsuleId);
  if (!capsule) {
    throw new Error("Created capsule could not be loaded");
  }

  return capsule;
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
