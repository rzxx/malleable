import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

import type { CapsuleManifest } from "@malleable/capsule-schema";
import react from "@vitejs/plugin-react";
import { createServer, normalizePath, type Plugin, type ViteDevServer } from "vite";

export type CapsuleRuntimeRecord = {
  readonly capsulePath: string;
  readonly manifest: CapsuleManifest;
  readonly realmId: string;
};

export type CapsuleStatus =
  | {
      readonly capsuleId: string;
      readonly error?: undefined;
      readonly realmId: string;
      readonly revision: number;
      readonly state: "dirty" | "ready";
    }
  | {
      readonly capsuleId: string;
      readonly error: string;
      readonly realmId: string;
      readonly revision: number;
      readonly state: "error";
      readonly updatedAt: string;
    };

type ActiveCapsule = {
  readonly capsulePath: string;
  readonly entryPath: string;
  readonly manifest: CapsuleManifest;
  readonly realmId: string;
};

type WebCapsuleRuntimeRecord = CapsuleRuntimeRecord & {
  readonly manifest: CapsuleManifest & {
    readonly entry: Extract<CapsuleManifest["entry"], { readonly type: "web" }>;
  };
};

type StatusListener = (status: CapsuleStatus) => void;

const requireFromDaemon = createRequire(import.meta.url);
const reactPackageRoot = path.dirname(requireFromDaemon.resolve("react/package.json"));
const reactDomPackageRoot = path.dirname(requireFromDaemon.resolve("react-dom/package.json"));
const reactAliases = {
  react: normalizePath(requireFromDaemon.resolve("react")),
  "react-dom": normalizePath(requireFromDaemon.resolve("react-dom")),
  "react-dom/client": normalizePath(requireFromDaemon.resolve("react-dom/client")),
  "react/jsx-dev-runtime": normalizePath(requireFromDaemon.resolve("react/jsx-dev-runtime")),
  "react/jsx-runtime": normalizePath(requireFromDaemon.resolve("react/jsx-runtime"))
} as const;
const entryPrefix = "/__malleable_capsule_entry__/";
const clientPrefix = "/__malleable_capsule_client__/";
const virtualEntryPrefix = "\0malleable-capsule-entry:";
const virtualClientPrefix = "\0malleable-capsule-client:";

function capsuleKey(realmId: string, capsuleId: string): string {
  return `${realmId}/${capsuleId}`;
}

