import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseCapsuleManifest, type CapsuleManifest } from "@malleable/capsule-schema";

import { PermissionPlatform } from "../src/permission-platform.js";

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

async function withPlatform(run: (platform: PermissionPlatform, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "malleable-permissions-"));
  const platform = new PermissionPlatform(path.join(root, "permissions.sqlite"));
  await platform.open();

  try {
    await run(platform, root);
  } finally {
    platform.close();
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
  await withPlatform(async (platform, root) => {
    const subject = {
      capsulePath: root,
      manifest: manifest(),
      realmId: "default"
    };

    const resolution = platform.resolve(subject, {
      access: ["read"],
      capability: "storage",
      descriptorMatches: (descriptor) => descriptor.scope.scope === "own-data",
      operation: "state.value.get",
      target: "preferences"
    });

    assert.equal(resolution.ok, true);
    assert.equal(platform.readGrants(subject).length, 1);
    assert.equal(platform.readEvents(subject)[0]?.decision, "allow");
  });
});

await test("high-risk file access requires an explicit grant", async () => {
  await withPlatform(async (platform, root) => {
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

    const denied = platform.resolve(subject, {
      access: ["read"],
      capability: "files",
      descriptorMatches: (descriptor) => descriptor.scope.scope === "explicit-path",
      operation: "files.read-directory",
      target: path.join(root, "project")
    });
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /not been granted|explicit trust/);

    const descriptor = platform.readSummary(subject).requested[0];
    assert.ok(descriptor);
    platform.upsertGrant(subject, descriptor, {
      decision: "allow",
      lifetime: "persistent"
    });

    const allowed = platform.resolve(subject, {
      access: ["read"],
      capability: "files",
      descriptorMatches: (candidate) => candidate.key === descriptor.key,
      operation: "files.read-directory",
      target: path.join(root, "project")
    });
    assert.equal(allowed.ok, true);
  });
});

await test("once grants are consumed after a successful operation", async () => {
  await withPlatform(async (platform, root) => {
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
    const descriptor = platform.readSummary(subject).requested[0];
    assert.ok(descriptor);
    platform.upsertGrant(subject, descriptor, {
      decision: "allow",
      lifetime: "once"
    });

    const first = platform.resolve(subject, {
      access: ["run"],
      capability: "commands",
      descriptorMatches: (candidate) => candidate.key === descriptor.key,
      operation: "commands.run",
      target: "git status"
    });
    const second = platform.resolve(subject, {
      access: ["run"],
      capability: "commands",
      descriptorMatches: (candidate) => candidate.key === descriptor.key,
      operation: "commands.run",
      target: "git status"
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
  });
});

await test("manifest diffs show newly requested and removed capabilities", async () => {
  await withPlatform(async (platform, root) => {
    const subject = {
      capsulePath: root,
      manifest: manifest(),
      realmId: "default"
    };
    platform.readSummary(subject);

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
    const summary = platform.readSummary(updated);

    assert.equal(summary.diff.added.length, 1);
    assert.match(summary.diff.added[0] ?? "", /commands.named-command git run/);
    assert.equal(summary.diff.removed.length, 1);
    assert.match(summary.diff.removed[0] ?? "", /storage.own-data/);
  });
});
