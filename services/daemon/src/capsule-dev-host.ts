import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type { CapsuleManifest } from "@malleable/capsule-schema";
import { watch, type FSWatcher } from "chokidar";
import { rolldown, type InputOptions, type OutputAsset, type OutputChunk } from "rolldown";

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
      readonly state: "building" | "dirty";
    }
  | {
      readonly capsuleId: string;
      readonly error?: undefined;
      readonly realmId: string;
      readonly revision: number;
      readonly state: "ready";
      readonly updatedAt: string;
    }
  | {
      readonly capsuleId: string;
      readonly error: string;
      readonly realmId: string;
      readonly revision: number;
      readonly state: "error";
      readonly updatedAt: string;
    };

type BundleAsset = {
  readonly contents: Uint8Array;
  readonly contentType: string;
};

type CapsuleBundle = {
  readonly assets: ReadonlyMap<string, BundleAsset>;
  readonly revision: number;
};

type WatchState = {
  readonly watcher: FSWatcher;
  timer: NodeJS.Timeout | undefined;
};

type StatusListener = (status: CapsuleStatus) => void;

const requireFromDaemon = createRequire(import.meta.url);
const cssModulePrefix = "\0malleable-css:";

function capsuleKey(capsule: CapsuleRuntimeRecord): string {
  return `${capsule.realmId}/${capsule.manifest.id}`;
}

function isWebCapsule(capsule: CapsuleRuntimeRecord): boolean {
  return capsule.manifest.entry.type === "web";
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function readContentType(filePath: string): string {
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }

  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }

  return "application/octet-stream";
}

function readOutputName(filePath: string): string {
  return path.basename(filePath).replace(/^main-[A-Z0-9]+(?=\.)/i, "main");
}

function isOutputChunk(output: OutputAsset | OutputChunk): output is OutputChunk {
  return output.type === "chunk";
}

function normalizeSlashes(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function normalizeWebSourcePath(capsule: CapsuleRuntimeRecord, sourcePath: string): string {
  const resolved = path.resolve(capsule.capsulePath, sourcePath);
  const root = path.resolve(capsule.capsulePath);

  if (!resolved.startsWith(root)) {
    throw new Error("Capsule entry points outside its folder");
  }

  return resolved;
}

function platformResolve(specifier: string, workspaceRoot: string): string | undefined {
  if (specifier === "@malleable/capsule-state") {
    return path.join(workspaceRoot, "packages", "capsule-state", "src", "index.ts");
  }

  if (
    specifier === "react" ||
    specifier === "react-dom" ||
    specifier === "react-dom/client" ||
    specifier === "react/jsx-runtime" ||
    specifier === "react/jsx-dev-runtime"
  ) {
    return requireFromDaemon.resolve(specifier);
  }

  return undefined;
}

function formatBuildError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Capsule build failed";
}

function resolveCssImport(source: string, importer: string | undefined): string | undefined {
  if (!source.endsWith(".css")) {
    return undefined;
  }

  if (path.isAbsolute(source)) {
    return path.resolve(source);
  }

  if (!importer) {
    return path.resolve(source);
  }

  return path.resolve(path.dirname(importer), source);
}

export class CapsuleDevHost {
  readonly #bundles = new Map<string, CapsuleBundle>();
  readonly #listeners = new Set<StatusListener>();
  readonly #revisions = new Map<string, number>();
  readonly #statuses = new Map<string, CapsuleStatus>();
  readonly #watchers = new Map<string, WatchState>();
  readonly #workspaceRoot: string;

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
    };
  }

  readStatus(capsule: CapsuleRuntimeRecord): CapsuleStatus | undefined {
    return this.#statuses.get(capsuleKey(capsule));
  }

  async prepare(capsule: CapsuleRuntimeRecord): Promise<void> {
    if (!isWebCapsule(capsule)) {
      return;
    }

    this.#ensureWatcher(capsule);
    if (!this.#bundles.has(capsuleKey(capsule))) {
      await this.#build(capsule);
    }
  }

  async rebuild(capsule: CapsuleRuntimeRecord): Promise<void> {
    if (!isWebCapsule(capsule)) {
      return;
    }

    this.#ensureWatcher(capsule);
    await this.#build(capsule);
  }

  renderHtml(capsule: CapsuleRuntimeRecord): string {
    if (capsule.manifest.entry.type !== "web") {
      throw new Error("Cannot render native HTML for a static capsule");
    }

    const bundle = this.#bundles.get(capsuleKey(capsule));
    const cssLink = bundle?.assets.has("main.css")
      ? '<link rel="stylesheet" href="./__malleable__/main.css" />'
      : "";

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(capsule.manifest.name)}</title>
    ${cssLink}
    <script type="module" src="./__malleable__/client.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./__malleable__/main.js"></script>
  </body>
