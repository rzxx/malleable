# Architecture

Malleable starts as a local operating environment, not a bootable OS.

## Pieces

- **Shell**: web UI for realms, capsules, running tools, and source.
- **Daemon**: local HTTP service for files, registry, launches, logs, and capabilities.
- **Capsules**: small local tools with a manifest, source/assets, storage, and declared access.
- **Realms**: directories that keep contexts separate.
- **Workbench**: future agent surface for creating and mutating capsules.
- **Capsule Dev Host**: daemon-owned TypeScript build/watch/runtime pipeline for native web
  capsules.

## Rule

The system should optimize one loop:

```text
need -> capsule -> run -> mutate -> keep or remove
```

Anything that does not shorten or clarify that loop waits.

## Capsule Runtime Rule

Capsules own source, assets, data, and manifest. Malleable owns the build host, platform imports,
framework adapters, and reload prompts.

Static capsules stay available for legacy and advanced direct-public-file cases, but the default
tool shape is a native web capsule with no capsule-local `package.json` or build command.

Native web capsules are bundled by the daemon with Rolldown. Source invalidation is handled by the
daemon watch layer so Malleable can keep last-good bundles in memory, emit dirty/building/ready
events, and prompt the user to reload instead of forcing HMR.
