# Architecture

Malleable starts as a local operating environment, not a bootable OS.

## Pieces

- **Shell**: web UI for realms, capsules, running tools, and source.
- **Daemon**: local HTTP service for files, registry, launches, logs, and capabilities.
- **Capsules**: small local tools with a manifest, source/assets, storage, and declared access.
- **Realms**: directories that keep contexts separate.
- **Workbench**: future agent surface for creating and mutating capsules.
- **Capsule Dev Host**: one daemon-owned Vite dev server that serves every active native web
  capsule through virtual entries and shared HMR machinery.

## Rule

The system should optimize one loop:

```text
need -> capsule -> run -> mutate -> keep or remove
```

Anything that does not shorten or clarify that loop waits.

## Capsule Runtime Rule

Capsules own source, assets, data, and manifest. Malleable owns the build host, platform imports,
framework adapters, and automatic reload.

Static capsules stay available for legacy and advanced direct-public-file cases, but the default
tool shape is a native web capsule with no capsule-local `package.json` or build command.

Native web capsules are served by one shared daemon Vite host. The daemon maps each running capsule
to virtual entry and client modules, aliases platform packages, runs React Fast Refresh for React
capsules, and emits capsule status while Vite owns the watcher, module graph, dependency cache, and
HMR websocket. Rolldown stays available for production, last-good, and fallback artifacts rather
than the main dev refresh loop.

Full document reload is a fallback, not the default. It is reserved for cases Vite cannot safely HMR,
such as manifest entry changes, unsupported framework adapters, static capsules, or invalidated HMR
boundaries.
