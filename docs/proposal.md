# Malleable Proposal

Status: founding proposal
Audience: humans and agents building the project

## One Sentence

Malleable is a minimal, Linux-based, web-native operating environment for creating personal software as fast as possible.

Its default loop is not:

```text
install app -> configure app -> adapt yourself to app
```

It is:

```text
need -> generate tool -> use immediately -> mutate in place -> keep or throw away
```

Everything in this project exists to make that loop faster, clearer, and more ownable.

## The Core Bet

The interesting future is not an operating system with an AI assistant bolted onto it.

The interesting future is an operating environment where agents and humans can make small, local, personal software together so cheaply that the user stops thinking in terms of "which app should I install?" and starts thinking in terms of "what tool should exist here?"

The OS is not the product by itself. The product is the creation loop.

Malleable should feel like a personal software foundry disguised as a desktop.

## Why This Should Exist

Most computers are built around other people's software. Users inherit generic apps, generic workflows, generic settings, generic automation systems, and generic assumptions about what work should look like.

Agents change the economics. If small software can be created and changed on demand, then the operating environment should stop treating apps as scarce polished products and start treating them as living local artifacts.

This project exists to make personal computing more direct:

- If a user needs a tracker, dashboard, editor, scraper, planner, viewer, automation, or weird one-off tool, the system should help create it.
- If the generated thing is wrong, the system should help mutate it.
- If it becomes useful, it should become part of the user's environment.
- If it becomes stale, it should be easy to fork, archive, delete, or replace.

The highest compliment for this system is not "it has many features." It is "I made the exact thing I needed before I lost momentum."

## What We Are Building

We are building a self-authoring operating environment first, and a bootable OS later.

The first versions may run on an ordinary development machine. Later versions can become a Linux image that boots directly into the environment.

The core shape:

- **Web shell:** the main user surface for apps, files, agents, jobs, realms, and system state.
- **Local daemon:** the bridge to storage, process execution, permissions, app registry, system capabilities, and agent runtimes.
- **Capsules:** small self-contained apps, tools, workflows, automations, and documents with manifests, source, storage, and declared capabilities.
- **Realms:** separate personal contexts such as work, experiments, entertainment, research, or any other world the user wants to keep distinct.
- **Agent workbench:** the place where tools are created, inspected, repaired, forked, and changed while remaining ordinary files.

This is enough to prove the idea. Anything beyond this must earn its place by improving the loop.

## Product Loop

The primary workflow must be brutally simple:

1. The user has a need.
2. The system asks for only the missing context.
3. An agent creates a small working capsule.
4. The capsule appears in the shell immediately.
5. The user uses it.
6. The user asks for changes in place.
7. The capsule remains inspectable, forkable, portable, and disposable.

No architecture decision is more important than this loop.

## Design Principles

### Creation Speed Is The Main Metric

The system should optimize for the time between intent and a working tool. A rough custom tool that works now is more valuable than a beautiful platform that takes weeks to become useful.

### Local First

The user's tools, source, data, preferences, and histories should live locally by default. Cloud services may exist, but the local environment must remain the center of gravity.

### Web Is The Default UI Substrate

The web is not chosen because it is perfect. It is chosen because it is universal, inspectable, fast to generate, easy to modify, and already understood by agents.

Do not invent a custom UI renderer until the web path has clearly failed.

### Source Is Part Of The Interface

Every generated tool should have visible source, a manifest, declared capabilities, and an obvious way to ask for changes. The user should never be trapped behind a finished-looking surface that cannot be opened.

### Constraints Make Agents Better

The system should give agents a small, predictable app format instead of infinite freedom. A simple capsule format is more valuable than a giant framework.

### Ownable Over Seamless

Polish is welcome when it serves the loop, but invisibility is not the goal. The user should feel that the system is theirs: changeable, inspectable, breakable, repairable.

### Boring Foundations, Strange Surface

Use Linux, Chromium, files, processes, SQLite, HTTP, and other boring primitives where they fit. Spend weirdness on the product idea, not on rebuilding stable infrastructure for sport.

### Tools, Not Monuments

Prefer small capsules over grand applications. Prefer a working local workflow over a general platform. Prefer mutation over configuration.

## Non-Negotiables

- Generated tools must become real local artifacts, not chat transcripts.
- A capsule must be inspectable by default: manifest, source, storage, and capabilities.
- The default app format must be understandable without a build archaeology expedition.
- System capabilities must be explicit. Files, commands, network, secrets, devices, and background work require declared access.
- The bootable Linux image is a packaging milestone, not the starting point.
- The shell must be useful before the system tries to become a daily-driver OS.
- Every major feature must improve the need-to-tool-to-mutation loop.

## Explicit Boundaries

This project is not:

- A new kernel.
- A general Linux distribution with a chatbot.
- A normal desktop environment clone.
- An app store.
- A SaaS framework.
- A visual no-code builder.
- A package-manager ideology project.
- A cloud-first agent platform.
- A promise to replace every native app.
- A daily-driver OS in the early phases.

Reject work when it:

- Improves low-level OS plumbing without improving the creation loop.
- Turns the product into a chat app where artifacts are secondary.
- Creates generated apps that are hard to inspect, fork, or delete.
- Adds framework complexity before the capsule model is proven.
- Assumes people will install a custom OS before there is value on a normal machine.
- Optimizes for theoretical correctness over making the next personal tool real.

## MVP

Version 0 succeeds when a blank realm can do this:

1. Ask for a tiny custom app.
2. Generate a capsule with UI, local storage, manifest, and declared capabilities.
3. Launch it from the shell.
4. Use it immediately.
5. Ask the system to change it.
6. See the changed version running.
7. Open, fork, export, archive, or delete it.

No other feature counts as core until this works.

## Initial Technical Bias

These are biases, not laws:

- Linux host first, bootable image later.
- Chromium or WebView shell first.
- Web apps as the default generated UI.
- TypeScript or JavaScript as the default app language.
- SQLite or simple file storage for local state.
- A small manifest-based capsule format.
- A local daemon for privileged capabilities.
- Realms as directories or profiles first, stronger isolation later.

The technology can change. The loop cannot.

## Language

Avoid calling this simply an "AI OS." That phrase is too vague and invites the wrong product.

Preferred language:

- self-authoring operating environment
- personal software foundry
- web-native local OS
- capsule
- realm
- workbench
- generated local tool

The idea is not that AI controls the computer. The idea is that the computer becomes a better place to make software with agents.

## Agent Instructions

Any agent working on this repository should read this file before making product or architecture decisions.

When uncertain:

- Protect the core loop.
- Prefer the smallest working artifact.
- Keep generated things inspectable.
- Use boring infrastructure where possible.
- Add capabilities instead of monoliths.
- Preserve local ownership.
- Do not turn the project into a generic assistant, generic distro, generic framework, or generic app platform.

The project can pivot, but it should not drift. A pivot should sharpen the loop. Drift makes the system more normal.
