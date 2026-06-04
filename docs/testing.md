# Testing

Tests protect behavior, not implementation.

If a test knows whether a thing is a div, which helper was called, or how state is stored internally, it is probably wrong. Tests should describe what a user, capsule, daemon client, or agent can rely on.

## Pipeline

- `pnpm check` is the baseline: format, lint, typecheck.
- Browser Use is the main acceptance path for shell and capsule flows.
- Add narrower automated tests only when behavior is stable enough to defend.

## What To Test

- Capsule manifests: valid capsules load; invalid capability or entry shapes fail.
- Daemon contracts: realms, capsule listing, launch URLs, and public file serving.
- Boundaries: capsule public files cannot escape their capsule directory.
- Shell flow: realm appears, capsule appears, run launches the capsule, manifest is inspectable.
- Agent output: a generated capsule is local, runnable, inspectable, and declares capabilities.

## Browser Use Checks

Prefer programmatic browser checks that follow the product loop:

```text
start daemon + shell -> load realm -> select capsule -> run -> inspect result
```

Assert visible outcomes, URLs, responses, and persisted artifacts. Avoid brittle selectors when a role, label, text, URL, or API response tells the same truth.

## Unit Test Rule

Unit tests are welcome when they guard a contract:

- schema parsing
- path safety
- API payload shape
- capsule fixture validity

Do not test framework wiring, component internals, styling mechanics, or mocks that duplicate the implementation.

## Bar

Every test should make a future refactor safer without making a better implementation harder.
