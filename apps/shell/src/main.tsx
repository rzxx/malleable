import {
  Code2,
  ExternalLink,
  FolderOpen,
  Play,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  X
} from "lucide-react";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { z } from "zod";

import "./styles.css";

declare global {
  var malleableShellRoot: Root | undefined;
}

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

const CapabilityRequestSchema = z.object({
  access: z.array(z.string()),
  command: z.string().optional(),
  hosts: z.array(z.string()).optional(),
  path: z.string().optional(),
  scope: z.string()
});

const CapsuleSchema = z.object({
  capsulePath: z.string(),
  launchUrl: z.string(),
  manifest: z.object({
    capabilities: z.object({
      commands: z.array(CapabilityRequestSchema),
      files: z.array(CapabilityRequestSchema),
      network: z.array(CapabilityRequestSchema),
      storage: z.array(CapabilityRequestSchema),
      system: z.array(CapabilityRequestSchema)
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

const CapabilityDescriptorSchema = z.object({
  access: z.array(z.string()),
  autoAllow: z.boolean(),
  capability: z.enum(["commands", "files", "network", "storage", "system"]),
  key: z.string(),
  label: z.string(),
  prompt: z.enum(["ask", "auto", "explicit-trust"]),
  risk: z.enum(["critical", "high", "low", "medium"]),
  scope: z.record(z.string(), z.unknown())
});

const PermissionGrantSchema = z.object({
  access: z.array(z.string()),
  capability: z.enum(["commands", "files", "network", "storage", "system"]),
  decision: z.enum(["allow", "deny"]),
  id: z.string(),
  lifetime: z.enum(["once", "session", "persistent"]),
  manifestHash: z.string(),
  scope: z.record(z.string(), z.unknown())
});

const PermissionSummarySchema = z.object({
  diff: z.object({
    added: z.array(z.string()),
    existing: z.array(z.string()),
    removed: z.array(z.string())
  }),
  events: z.array(z.unknown()),
  grants: z.array(PermissionGrantSchema),
  manifestHash: z.string(),
  requested: z.array(CapabilityDescriptorSchema),
  trusted: z.boolean()
});

const PermissionPayloadSchema = z.object({
  permissions: PermissionSummarySchema
});

type Realm = z.infer<typeof RealmSchema>;
type Capsule = z.infer<typeof CapsuleSchema>;
type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;
type PermissionGrant = z.infer<typeof PermissionGrantSchema>;
type PermissionSummary = z.infer<typeof PermissionSummarySchema>;

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

function readPermissionPayload(value: unknown): PermissionSummary {
  return PermissionPayloadSchema.parse(value).permissions;
}

function scopeText(scope: Record<string, unknown>): string {
  const suffix =
    typeof scope.path === "string"
      ? ` ${scope.path}`
      : typeof scope.command === "string"
        ? ` ${scope.command}`
        : Array.isArray(scope.hosts)
          ? ` ${scope.hosts.join(", ")}`
          : "";

  return `${String(scope.scope)}${suffix}`;
}

function grantMatchesDescriptor(grant: PermissionGrant, descriptor: CapabilityDescriptor): boolean {
  return (
    grant.decision === "allow" &&
    grant.capability === descriptor.capability &&
    JSON.stringify(grant.scope) === JSON.stringify(descriptor.scope)
  );
}

function App() {
  const [realms, setRealms] = useState<Realm[]>([]);
  const [capsules, setCapsules] = useState<Capsule[]>([]);
  const [iframeNonce, setIframeNonce] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [runningUrl, setRunningUrl] = useState<string>();
  const [status, setStatus] = useState("Connecting to daemon");
  const [activeAction, setActiveAction] = useState<string>();
  const [permissions, setPermissions] = useState<PermissionSummary>();

  const selected = useMemo(
    () => capsules.find((capsule) => capsule.manifest.id === selectedId) ?? capsules[0],
    [capsules, selectedId]
  );

  const pendingDescriptors = useMemo(() => {
    if (!permissions) {
      return [];
    }

    return permissions.requested.filter(
      (descriptor) =>
        !descriptor.autoAllow &&
        !permissions.grants.some((grant) => grantMatchesDescriptor(grant, descriptor))
    );
  }, [permissions]);

  const hasPermissionWork = Boolean(
    permissions &&
    (pendingDescriptors.length || permissions.diff.added.length || permissions.diff.removed.length)
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

  async function loadPermissions(capsule: Capsule) {
    const response = await fetch(
      `${apiBase}/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/permissions`
    );
    const payload = await readJson(response);
    if (!response.ok) {
      const message = z.object({ error: z.string() }).safeParse(payload).data?.error;
      throw new Error(message ?? "Permission load failed");
    }

    setPermissions(readPermissionPayload(payload));
  }

  async function updateGrant(
    capsule: Capsule,
    descriptor: CapabilityDescriptor,
    lifetime: "persistent" | "session",
    decision: "allow" | "deny" = "allow"
  ) {
    setActiveAction("permission");
    setStatus("Updating permission");
    try {
      const response = await fetch(
        `${apiBase}/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/permissions/grants`,
        {
          body: JSON.stringify({
            decision,
            descriptorKey: descriptor.key,
            lifetime
          }),
          headers: {
            "Content-Type": "application/json"
          },
          method: "POST"
        }
      );
      setPermissions(readPermissionPayload(await readJson(response)));
      setStatus("Permission updated");
    } finally {
      setActiveAction(undefined);
    }
  }

  async function trustCapsule(capsule: Capsule, trusted: boolean) {
    setActiveAction("permission");
    setStatus(trusted ? "Granting trusted access" : "Removing trusted access");
    try {
      const response = await fetch(
        `${apiBase}/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/permissions/trust`,
        {
          body: JSON.stringify({ trusted }),
          headers: {
            "Content-Type": "application/json"
          },
          method: "POST"
        }
      );
      setPermissions(readPermissionPayload(await readJson(response)));
      setStatus(trusted ? "Trusted access granted" : "Trusted access removed");
    } finally {
      setActiveAction(undefined);
    }
  }

  async function acknowledgeManifest(capsule: Capsule) {
    setActiveAction("permission");
    setStatus("Acknowledging manifest");
    try {
      const response = await fetch(
        `${apiBase}/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/permissions/acknowledge`,
        { method: "POST" }
      );
      setPermissions(readPermissionPayload(await readJson(response)));
      setStatus("Manifest acknowledged");
    } finally {
      setActiveAction(undefined);
    }
  }

  async function openSource(capsule: Capsule) {
    setActiveAction("source/open");
    setStatus("Opening source");
    try {
      const response = await fetch(
        `${apiBase}/api/realms/${capsule.realmId}/capsules/${capsule.manifest.id}/source/open`,
        { method: "POST" }
      );
      const payload = await readJson(response);
      if (!response.ok) {
        const message = z.object({ error: z.string() }).safeParse(payload).data?.error;
        throw new Error(message ?? "Open source failed");
      }
      setStatus("Source opened");
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
    if (!selected) {
      setPermissions(undefined);
      return;
    }

    loadPermissions(selected).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : "Permission load failed");
      setPermissions(undefined);
    });
  }, [selected]);

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
                <span>{selected.manifest.id}</span>
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
              </nav>
            </header>

            <div className={hasPermissionWork ? "content-grid" : "content-grid no-inspector"}>
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

              {hasPermissionWork && permissions ? (
                <section className="inspector">
                  <div className="inspector-header">
                    <h3>Permissions</h3>
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

                  <div className="permission-panel">
                    {permissions.diff.added.length || permissions.diff.removed.length ? (
                      <section className="permission-section">
                        <div className="section-title">
                          <ShieldAlert size={16} />
                          <strong>Manifest changes</strong>
                          <button
                            type="button"
                            title="Acknowledge manifest changes"
                            disabled={Boolean(activeAction)}
                            onClick={() => {
                              acknowledgeManifest(selected).catch((error: unknown) => {
                                setStatus(
                                  error instanceof Error ? error.message : "Acknowledge failed"
                                );
                              });
                            }}
                          >
                            <RotateCcw size={15} />
                          </button>
                        </div>
                        {permissions.diff.added.map((item) => (
                          <span className="diff added" key={`added-${item}`}>
                            Added {item}
                          </span>
                        ))}
                        {permissions.diff.removed.map((item) => (
                          <span className="diff removed" key={`removed-${item}`}>
                            Removed {item}
                          </span>
                        ))}
                      </section>
                    ) : null}

                    {pendingDescriptors.length ? (
                      <section className="permission-section">
                        <strong>Permission requests</strong>
                        {pendingDescriptors.map((descriptor) => (
                          <div className="permission-row" key={descriptor.key}>
                            <div>
                              <strong>{descriptor.capability}</strong>
                              <span>
                                {scopeText(descriptor.scope)} - {descriptor.access.join("/")} -{" "}
                                {descriptor.risk}
                              </span>
                            </div>
                            <div className="permission-actions">
                              {descriptor.prompt === "explicit-trust" ? (
                                <button
                                  type="button"
                                  disabled={Boolean(activeAction)}
                                  onClick={() => {
                                    trustCapsule(selected, true).catch((error: unknown) => {
                                      setStatus(
                                        error instanceof Error ? error.message : "Trust failed"
                                      );
                                    });
                                  }}
                                >
                                  <ShieldCheck size={16} />
                                  Trust
                                </button>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    disabled={Boolean(activeAction)}
                                    onClick={() => {
                                      updateGrant(selected, descriptor, "session").catch(
                                        (error: unknown) => {
                                          setStatus(
                                            error instanceof Error ? error.message : "Grant failed"
                                          );
                                        }
                                      );
                                    }}
                                  >
                                    Session
                                  </button>
                                  <button
                                    type="button"
                                    disabled={Boolean(activeAction)}
                                    onClick={() => {
                                      updateGrant(selected, descriptor, "persistent").catch(
                                        (error: unknown) => {
                                          setStatus(
                                            error instanceof Error ? error.message : "Grant failed"
                                          );
                                        }
                                      );
                                    }}
                                  >
                                    Always
                                  </button>
                                </>
                              )}
                              <button
                                type="button"
                                title="Deny permission"
                                disabled={Boolean(activeAction)}
                                onClick={() => {
                                  updateGrant(selected, descriptor, "persistent", "deny").catch(
                                    (error: unknown) => {
                                      setStatus(
                                        error instanceof Error ? error.message : "Deny failed"
                                      );
                                    }
                                  );
                                }}
                              >
                                <X size={15} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </section>
                    ) : null}
                  </div>
                </section>
              ) : null}
            </div>
          </>
        ) : (
          <section className="empty-state">
            <h2>No capsules</h2>
            <span>No capsules in this realm.</span>
          </section>
        )}
      </section>
    </main>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Shell root element was not found");
}

const root = globalThis.malleableShellRoot ?? createRoot(rootElement);
globalThis.malleableShellRoot = root;

if (import.meta.hot) {
  import.meta.hot.accept();
}

root.render(
  <StrictMode>
    <App />
  </StrictMode>
);
