# Architecture

Malleable starts as a local operating environment, not a bootable OS.

## Pieces

- **Shell**: web UI for realms, capsules, running tools, and source.
- **Daemon**: local HTTP service for files, registry, launches, logs, and capabilities.
- **Capsules**: small local tools with a manifest, source/assets, storage, and declared access.
- **Realms**: directories that keep contexts separate.
- **Workbench**: future agent surface for creating and mutating capsules.

## Rule

The system should optimize one loop:

```text
need -> capsule -> run -> mutate -> keep or remove
```

Anything that does not shorten or clarify that loop waits.
