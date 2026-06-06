# Capability Platform

Capsules should become powerful local tools, closer to Electron-style apps than isolated web pages.
The platform should support that without making privileged access implicit or invisible.

The core rule:

```text
Manifest declares what a capsule wants.
The daemon stores what the user actually allowed.
Runtime APIs only work through the daemon permission broker.
```

The manifest is a request, not authority. A capsule can edit its own `capsule.json`, so the daemon
must keep grants outside the capsule folder and verify every privileged operation against those
grants.

## Goals

- Make capsules useful for real local tools: file explorers, editors, project dashboards,
  automations, command runners, data tools, and system integrations.
- Keep powerful access explicit, visible, revocable, and auditable.
- Avoid annoying per-operation prompts for trusted local apps.
- Make permission changes visible when capsule manifests update.
- Keep the system honest: full access means code can do dangerous things, so the UI should explain
  that clearly instead of pretending every risk can be sandboxed away.

## Current State

The current system already has the beginning of this model:

- `capsule.json` has `capabilities`.
- The daemon mints launch tokens.
- `own-data` storage is enforced server-side.
- Capsules run inside a browser iframe sandbox.

The current gap is that `network`, `commands`, and `files` are loose string arrays with no grant
store, prompt flow, operation broker, or update diff.

## Capability Registry

Capabilities should be declared from a central registry. Each capability has:

- a stable identifier
- risk level
- allowed scope shape
- supported access modes
- whether it can be auto-allowed, prompted, persisted, or requires explicit trust

Initial capability families:

```text
storage
  own-data
  realm-data
  shared-data

files
  own-data
  own-source
  realm-files
  user-picked-file
  user-picked-directory
  explicit-path
  full-filesystem

commands
  named-command
  shell-command
  full-process

network
  listed-hosts
  private-network
  full-network

system
  clipboard
  notifications
  open-external-url
  open-path
  dialogs
  secrets
```

## Manifest Shape

The manifest should move from loose strings to structured capability requests.

Example:

```json
{
  "capabilities": {
    "storage": [
      {
        "scope": "own-data",
        "access": ["read", "write"]
      }
    ],
    "files": [
      {
        "scope": "realm-files",
        "access": ["read", "write", "delete"]
      },
      {
        "scope": "explicit-path",
        "path": "C:/Users/pufok/Documents",
        "access": ["read", "write"]
      }
    ],
    "commands": [
      {
        "scope": "named-command",
        "command": "git",
        "access": ["run"]
      }
    ],
    "network": []
  }
}
```

This is verbose, but it makes permission diffs and user prompts understandable.

## Grant Store

The daemon should own a permission database outside capsule folders.

Suggested tables:

```text
permission_grants
  id
  realm_id
  capsule_id
  capsule_path
  capability
  scope_json
  access_json
  decision: allow | deny
  lifetime: once | session | persistent
  manifest_hash
  granted_at
  updated_at
  last_used_at

permission_events
  id
  timestamp
  realm_id
  capsule_id
  capability
  operation
  target
  decision
  reason
```

Effective permission is:

```text
declared in manifest + granted by user + allowed by platform policy
```

If any part is missing, the daemon denies or starts a prompt flow.

## Runtime API

Capsules should use a platform runtime package instead of calling privileged daemon endpoints
directly.

Example author experience:

```ts
import { system } from "@malleable/capsule-system";

const entries = await system.files.readDirectory("project-root");
await system.files.writeTextFile("notes/today.md", text);
await system.commands.run("git", ["status"]);
```

Internally, the runtime uses the launch token and calls daemon endpoints. The daemon is the only
place that touches the host filesystem, commands, secrets, network policy, or other privileged
system resources.

## Filesystem Model

Filesystem access should be tiered.

```text
own-data
  Capsule-private persisted data. Safe default.

own-source
  Capsule source/assets. Useful for self-editing tools, but still more sensitive than own-data.

realm-files
  A real files folder inside the realm for project/workspace-like tools.

user-picked-file / user-picked-directory
  User chooses the target through a system picker. Can be one-time, session, or persistent.

explicit-path
  Manifest asks for a specific path. Prompt required.

full-filesystem
  Reads/writes anywhere the daemon process can. Valid for tools like file explorers, but requires
  a very explicit trust grant.
```

For `full-filesystem`, the prompt should say plainly that the capsule can read, edit, create, and
delete files anywhere the user's account can. This should be allowed for trusted local code, but it
must be impossible to grant accidentally.

## Prompt Policy

Avoid asking for every operation. Prompt for grants, then enforce grants consistently.

Suggested risk levels:

```text
Low risk
  own-data, own assets
  Can be auto-allowed if declared.

Medium risk
  realm-data, realm-files, clipboard, notifications, listed network hosts
  Ask once on launch or first use.

High risk
  explicit paths, delete access, commands, private network
  Ask clearly, with persistent allow as an explicit choice.

Critical risk
  full filesystem, arbitrary shell/process, secrets
  Require an explicit trust grant.
```

Prompt choices:

```text
Allow once
Allow for this session
Always allow for this capsule
Deny
```

For local vibecoded apps, the shell can offer a `Trusted local app` mode. This should be a fast path
for broad grants, but it must be visible in the inspector and easy to revoke.

## Update Flow

When `capsule.json` changes, the daemon should compare previous requested capabilities with the new
request.

```text
Same or narrower request
  Keep running.

New low-risk request
  Auto-allow only if policy permits it.

New medium/high/critical request
  Mark capsule as needing approval before the new capability works.

Removed request
  Leave old grant stale or offer cleanup.
```

The shell should show a diff:

```text
Added
  files.full-filesystem read/write/delete
  commands.shell-command run

Existing
  storage.own-data read/write

Removed
  network.listed-hosts https://api.example.com
```

This gives visibility without nagging on every individual operation.

## Security Boundaries

The platform should not rely on renderer trust for privileged operations.

- Capsules can request privileged operations only through runtime APIs.
- Daemon endpoints must authorize every privileged request.
- Launch tokens identify capsule sessions but are not permission grants by themselves.
- The manifest is untrusted input.
- Full access grants should be treated as real trust, not fake sandbox safety.
- All privileged operations should be loggable.

The browser sandbox still matters for normal web isolation, but it is not the permission system.

## Implementation Order

1. Replace loose manifest capability strings with typed capability schemas.
2. Add a daemon-owned grant store and one permission resolver.
3. Add `@malleable/capsule-system` as the runtime package for privileged APIs.
4. Implement filesystem first: `own-data`, `realm-files`, `user-picked-directory`, then
   `full-filesystem`.
5. Add shell UI for requested grants, current grants, update diffs, and revoke.
6. Add audit logging for privileged calls.
7. Add command/process permissions after filesystem.
8. Add network, secrets, and broader system integrations after the broker pattern is proven.

## Principle

Do not make full access the foundation. Make the broker and grant system the foundation, then allow
full access as one explicit high-trust grant.

That gives capsules serious local power while keeping access understandable, reviewable, and
reversible.
