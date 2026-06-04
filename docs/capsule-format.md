# Capsule Format

A capsule is a local folder.

```text
capsule/
  capsule.json
  public/
  data/
```

## Manifest

```json
{
  "id": "hello-tool",
  "name": "Hello Tool",
  "version": "0.0.1",
  "entry": {
    "type": "static",
    "path": "public/index.html"
  },
  "capabilities": {
    "storage": ["own-data"],
    "network": [],
    "commands": [],
    "files": []
  }
}
```

## V0 Constraint

V0 capsules are static web tools served by the daemon. More entry types can be added only after static capsules prove the loop.

## Creation

The shell asks the daemon to create static capsules:

```text
POST /api/realms/:realmId/capsules
```

The daemon writes the manifest, public entry file, and data folder locally.

## Lifecycle

V0 supports direct local lifecycle actions:

- fork: copy the capsule and assign a new manifest id
- archive: move it out of the active capsule list
- delete: permanently remove it after confirmation
- source: open the capsule folder for inspection and edits
