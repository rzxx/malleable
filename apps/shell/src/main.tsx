import { Archive, Code2, Copy, ExternalLink, FolderOpen, Play, Plus, Trash2 } from "lucide-react";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";

import "./styles.css";

const apiBase = "http://127.0.0.1:4877";

const RealmSchema = z.object({
  id: z.string(),
  path: z.string()
});

const CapsuleEntrySchema = z.discriminatedUnion("type", [
  z.object({
    path: z.string(),
    type: z.literal("static")
  }),
  z.object({
    framework: z.enum(["vanilla", "react", "solid", "svelte"]),
    main: z.string(),
    reload: z.literal("auto"),
    type: z.literal("web")
  })
]);

const CapsuleSchema = z.object({
  capsulePath: z.string(),
  launchUrl: z.string(),
  manifest: z.object({
    capabilities: z.object({
      commands: z.array(z.string()),
      files: z.array(z.string()),
      network: z.array(z.string()),
      storage: z.array(z.string())
    }),
    description: z.string().optional(),
    entry: CapsuleEntrySchema,
    id: z.string(),
    name: z.string(),
    version: z.string()
  }),
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

const ActionPayloadSchema = z.object({
  archived: z.boolean().optional(),
  deleted: z.boolean().optional(),
  opened: z.boolean().optional()
});

const CreateCapsulePayloadSchema = z.object({
  capsule: CapsuleSchema
});

type Realm = z.infer<typeof RealmSchema>;
type Capsule = z.infer<typeof CapsuleSchema>;

async function readJson(response: Response): Promise<unknown> {
  return await response.json();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readRealmsPayload(value: unknown): Realm[] {
  return RealmsPayloadSchema.parse(value).realms;
}

function readCapsulesPayload(value: unknown): Capsule[] {
  return CapsulesPayloadSchema.parse(value).capsules;
}

function readLaunchPayload(value: unknown): string {
  return LaunchPayloadSchema.parse(value).url;
}

function readCreateCapsulePayload(value: unknown): Capsule {
  return CreateCapsulePayloadSchema.parse(value).capsule;
}

function readActionPayload(value: unknown): void {
  ActionPayloadSchema.parse(value);
}

function App() {
  const [realms, setRealms] = useState<Realm[]>([]);
  const [capsules, setCapsules] = useState<Capsule[]>([]);
  const [iframeNonce, setIframeNonce] = useState(0);
  const [newCapsuleDescription, setNewCapsuleDescription] = useState("");
  const [newCapsuleName, setNewCapsuleName] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [runningUrl, setRunningUrl] = useState<string>();
  const [status, setStatus] = useState("Connecting to daemon");
  const [activeAction, setActiveAction] = useState<string>();
  const [isCreating, setIsCreating] = useState(false);

  const selected = useMemo(
    () => capsules.find((capsule) => capsule.manifest.id === selectedId) ?? capsules[0],
    [capsules, selectedId]
  );

  async function load() {
    setStatus("Loading realm");
    const realmResponse = await fetch(`${apiBase}/api/realms`);
    const realmsData = readRealmsPayload(await readJson(realmResponse));
    setRealms(realmsData);

    const realm = realmsData[0];
    if (!realm) {
      setCapsules([]);
      setStatus("No realms found");
      return;
    }

    const capsuleResponse = await fetch(`${apiBase}/api/realms/${realm.id}/capsules`);
    const capsulesData = readCapsulesPayload(await readJson(capsuleResponse));
    setCapsules(capsulesData);
    setSelectedId((current) => current ?? capsulesData[0]?.manifest.id);
    setStatus("Ready");
  }

  async function loadWithRetry(signal: AbortSignal) {
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      try {
        await load();
        return;
      } catch (error) {
        if (signal.aborted) {
          return;
        }

        setStatus(
          attempt === 1
            ? "Waiting for daemon"
            : error instanceof Error
              ? `Waiting for daemon - ${error.message}`
              : "Waiting for daemon"
        );
        await delay(Math.min(500 + attempt * 150, 2_000));
      }
    }

    setStatus("Daemon unavailable");
  }

  async function launch(capsule: Capsule) {
    setStatus(`Launching ${capsule.manifest.name}`);
    const response = await fetch(
      `${apiBase}/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/launch`,
      { method: "POST" }
    );
    setRunningUrl(readLaunchPayload(await readJson(response)));
    setIframeNonce((current) => current + 1);
    setStatus("Running");
  }

  async function sendCapsuleAction(
    capsule: Capsule,
    action: "archive" | "fork" | "source/open",
    label: string
  ): Promise<unknown> {
    setActiveAction(action);
    setStatus(label);

    try {
      const response = await fetch(
        `${apiBase}/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/${action}`,
        { method: "POST" }
      );
      const payload = await readJson(response);

      if (!response.ok) {
        const message = z.object({ error: z.string() }).safeParse(payload).data?.error;
        throw new Error(message ?? `${label} failed`);
      }

      return payload;
    } finally {
      setActiveAction(undefined);
    }
  }

  function removeCapsule(capsule: Capsule) {
    setCapsules((current) => {
      const remaining = current.filter((existing) => existing.manifest.id !== capsule.manifest.id);
      setSelectedId(remaining[0]?.manifest.id);
      return remaining;
    });

    if (runningUrl?.includes(`/capsules/${capsule.realmId}/${capsule.manifest.id}/`)) {
      setRunningUrl(undefined);
    }
  }

  async function createCapsule() {
    const realm = realms[0];
    const name = newCapsuleName.trim();
    const description = newCapsuleDescription.trim();

    if (!realm || !name || isCreating) {
      return;
    }

    setIsCreating(true);
    setStatus("Creating capsule");

    try {
      const response = await fetch(`${apiBase}/api/realms/${realm.id}/capsules`, {
        body: JSON.stringify({
          description: description || undefined,
          name,
          templateId: "web-react"
        }),
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST"
      });

      const payload = await readJson(response);
      if (!response.ok) {
        const message = z.object({ error: z.string() }).safeParse(payload).data?.error;
        throw new Error(message ?? "Create failed");
      }

      const capsule = readCreateCapsulePayload(payload);
      setCapsules((current) => [
        capsule,
        ...current.filter((existing) => existing.manifest.id !== capsule.manifest.id)
      ]);
      setSelectedId(capsule.manifest.id);
      setRunningUrl(undefined);
      setNewCapsuleName("");
      setNewCapsuleDescription("");
      setStatus("Created");
    } finally {
      setIsCreating(false);
    }
  }

  async function forkCapsule(capsule: Capsule) {
    const payload = await sendCapsuleAction(capsule, "fork", "Forking capsule");
    const fork = readCreateCapsulePayload(payload);
    setCapsules((current) => [
      fork,
      ...current.filter((existing) => existing.manifest.id !== fork.manifest.id)
    ]);
    setSelectedId(fork.manifest.id);
    setRunningUrl(undefined);
    setStatus("Forked");
  }

  async function openSource(capsule: Capsule) {
    readActionPayload(await sendCapsuleAction(capsule, "source/open", "Opening source"));
    setStatus("Source opened");
  }

  async function archiveCapsule(capsule: Capsule) {
    const confirmed = window.confirm(`Archive ${capsule.manifest.name}?`);
    if (!confirmed) {
      return;
    }

    readActionPayload(await sendCapsuleAction(capsule, "archive", "Archiving capsule"));
    removeCapsule(capsule);
    setStatus("Archived");
  }

  async function deleteCapsule(capsule: Capsule) {
    const confirmed = window.confirm(`Permanently delete ${capsule.manifest.name}?`);
    if (!confirmed) {
      return;
    }

    setActiveAction("delete");
    setStatus("Deleting capsule");

    try {
      const response = await fetch(
        `${apiBase}/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}`,
        { method: "DELETE" }
      );
      const payload = await readJson(response);

      if (!response.ok) {
        const message = z.object({ error: z.string() }).safeParse(payload).data?.error;
        throw new Error(message ?? "Delete failed");
      }

      readActionPayload(payload);
      removeCapsule(capsule);
      setStatus("Deleted");
    } finally {
      setActiveAction(undefined);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    loadWithRetry(controller.signal).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : "Daemon unavailable");
    });

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const events = new EventSource(`${apiBase}/api/capsule-events`);

    function readStatus(event: MessageEvent<string>) {
      const parsed = CapsuleStatusSchema.safeParse(JSON.parse(event.data) as unknown);
      if (!parsed.success) {
        return;
      }

      const nextStatus = parsed.data;
      const capsuleUrl = `/capsules/${nextStatus.realmId}/${nextStatus.capsuleId}/`;
      if (!runningUrl?.includes(capsuleUrl)) {
        return;
      }

      if (nextStatus.state === "dirty") {
        setStatus("Capsule source changed");
        return;
      }

      if (nextStatus.state === "error") {
        setStatus(nextStatus.error ?? "Capsule build failed");
        return;
      }

      setStatus("Capsule updated");
    }

    events.addEventListener("capsule", readStatus);
    events.addEventListener("error", () => {
      setStatus("Capsule watch disconnected");
    });

    return () => {
      events.close();
    };
  }, [runningUrl]);

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Code2 size={22} />
          <div>
            <h1>Malleable</h1>
            <span>{status}</span>
          </div>
        </div>

        <section className="realm-strip">
          <span>Realm</span>
          <strong>{realms[0]?.id ?? "none"}</strong>
        </section>

        <form
          className="create-capsule"
          onSubmit={(event) => {
            event.preventDefault();
            createCapsule().catch((error: unknown) => {
              setStatus(error instanceof Error ? error.message : "Create failed");
            });
          }}
        >
          <label htmlFor="capsule-name">New capsule</label>
          <input
            aria-label="Capsule name"
            id="capsule-name"
            placeholder="Tool name"
            value={newCapsuleName}
            onChange={(event) => setNewCapsuleName(event.target.value)}
          />
          <textarea
            aria-label="Capsule description"
            placeholder="Short purpose"
            rows={3}
            value={newCapsuleDescription}
            onChange={(event) => setNewCapsuleDescription(event.target.value)}
          />
          <button type="submit" disabled={!newCapsuleName.trim() || isCreating}>
            <Plus size={17} />
            Create
          </button>
        </form>

        <section className="capsule-list" aria-label="Capsules">
          {capsules.map((capsule) => (
            <button
              className={
                capsule.manifest.id === selected?.manifest.id ? "capsule active" : "capsule"
              }
              key={capsule.manifest.id}
              onClick={() => setSelectedId(capsule.manifest.id)}
            >
              <strong>{capsule.manifest.name}</strong>
              <span>{capsule.manifest.id}</span>
            </button>
          ))}
        </section>
      </aside>

      <section className="workspace">
        {selected ? (
          <>
            <header className="toolbar">
              <div>
                <h2>{selected.manifest.name}</h2>
                <span>
                  {selected.manifest.entry.type === "web"
                    ? `${selected.manifest.entry.framework} - ${selected.manifest.entry.main}`
                    : selected.manifest.entry.path}
                </span>
              </div>
              <nav className="actions" aria-label="Capsule actions">
                <button
                  type="button"
                  title="Launch capsule"
                  onClick={() => {
                    launch(selected).catch((error: unknown) => {
                      setStatus(error instanceof Error ? error.message : "Launch failed");
                    });
                  }}
                >
                  <Play size={17} />
                  Run
                </button>
                <button
                  type="button"
                  title="Open capsule source"
                  disabled={Boolean(activeAction)}
                  onClick={() => {
                    openSource(selected).catch((error: unknown) => {
                      setStatus(error instanceof Error ? error.message : "Open source failed");
                    });
                  }}
                >
                  <FolderOpen size={17} />
                  Source
                </button>
                <button
                  type="button"
                  title="Fork capsule"
                  disabled={Boolean(activeAction)}
                  onClick={() => {
                    forkCapsule(selected).catch((error: unknown) => {
                      setStatus(error instanceof Error ? error.message : "Fork failed");
                    });
                  }}
                >
                  <Copy size={17} />
                  Fork
                </button>
                <button
                  type="button"
                  title="Archive capsule"
                  disabled={Boolean(activeAction)}
                  onClick={() => {
                    archiveCapsule(selected).catch((error: unknown) => {
                      setStatus(error instanceof Error ? error.message : "Archive failed");
                    });
                  }}
                >
                  <Archive size={17} />
                  Archive
                </button>
                <button
                  type="button"
                  title="Delete capsule"
                  disabled={Boolean(activeAction)}
                  onClick={() => {
                    deleteCapsule(selected).catch((error: unknown) => {
                      setStatus(error instanceof Error ? error.message : "Delete failed");
                    });
                  }}
                >
                  <Trash2 size={17} />
                  Delete
                </button>
              </nav>
            </header>

            <div className="content-grid">
              <section className="preview">
                {runningUrl ? (
                  <iframe
                    key={iframeNonce}
                    title="Running capsule"
                    src={runningUrl}
                    sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                  />
                ) : (
                  <div className="empty-preview">
                    <Play size={34} />
                    <span>Launch a capsule</span>
                  </div>
                )}
              </section>

              <section className="inspector">
                <div className="inspector-header">
                  <h3>Manifest</h3>
                  {runningUrl ? (
                    <a
                      href={runningUrl}
                      target="_blank"
                      rel="noreferrer"
                      title="Open capsule in new tab"
                    >
                      <ExternalLink size={17} />
                    </a>
                  ) : null}
                </div>
                <pre>{JSON.stringify(selected.manifest, null, 2)}</pre>
              </section>
            </div>
          </>
        ) : (
          <section className="empty-state">
            <h2>No capsules</h2>
            <span>Create one in the default realm to start the loop.</span>
          </section>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
