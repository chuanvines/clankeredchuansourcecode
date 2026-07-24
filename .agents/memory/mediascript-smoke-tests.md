---
name: Mediascript smoke tests
description: Workspace-specific constraints for directly smoke-testing the mediascript implementation.
---

Use an ESM bundle created from inside `artifacts/api-server` when directly exercising `runMediascript`. A standalone harness under `/tmp` can fail to resolve workspace packages, and a CommonJS bundle can break source code that relies on `import.meta.url`.

**Why:** The application itself runs as an ESM esbuild bundle, so matching that format avoids false failures from the test harness rather than the mediascript behavior.

**How to apply:** For focused local media tests, bundle the harness with the API package's existing esbuild setup using ESM output, run it from the API workspace, and clean up the temporary harness afterward.