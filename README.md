# Malleable

> A personal software foundry that happens to look like a desktop.

Malleable is a local operating environment for making small, personal software with agents. The idea is simple: when you need a tool, you create it. When it breaks, you fix it. When it’s done, you keep it or throw it away. No app stores, no configuration wizards, no adapting yourself to someone else’s workflow.

The whole thing runs on your machine. Your tools, your source, your data.

## The Loop

```
need → capsule → run → mutate → keep or remove
```

That’s it. Everything else is in service of making that loop faster.

## What This Actually Is Right Now

This is early. Like, *really* early. But the bones are there:

- **Shell** — A web UI where you browse realms, launch capsules, and manage permissions.
- **Daemon** — A local runtime that serves capsules, handles storage, and brokers access to your actual filesystem.
- **CLI** — `malleable` command to create, run, fork, archive, patch, and inspect capsules from a terminal.
- **Capsules** — Small self-contained tools. Each one is just a folder with a manifest (`capsule.json`), source, assets, and its own data.
- **Realms** — Separate contexts (work, play, experiments) so your tools don’t step on each other.
- **Permission Broker** — Capsules declare what they want. You grant what they get. No silent full-system access.
- **Workbench** — An integration layer so external agents (your existing tools, not a new chat app) can generate and mutate capsules inside clear filesystem boundaries.

Capsules are web-native by default — TypeScript and React or vanilla JS, served through a shared Vite dev host with HMR. If you can write a web page, you can write a capsule.

## What This Is Not

To save you time and set expectations:

- **Not a new AI agent.** There is no chat interface, no Codex competitor, no Claude Code clone. Malleable is the *stage* where your existing agents build things.
- **Not a Linux distribution.** A bootable OS image was an early dream, but it’s mostly on ice. Right now this is a local dev environment that runs on your normal machine.
- **Not an app store.** There is no marketplace. Tools are generated, not installed.
- **Not a no-code builder.** You *can* generate tools with agents, but the output is real source code you can open and edit.

## Try It

You need [pnpm](https://pnpm.io) and Node.js.

```bash
# Install dependencies
pnpm install

# Start the daemon and shell
pnpm dev
```

The daemon runs on `http://127.0.0.1:4877` and the shell opens on `http://127.0.0.1:5173`.

Then, in another terminal:

```bash
# Create a capsule
pnpm malleable capsule create "Hello Tool" --template web-vanilla --realm default

# List capsules
pnpm malleable capsule list

# Launch one
pnpm malleable capsule run hello-tool --open
```

Or just open the shell in your browser and click **Run**.

## Capsules

A capsule is a folder:

```
capsule/
  capsule.json
  src/
  assets/
  data/
```

The manifest declares its name, entry point, framework, and capabilities. The runtime gives it APIs for storage, files, commands, and network — but only what you allowed.

```json
{
  "id": "hello-tool",
  "name": "Hello Tool",
  "version": "0.0.1",
  "entry": {
    "type": "web",
    "main": "src/main.tsx",
    "framework": "react"
  },
  "capabilities": {
    "storage": [{ "scope": "own-data", "access": ["read", "write"] }],
    "files": [],
    "commands": [],
    "network": []
  }
}
```

Capsules can be forked, archived, snapshotted, patched, and deleted. They are real local artifacts, not chat transcripts.

## Status

This is a raw project. Ideas change, structures shift, and things break. The current milestone is proving the core loop: ask for a tool, get a working capsule, change it in place, decide whether to keep it.

If that sounds interesting, stick around.

## Design Principles

- **Creation speed is the main metric.** A rough tool that works now beats a beautiful platform that ships in six months.
- **Local first.** Your stuff lives on your machine. Cloud is optional, not assumed.
- **Source is part of the interface.** Every generated tool is inspectable, forkable, and patchable.
- **Boring foundations, strange surface.** Linux, files, SQLite, HTTP, Vite. The weirdness goes into the product idea, not reinventing infrastructure.
- **Tools, not monuments.** Prefer small disposable capsules over grand applications.

---

Built with a lot of stubbornness and a little bit of hope.