</html>`;
  }

  readAsset(capsule: CapsuleRuntimeRecord, assetName: string): BundleAsset | undefined {
    if (capsule.manifest.entry.type !== "web") {
      return undefined;
    }

    if (assetName === "client.js") {
      return {
        contentType: "text/javascript; charset=utf-8",
        contents: new TextEncoder().encode(this.#renderClientScript(capsule))
      };
    }

    return this.#bundles.get(capsuleKey(capsule))?.assets.get(assetName);
  }

  #emit(status: CapsuleStatus): void {
    this.#statuses.set(`${status.realmId}/${status.capsuleId}`, status);
    for (const listener of this.#listeners) {
      listener(status);
    }
  }

  #nextRevision(capsule: CapsuleRuntimeRecord): number {
    const key = capsuleKey(capsule);
    const revision = (this.#revisions.get(key) ?? 0) + 1;
    this.#revisions.set(key, revision);
    return revision;
  }

  #ensureWatcher(capsule: CapsuleRuntimeRecord): void {
    const key = capsuleKey(capsule);
    if (this.#watchers.has(key)) {
      return;
    }

    const watcher = watch(
      [
        path.join(capsule.capsulePath, "capsule.json"),
        path.join(capsule.capsulePath, "src"),
        path.join(capsule.capsulePath, "assets")
      ],
      {
        awaitWriteFinish: {
          pollInterval: 20,
          stabilityThreshold: 80
        },
        ignoreInitial: true
      }
    );
    const watchState: WatchState = {
      timer: undefined,
      watcher
    };

    watcher.on("all", () => {
      const revision = this.#nextRevision(capsule);
      this.#emit({
        capsuleId: capsule.manifest.id,
        realmId: capsule.realmId,
        revision,
        state: "dirty"
      });

      if (watchState.timer) {
        clearTimeout(watchState.timer);
      }

      watchState.timer = setTimeout(() => {
        this.#build(capsule).catch(() => undefined);
      }, 120);
    });

    this.#watchers.set(key, watchState);
  }

  async #build(capsule: CapsuleRuntimeRecord): Promise<void> {
    if (capsule.manifest.entry.type !== "web") {
      return;
    }

    const key = capsuleKey(capsule);
    const revision = this.#nextRevision(capsule);
    this.#emit({
      capsuleId: capsule.manifest.id,
      realmId: capsule.realmId,
      revision,
      state: "building"
    });

    if (
      capsule.manifest.entry.framework === "solid" ||
      capsule.manifest.entry.framework === "svelte"
    ) {
      const error = `${capsule.manifest.entry.framework} capsules are reserved in the manifest format, but this platform build does not include that adapter yet`;
      this.#emit({
        capsuleId: capsule.manifest.id,
        error,
        realmId: capsule.realmId,
        revision,
        state: "error",
        updatedAt: new Date().toISOString()
      });
      throw new Error(error);
    }

    try {
      const entryPoint = normalizeWebSourcePath(capsule, capsule.manifest.entry.main);
      const cssSources = new Map<string, string>();
      const inputOptions: InputOptions = {
        cwd: capsule.capsulePath,
        input: entryPoint,
        logLevel: "silent",
        moduleTypes: {
          ".gif": "dataurl",
          ".jpeg": "dataurl",
          ".jpg": "dataurl",
          ".png": "dataurl",
          ".svg": "dataurl",
          ".webp": "dataurl"
        },
        platform: "browser",
        plugins: [
          {
            name: "malleable-platform-imports",
            resolveId: (specifier) => {
              const resolved = platformResolve(specifier, this.#workspaceRoot);
              return resolved ? { id: resolved } : null;
            }
          },
          {
            name: "malleable-css-imports",
            resolveId: (specifier, importer) => {
              const resolved = resolveCssImport(specifier, importer);
              return resolved ? { id: `${cssModulePrefix}${normalizeSlashes(resolved)}` } : null;
            },
            load: async (id) => {
              if (!id.startsWith(cssModulePrefix)) {
                return null;
              }

              const cssPath = id.slice(cssModulePrefix.length);
              cssSources.set(cssPath, await readFile(cssPath, "utf8"));

              return {
                code: "",
                moduleType: "js"
              };
            }
          }
        ],
        resolve: {
          conditionNames: ["browser", "import", "module", "default"]
        },
        transform: {
          jsx: {
            runtime: capsule.manifest.entry.framework === "react" ? "automatic" : "classic"
          }
        }
      };
      const bundle = await rolldown(inputOptions);
      const generated = await bundle.generate({
        assetFileNames: "assets/[name]-[hash][extname]",
        dir: "out",
        entryFileNames: "main.js",
        format: "esm",
        sourcemap: "inline"
      });
      const assets = new Map<string, BundleAsset>();

      for (const outputFile of generated.output) {
        if (!isOutputChunk(outputFile)) {
          const source =
            typeof outputFile.source === "string"
              ? new TextEncoder().encode(outputFile.source)
              : outputFile.source;

          assets.set(outputFile.fileName, {
            contentType: readContentType(outputFile.fileName),
            contents: source
          });
          continue;
        }

        const name = readOutputName(outputFile.fileName);
        assets.set(name, {
          contentType: readContentType(name),
          contents: new TextEncoder().encode(outputFile.code)
        });
      }

      if (cssSources.size > 0) {
        const css = [...cssSources.values()].join("\n");
        assets.set("main.css", {
          contentType: readContentType("main.css"),
          contents: new TextEncoder().encode(css)
        });
      }

      await bundle.close();

      this.#bundles.set(key, {
        assets,
        revision
      });
      this.#emit({
        capsuleId: capsule.manifest.id,
        realmId: capsule.realmId,
        revision,
        state: "ready",
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      const message = formatBuildError(error);
      this.#emit({
        capsuleId: capsule.manifest.id,
        error: message,
        realmId: capsule.realmId,
        revision,
        state: "error",
        updatedAt: new Date().toISOString()
      });
      throw new Error(message, { cause: error });
    }
  }

  #renderClientScript(capsule: CapsuleRuntimeRecord): string {
    const status = this.readStatus(capsule);
    const revision = status?.revision ?? 0;

    return `
