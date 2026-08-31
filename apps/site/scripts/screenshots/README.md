# Screenshots

The images on theopennote.com are captured from the real app, not mocked up.

```bash
pnpm site:screenshots            # all of them
pnpm site:screenshots editor     # just one
```

`capture.mjs` serves the desktop app's web build with `stub.js` standing in for
the Tauri IPC, drives the UI into each state via `?shot=<name>`, and photographs
it with headless Chrome at 2× on a 1280×840 viewport.

Everything it touches — the injected `<script>` tag in `apps/desktop/index.html`
and the stub copied into `apps/desktop/public/` — is put back in a `finally`, so
an interrupted run leaves nothing behind.

## Adding a shot

1. Add a driver to `shots` in `stub.js`. It should leave the app in the state you
   want photographed, and may `await wait(ms)` for anything asynchronous.
2. Add its name to `SHOTS` in `capture.mjs`.
3. Run it, look at the PNG, and reference it from a page.

Set `CHROME` if your Chrome or Chromium lives somewhere unusual.
