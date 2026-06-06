import assert from "node:assert/strict";
import test from "node:test";

import { PermissionDeniedError, system } from "../src/index.js";

type FetchCall = {
  readonly body: unknown;
  readonly path: string;
};

function setLocationHash(hash: string): void {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      hash
    }
  });
}

function installFetch(handler: (call: FetchCall) => Response): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (path: string, init?: RequestInit) =>
      Promise.resolve(
        handler({
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
          path
        })
      )
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json"
    },
    status
  });
}

await test("privileged calls return tagged permission errors instead of throwing", async () => {
  setLocationHash("#malleableToken=test-token");
  installFetch(() =>
    jsonResponse(
      {
        capability: "files",
        code: "permission-denied",
        error: "Capability has not been granted",
        operation: "files.read-text-file",
        reason: "Capability has not been granted",
        target: "notes/today.md"
      },
      403
    )
  );

  const result = await system.files.readTextFile("notes/today.md", {
    scope: "realm-files"
  });

  assert.equal(result.isErr(), true);
  assert.equal(result.isErr() && PermissionDeniedError.is(result.error), true);
  assert.equal(result.isErr() ? result.error.message : "", "Capability has not been granted");
});

await test("withGrant short-circuits before running the operation when permission is missing", async () => {
  setLocationHash("#malleableToken=test-token");
  let operationCalled = false;
  installFetch((call) => {
    assert.equal(call.path, "/api/capsule-system/permissions/ensure");
    return jsonResponse(
      {
        capability: "files",
        code: "permission-denied",
        error: "Capability has not been granted",
        operation: "permissions.ensure",
        reason: "Capability has not been granted",
        target: "files.realm-files read"
      },
      403
    );
  });

  const result = await system.permissions.withGrant(
    {
      access: ["read"],
      capability: "files",
      scope: "realm-files"
    },
    async () => {
      operationCalled = true;
      return system.Result.ok("should not run");
    }
  );

  assert.equal(operationCalled, false);
  assert.equal(result.isErr(), true);
  assert.equal(result.isErr() && PermissionDeniedError.is(result.error), true);
});

await test("withGrant composes ensure and a privileged operation with Result.gen", async () => {
  setLocationHash("#malleableToken=test-token");
  const calls: string[] = [];
  installFetch((call) => {
    calls.push(call.path);
    if (call.path === "/api/capsule-system/permissions/ensure") {
      return jsonResponse({
        permission: {
          access: ["read"],
          capability: "files",
          granted: true,
          scope: {
            scope: "realm-files"
          }
        }
      });
    }

    return jsonResponse({
      text: "ok"
    });
  });

  const result = await system.permissions.withGrant(
    {
      access: ["read"],
      capability: "files",
      scope: "realm-files"
    },
    async () => await system.files.readTextFile("notes/today.md", { scope: "realm-files" })
  );

  assert.equal(result.isOk(), true);
  assert.equal(result.isOk() ? result.value : "", "ok");
  assert.deepEqual(calls, [
    "/api/capsule-system/permissions/ensure",
    "/api/capsule-system/files/read-text-file"
  ]);
});
