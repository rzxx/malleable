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
    "reload": "prompt"
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
    main.tsx
    styles.css
  assets/
  data/
```

Supported `framework` values are declared by the platform catalog. The current happy path is
`react` or `vanilla`; other adapters can be added behind the same manifest shape.

The daemon watches native capsule source, rebuilds quickly, and prompts the user to reload the
running capsule when a new good build is ready. Failed builds report diagnostics while the last
working bundle remains available.

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
