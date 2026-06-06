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

import {
  acknowledgeManifestChanges,
  apiBase,
  launchCapsule,
  openCapsuleSource,
  parseCapsuleStatusEvent,
  readCapsules,
  readPermissions,
  readRealms,
  setCapsuleTrust,
  updatePermissionGrant,
  type CapabilityDescriptor,
  type Capsule,
  type PermissionDecision,
  type PermissionGrant,
  type PermissionLifetime,
  type PermissionSummary,
  type Realm
} from "./api.js";

import "./styles.css";

declare global {
  var malleableShellRoot: Root | undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  const [selectedRealmId, setSelectedRealmId] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [runningUrl, setRunningUrl] = useState<string>();
  const [status, setStatus] = useState("Connecting to daemon");
  const [activeAction, setActiveAction] = useState<string>();
  const [permissions, setPermissions] = useState<PermissionSummary>();

  const selectedRealm = useMemo(
    () => realms.find((realm) => realm.id === selectedRealmId),
    [realms, selectedRealmId]
  );

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

  async function loadRealmsFromDaemon() {
    setStatus("Loading realms");
    const realmsData = await readRealms();
    setRealms(realmsData);

    if (!realmsData.length) {
      setCapsules([]);
      setSelectedRealmId(undefined);
      setStatus("No realms found");
      return;
    }

    setSelectedRealmId((current) =>
      current && realmsData.some((realm) => realm.id === current) ? current : realmsData[0]?.id
    );
  }

  async function loadCapsulesForRealm(realmId: string) {
    setStatus(`Loading ${realmId}`);
    setRunningUrl(undefined);
    setPermissions(undefined);
    const capsulesData = await readCapsules(realmId);
    setCapsules(capsulesData);
    setSelectedId((current) =>
      current && capsulesData.some((capsule) => capsule.manifest.id === current)
        ? current
        : capsulesData[0]?.manifest.id
    );
    setStatus("Ready");
  }

  async function loadWithRetry(signal: AbortSignal) {
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      try {
        await loadRealmsFromDaemon();
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
    setRunningUrl(await launchCapsule(capsule));
    setIframeNonce((current) => current + 1);
    setStatus("Running");
  }

  async function loadPermissions(capsule: Capsule) {
    setPermissions(await readPermissions(capsule));
  }

  async function updateGrant(
    capsule: Capsule,
    descriptor: CapabilityDescriptor,
    lifetime: PermissionLifetime,
    decision: PermissionDecision = "allow"
  ) {
    setActiveAction("permission");
    setStatus("Updating permission");
    try {
      setPermissions(await updatePermissionGrant(capsule, descriptor, lifetime, decision));
      setStatus("Permission updated");
    } finally {
      setActiveAction(undefined);
    }
  }

  async function trustCapsule(capsule: Capsule, trusted: boolean) {
    setActiveAction("permission");
    setStatus(trusted ? "Granting trusted access" : "Removing trusted access");
    try {
      setPermissions(await setCapsuleTrust(capsule, trusted));
      setStatus(trusted ? "Trusted access granted" : "Trusted access removed");
    } finally {
      setActiveAction(undefined);
    }
  }

  async function acknowledgeManifest(capsule: Capsule) {
    setActiveAction("permission");
    setStatus("Acknowledging manifest");
    try {
      setPermissions(await acknowledgeManifestChanges(capsule));
      setStatus("Manifest acknowledged");
    } finally {
      setActiveAction(undefined);
    }
  }

  async function openSource(capsule: Capsule) {
    setActiveAction("source/open");
    setStatus("Opening source");
    try {
      await openCapsuleSource(capsule);
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
    if (!selectedRealmId) {
      return;
    }

    loadCapsulesForRealm(selectedRealmId).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : "Capsule load failed");
      setCapsules([]);
      setSelectedId(undefined);
    });
  }, [selectedRealmId]);

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
      const nextStatus = parseCapsuleStatusEvent(event.data);
      if (!nextStatus) {
        return;
      }

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
          <ul className="realm-options" aria-label="Available realms">
            {realms.length ? (
              realms.map((realm) => (
                <li key={realm.id}>
                  <button
                    className={realm.id === selectedRealm?.id ? "realm active" : "realm"}
                    type="button"
                    title={realm.path}
                    onClick={() => setSelectedRealmId(realm.id)}
                  >
                    {realm.id}
                  </button>
                </li>
              ))
            ) : (
              <strong>none</strong>
            )}
          </ul>
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
                  /* The daemon serves capsule launch URLs today. `allow-same-origin` keeps those
                     capsules usable, but it also means a future cookie-authenticated daemon API
                     would be reachable from the frame. TODO: move launches to an isolated origin. */
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
