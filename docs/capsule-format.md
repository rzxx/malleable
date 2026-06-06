# Capsule Format

A capsule is a local folder.

```text
capsule/
  capsule.json
  src/
  assets/
  data/
```

## Manifest

The default capsule entry is a native web entry. Malleable owns the dev/build host, so capsules do
not carry `package.json`, local build scripts, or generated JS.

```json
{
  "id": "hello-tool",
  "name": "Hello Tool",
  "version": "0.0.1",
  "entry": {
    "type": "web",
    "main": "src/main.tsx",
    "framework": "react",
    "reload": "auto"
  },
  "capabilities": {
    "storage": ["own-data"],
    "network": [],
    "commands": [],
    "files": []
  }
}
```

## Native Web Capsules

```text
capsule/
  capsule.json
  src/
    App.tsx
    main.tsx
    styles.css
  assets/
  data/
```

Supported `framework` values are `react` and `vanilla`. Other adapters should not be added to the
schema until the daemon can launch them.

The daemon serves active native capsules through one shared Vite dev host. Vite owns the watcher,
module graph, transform cache, HMR websocket, React Refresh preamble, and module update semantics.
React templates keep `src/main.tsx` as a bootstrap file and export the component from `src/App.tsx`
so React Refresh can preserve component state during normal edits.

Full document reload remains a fallback for unsafe HMR cases such as manifest entry changes,
unsupported adapters, static capsules, or invalidated HMR boundaries.

## Static Capsules

Static capsules remain supported as the legacy and advanced compatibility path:

```json
{
  "entry": {
    "type": "static",
    "path": "public/index.html"
  }
}
```

Static capsules are served directly from `public/`. They are useful for hand-authored HTML, imports
from `/capsule-runtime/state.js`, and compatibility with older capsules. They do not get the native
TypeScript build/watch pipeline unless migrated to `entry.type = "web"`.
