import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseCapsuleManifest, type CapsuleManifest } from "@malleable/capsule-schema";
import { PermissionBroker } from "@malleable/permission-core";

function manifest(
  capabilities: CapsuleManifest["capabilities"] = {
    commands: [],
    files: [],
    network: [],
    storage: [
      {
        access: ["delete", "read", "write"],
        scope: "own-data"
      }
    ],
    system: []
  }
): CapsuleManifest {
  return parseCapsuleManifest({
    capabilities,
    entry: {
      framework: "vanilla",
      main: "src/main.ts",
      reload: "auto",
      type: "web"
    },
    id: "test-capsule",
    name: "Test Capsule",
    version: "0.0.1"
  });
}

async function withBroker(run: (broker: PermissionBroker, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "malleable-permissions-"));
  const broker = new PermissionBroker(path.join(root, "permissions.sqlite"));
  await broker.open();

  try {
    await run(broker, root);
  } finally {
    broker.close();
    await rm(root, {
      force: true,
      recursive: true
    });
  }
}

await test("manifest capabilities require structured request shapes", () => {
  assert.throws(() =>
    parseCapsuleManifest({
      capabilities: {
        commands: [],
        files: [],
        network: [],
        storage: ["own-data"],
        system: []
      },
      entry: {
        framework: "vanilla",
        main: "src/main.ts",
        type: "web"
      },
      id: "bad-capsule",
      name: "Bad Capsule",
      version: "0.0.1"
    })
  );

  assert.equal(manifest().capabilities.storage[0]?.scope, "own-data");
});

await test("low-risk own-data storage is auto-granted and audited", async () => {
  await withBroker(async (broker, root) => {
    const subject = {
      capsulePath: root,
      manifest: manifest(),
      realmId: "default"
    };

    const resolution = broker.resolve(subject, {
      access: ["read"],
      capability: "storage",
      descriptorMatches: (descriptor) => descriptor.scope.scope === "own-data",
      operation: "state.value.get",
      target: "preferences"
    });

    assert.equal(resolution.isOk(), true);
    assert.equal(broker.readGrants(subject).length, 1);
    assert.equal(broker.readEvents(subject)[0]?.decision, "allow");
  });
});

await test("high-risk file access requires an explicit grant", async () => {
  await withBroker(async (broker, root) => {
    const subject = {
      capsulePath: root,
      manifest: manifest({
        commands: [],
        files: [
          {
            access: ["read", "write"],
            path: path.join(root, "project"),
            scope: "explicit-path"
          }
        ],
        network: [],
        storage: [],
        system: []
      }),
      realmId: "default"
    };

    const denied = broker.resolve(subject, {
      access: ["read"],
      capability: "files",
      descriptorMatches: (descriptor) => descriptor.scope.scope === "explicit-path",
      operation: "files.read-directory",
      target: path.join(root, "project")
    });
    assert.equal(denied.isErr(), true);
    assert.match(denied.isErr() ? denied.error.reason : "", /not been granted|explicit trust/);

    const descriptor = broker.readSummary(subject).requested[0];
    assert.ok(descriptor);
    broker.upsertGrant(subject, descriptor, {
      decision: "allow",
      lifetime: "persistent"
    });

    const allowed = broker.resolve(subject, {
      access: ["read"],
      capability: "files",
      descriptorMatches: (candidate) => candidate.key === descriptor.key,
      operation: "files.read-directory",
      target: path.join(root, "project")
    });
    assert.equal(allowed.isOk(), true);
  });
});

await test("once grants are consumed after a successful operation", async () => {
  await withBroker(async (broker, root) => {
    const subject = {
      capsulePath: root,
      manifest: manifest({
        commands: [
          {
            access: ["run"],
            command: "git",
            scope: "named-command"
          }
        ],
        files: [],
        network: [],
        storage: [],
        system: []
      }),
      realmId: "default"
    };
    const descriptor = broker.readSummary(subject).requested[0];
    assert.ok(descriptor);
    broker.upsertGrant(subject, descriptor, {
      decision: "allow",
      lifetime: "once"
    });

    const first = broker.resolve(subject, {
      access: ["run"],
      capability: "commands",
      descriptorMatches: (candidate) => candidate.key === descriptor.key,
      operation: "commands.run",
      target: "git status"
    });
    const second = broker.resolve(subject, {
      access: ["run"],
      capability: "commands",
      descriptorMatches: (candidate) => candidate.key === descriptor.key,
      operation: "commands.run",
      target: "git status"
    });

    assert.equal(first.isOk(), true);
    assert.equal(second.isErr(), true);
  });
});

await test("manifest diffs show newly requested and removed capabilities", async () => {
  await withBroker(async (broker, root) => {
    const subject = {
      capsulePath: root,
      manifest: manifest(),
      realmId: "default"
    };
    broker.readSummary(subject);

    const updated = {
      ...subject,
      manifest: manifest({
        commands: [
          {
            access: ["run"],
            command: "git",
            scope: "named-command"
          }
        ],
        files: [],
        network: [],
        storage: [],
        system: []
      })
    };
    const summary = broker.readSummary(updated);

    assert.equal(summary.diff.added.length, 1);
    assert.match(summary.diff.added[0] ?? "", /commands.named-command git run/);
    assert.equal(summary.diff.removed.length, 1);
    assert.match(summary.diff.removed[0] ?? "", /storage.own-data/);
  });
});
