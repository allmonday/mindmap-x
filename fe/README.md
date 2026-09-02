# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## OpenAPI SDK

MindmapService requests use the generated client under `src/sdk`.

Start the backend on port 8740, then regenerate after changing a REST contract:

```bash
npm run generate-client
```

The script pulls `openapi.json` to a local file first and feeds that to
`openapi-ts` as input on purpose: hey-api 0.99 derives a hardcoded
`baseUrl: 'http://127.0.0.1:8740'` from an HTTP input URL (the spec has no
`servers` entry), which breaks non-8740 origins — the desktop app serves the
page from a runtime-picked port, so its API calls would hit a foreign backend
while its WebSocket listens on its own, and edits would never refresh the UI.
A file input has no origin, keeping the client on relative (same-origin) URLs.

To use the anonymous Artifactory registry without credentials:

```bash
npm install --userconfig=/dev/null \
  --registry=https://artifactory.ubisoft.org/api/npm/npm/
```