const realmId = ${JSON.stringify(capsule.realmId)};
const capsuleId = ${JSON.stringify(capsule.manifest.id)};
let currentRevision = ${JSON.stringify(revision)};

function showReloadPrompt(message) {
  if (document.getElementById("malleable-reload-prompt")) {
    return;
  }

  const host = document.createElement("div");
  host.id = "malleable-reload-prompt";
  host.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483647;display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #9ba8a1;border-radius:8px;background:#fffef8;color:#172126;box-shadow:0 10px 30px rgba(0,0,0,.16);font:13px/1.3 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;";
  const label = document.createElement("span");
  label.textContent = message;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Reload";
  button.style.cssText = "min-height:30px;border:0;border-radius:6px;padding:0 10px;background:#223238;color:#fffaf1;font:inherit;cursor:pointer;";
  button.addEventListener("click", () => location.reload());
  host.append(label, button);
  document.body.append(host);
}

const events = new EventSource("/api/capsule-events");
events.addEventListener("capsule", (event) => {
  const status = JSON.parse(event.data);
  if (status.realmId !== realmId || status.capsuleId !== capsuleId) {
    return;
  }

  if (status.state === "ready" && status.revision > currentRevision) {
    currentRevision = status.revision;
    showReloadPrompt("Source changed");
  }

  if (status.state === "error") {
    showReloadPrompt("Source has build errors");
  }
});
`;
  }
}
