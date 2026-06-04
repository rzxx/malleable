import { Archive, Code2, Copy, ExternalLink, Play, RefreshCw, Trash2 } from "lucide-react";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";

import "./styles.css";

const apiBase = "http://localhost:4877";

const RealmSchema = z.object({
  id: z.string(),
  path: z.string()
});

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
    entry: z.object({
      path: z.string(),
      type: z.literal("static")
    }),
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

type Realm = z.infer<typeof RealmSchema>;
type Capsule = z.infer<typeof CapsuleSchema>;

async function readJson(response: Response): Promise<unknown> {
  return await response.json();
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

function App() {
  const [realms, setRealms] = useState<Realm[]>([]);
  const [capsules, setCapsules] = useState<Capsule[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [runningUrl, setRunningUrl] = useState<string>();
  const [status, setStatus] = useState("Connecting to daemon");

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

  async function launch(capsule: Capsule) {
    setStatus(`Launching ${capsule.manifest.name}`);
    const response = await fetch(
      `${apiBase}/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/launch`,
      { method: "POST" }
    );
    setRunningUrl(readLaunchPayload(await readJson(response)));
    setStatus("Running");
  }

  useEffect(() => {
    load().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : "Daemon unavailable");
    });
  }, []);

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
                <span>{selected.manifest.description ?? selected.sourcePath}</span>
              </div>
              <nav className="actions" aria-label="Capsule actions">
                <button
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
                  title="Refresh capsule list"
                  onClick={() => {
                    load().catch((error: unknown) => {
                      setStatus(error instanceof Error ? error.message : "Refresh failed");
                    });
                  }}
                >
                  <RefreshCw size={17} />
                </button>
                <button title="Fork capsule" disabled>
                  <Copy size={17} />
                </button>
                <button title="Archive capsule" disabled>
                  <Archive size={17} />
                </button>
                <button title="Delete capsule" disabled>
                  <Trash2 size={17} />
                </button>
              </nav>
            </header>

            <div className="content-grid">
              <section className="preview">
                {runningUrl ? (
                  <iframe
                    title="Running capsule"
                    src={runningUrl}
                    sandbox="allow-forms allow-modals allow-popups allow-scripts"
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