function isWebCapsule(capsule: CapsuleRuntimeRecord): capsule is WebCapsuleRuntimeRecord {
  return capsule.manifest.entry.type === "web";
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function normalizeWebSourcePath(capsule: CapsuleRuntimeRecord, sourcePath: string): string {
  const resolved = path.resolve(capsule.capsulePath, sourcePath);
  const root = path.resolve(capsule.capsulePath);

  if (!resolved.startsWith(root)) {
    throw new Error("Capsule entry points outside its folder");
  }

  return resolved;
}

function parseVirtualUrl(
  prefix: string,
  id: string
): { capsuleId: string; realmId: string } | undefined {
  if (!id.startsWith(prefix)) {
    return undefined;
  }

  const [realmId, capsuleId] = id.slice(prefix.length).split("/");
  if (!realmId || !capsuleId) {
    return undefined;
  }

  return {
    capsuleId,
    realmId
  };
}

function isInside(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function readCapsuleForFile(
  capsules: ReadonlyMap<string, ActiveCapsule>,
  filePath: string
): ActiveCapsule | undefined {
  const resolved = path.resolve(filePath);
  return [...capsules.values()].find((capsule) => isInside(resolved, capsule.capsulePath));
}

function readReactAlias(id: string): string | undefined {
  switch (id) {
    case "react":
      return reactAliases.react;
    case "react-dom":
      return reactAliases["react-dom"];
    case "react-dom/client":
      return reactAliases["react-dom/client"];
    case "react/jsx-dev-runtime":
      return reactAliases["react/jsx-dev-runtime"];
    case "react/jsx-runtime":
      return reactAliases["react/jsx-runtime"];
    default:
      return undefined;
  }
}

function isSourceModuleUrl(url: string): boolean {
  return url.startsWith("/realms/") || url.startsWith("/packages/") || url.startsWith("/@fs/");
}

export class SharedCapsuleViteHost {
  readonly #activeCapsules = new Map<string, ActiveCapsule>();
  readonly #idleTimeoutMs = 90_000;
  readonly #listeners = new Set<StatusListener>();
  readonly #revisions = new Map<string, number>();
  readonly #statuses = new Map<string, CapsuleStatus>();
  readonly #workspaceRoot: string;
  #idleTimer: NodeJS.Timeout | undefined;
  #vite: Promise<ViteDevServer> | undefined;

  constructor(workspaceRoot: string) {
    this.#workspaceRoot = workspaceRoot;
  }

  subscribe(listener: StatusListener): () => void {
    this.#listeners.add(listener);
    for (const status of this.#statuses.values()) {
      listener(status);
    }

    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#closeAfterIdle();
      }
    };
  }

  readStatus(capsule: CapsuleRuntimeRecord): CapsuleStatus | undefined {
    return this.#statuses.get(capsuleKey(capsule.realmId, capsule.manifest.id));
  }

  async activate(capsule: CapsuleRuntimeRecord): Promise<void> {
    if (!isWebCapsule(capsule)) {
      return;
    }

    if (
      capsule.manifest.entry.framework === "solid" ||
      capsule.manifest.entry.framework === "svelte"
    ) {
      throw new Error(`${capsule.manifest.entry.framework} capsules need an adapter before launch`);
    }

    const key = capsuleKey(capsule.realmId, capsule.manifest.id);
    this.#activeCapsules.set(key, {
      capsulePath: path.resolve(capsule.capsulePath),
      entryPath: normalizeWebSourcePath(capsule, capsule.manifest.entry.main),
      manifest: capsule.manifest,
      realmId: capsule.realmId
    });
    await this.#ensureVite();
    this.#emitReady(capsule.realmId, capsule.manifest.id);
  }

  async renderHtml(capsule: CapsuleRuntimeRecord): Promise<string> {
    if (capsule.manifest.entry.type !== "web") {
      throw new Error("Cannot render native HTML for a static capsule");
    }

    await this.activate(capsule);
    const server = await this.#ensureVite();
    const capsuleBase = `/capsules/${capsule.realmId}/${capsule.manifest.id}/`;
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(capsule.manifest.name)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${clientPrefix}${capsule.realmId}/${capsule.manifest.id}"></script>
    <script type="module" src="${entryPrefix}${capsule.realmId}/${capsule.manifest.id}"></script>
  </body>
</html>`;

    return await server.transformIndexHtml(capsuleBase, html);
  }

  async handleViteRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!this.#vite) {
      return false;
    }

    const server = await this.#ensureVite();
    if (request.url && isSourceModuleUrl(request.url)) {
      const transformed = await server.transformRequest(request.url);
      if (transformed) {
        response.writeHead(200, {
          "Cache-Control": "no-cache",
          "Content-Type": "text/javascript"
        });
        response.end(transformed.code);
        return true;
      }
    }

    const handled = await new Promise<boolean>((resolve) => {
      server.middlewares(request, response, () => {
        resolve(false);
      });
      response.once("finish", () => {
        resolve(true);
      });
    });

    if (handled || response.writableEnded || !request.url) {
      return handled;
    }

    const transformed = await server.transformRequest(request.url);
    if (!transformed) {
      return false;
    }

    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Type": "text/javascript"
    });
    response.end(transformed.code);
    return true;
  }

  #closeAfterIdle(): void {
    if (!this.#vite || this.#idleTimer) {
      return;
    }

    this.#idleTimer = setTimeout(() => {
      this.#activeCapsules.clear();
      const vite = this.#vite;
      this.#vite = undefined;
      this.#idleTimer = undefined;
      vite?.then((server) => server.close()).catch(() => undefined);
    }, this.#idleTimeoutMs);
  }

  #emit(status: CapsuleStatus): void {
    this.#statuses.set(capsuleKey(status.realmId, status.capsuleId), status);
    for (const listener of this.#listeners) {
      listener(status);
    }
  }

  #emitReady(realmId: string, capsuleId: string): void {
    const revision = this.#nextRevision(realmId, capsuleId);
    this.#emit({
      capsuleId,
      realmId,
      revision,
      state: "ready"
    });
  }

  #nextRevision(realmId: string, capsuleId: string): number {
    const key = capsuleKey(realmId, capsuleId);
    const revision = (this.#revisions.get(key) ?? 0) + 1;
    this.#revisions.set(key, revision);
    return revision;
  }

  async #ensureVite(): Promise<ViteDevServer> {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }

    this.#vite ??= createServer({
      appType: "custom",
      clearScreen: false,
      configFile: false,
      root: this.#workspaceRoot,
      server: {
        fs: {
          allow: [
            path.join(this.#workspaceRoot, "realms"),
            path.join(this.#workspaceRoot, "packages", "capsule-system"),
            path.join(this.#workspaceRoot, "packages", "capsule-state"),
            reactPackageRoot,
            reactDomPackageRoot
          ],
          strict: true
        },
        hmr: {
          host: "127.0.0.1"
        },
        middlewareMode: true
      },
      plugins: [react(), this.#capsulePlugin()],
      resolve: {
        alias: [
          {
            find: "@malleable/capsule-system",
            replacement: normalizePath(
              path.join(this.#workspaceRoot, "packages", "capsule-system", "src", "index.ts")
            )
          },
          {
            find: "@malleable/capsule-state",
            replacement: normalizePath(
              path.join(this.#workspaceRoot, "packages", "capsule-state", "src", "index.ts")
            )
          },
          {
            find: "react-dom/client",
            replacement: reactAliases["react-dom/client"]
          },
          {
            find: "react/jsx-dev-runtime",
            replacement: reactAliases["react/jsx-dev-runtime"]
          },
          {
            find: "react/jsx-runtime",
            replacement: reactAliases["react/jsx-runtime"]
          },
          {
            find: "react-dom",
            replacement: reactAliases["react-dom"]
          },
          {
            find: "react",
            replacement: reactAliases.react
          }
        ],
        dedupe: ["react", "react-dom"]
      }
    });

    return await this.#vite;
  }

  #capsulePlugin(): Plugin {
    return {
      enforce: "pre",
      name: "malleable-capsules",
      configureServer: (server) => {
        server.watcher.on("change", (filePath) => {
          const capsule = readCapsuleForFile(this.#activeCapsules, filePath);
          if (!capsule) {
            return;
          }

          const revision = this.#nextRevision(capsule.realmId, capsule.manifest.id);
          this.#emit({
            capsuleId: capsule.manifest.id,
            realmId: capsule.realmId,
            revision,
            state: "dirty"
          });

          if (path.basename(filePath) === "capsule.json") {
            server.ws.send({
              data: {
                capsuleId: capsule.manifest.id,
                realmId: capsule.realmId
              },
              event: "malleable:capsule-full-reload",
              type: "custom"
            });
          }
        });
      },
      handleHotUpdate: (context) => {
        const capsule = readCapsuleForFile(this.#activeCapsules, context.file);
        if (!capsule) {
          return undefined;
        }

        this.#emitReady(capsule.realmId, capsule.manifest.id);
        context.server.ws.send({
          data: {
            capsuleId: capsule.manifest.id,
            file: normalizePath(context.file),
            realmId: capsule.realmId
          },
          event: "malleable:capsule-hmr",
          type: "custom"
        });

        return context.modules;
      },
      load: (id) => {
        if (id.startsWith(virtualEntryPrefix)) {
          const capsule = this.#activeCapsules.get(id.slice(virtualEntryPrefix.length));
          if (!capsule) {
            return null;
          }

          return `import ${JSON.stringify(`/@fs/${normalizePath(capsule.entryPath)}`)};`;
        }

        if (id.startsWith(virtualClientPrefix)) {
          const capsule = this.#activeCapsules.get(id.slice(virtualClientPrefix.length));
          if (!capsule) {
            return null;
          }

          return `
if (import.meta.hot) {
  import.meta.hot.on("malleable:capsule-full-reload", (event) => {
    if (event.realmId === ${JSON.stringify(capsule.realmId)} && event.capsuleId === ${JSON.stringify(capsule.manifest.id)}) {
      location.reload();
    }
  });
}
`;
        }

        return null;
      },
      resolveId: (id) => {
        if (id === "@malleable/capsule-system") {
          return path.join(this.#workspaceRoot, "packages", "capsule-system", "src", "index.ts");
        }

        if (id === "@malleable/capsule-state") {
          return path.join(this.#workspaceRoot, "packages", "capsule-state", "src", "index.ts");
        }

        const reactAlias = readReactAlias(id);
        if (reactAlias) {
          return reactAlias;
        }

        const entry = parseVirtualUrl(entryPrefix, id);
        if (entry) {
          return `${virtualEntryPrefix}${capsuleKey(entry.realmId, entry.capsuleId)}`;
        }

        const client = parseVirtualUrl(clientPrefix, id);
        if (client) {
          return `${virtualClientPrefix}${capsuleKey(client.realmId, client.capsuleId)}`;
        }

        return null;
      },
      transform: (code, id) => {
        const capsule = readCapsuleForFile(this.#activeCapsules, id);
        if (!capsule) {
          return null;
        }

        return code
          .replaceAll("__MALLEABLE_CAPSULE_NAME_JSON__", JSON.stringify(capsule.manifest.name))
          .replaceAll(
            "__MALLEABLE_CAPSULE_DESCRIPTION_JSON__",
            JSON.stringify(capsule.manifest.description ?? "")
          );
      }
    };
  }
}
