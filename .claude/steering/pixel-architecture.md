# Pixel — Error Tracking + Auto-Fix Queue

Trigger: pixel / gg-pixel / Ctrl+E / error tracking / PixelOverlay

`@kenkaiiii/gg-pixel` is a drop-in error tracking SDK. Errors flow to a Cloudflare Worker (`gg-pixel-server`) backed by D1. `ggcoder pixel` opens an in-Ink overlay that lists open errors per project and hands each one off to the existing agent loop — same UX as the Task pane.

## CLI

```bash
ggcoder pixel install          # Detect framework, wire up SDK + .env, register project key
ggcoder pixel                  # Open the in-Ink overlay (also: Ctrl+E inside running ggcoder)
ggcoder pixel fix <error_id>   # Fix one error end-to-end (subprocess flow, for non-TTY use)
ggcoder pixel run              # Auto-fix every open error (non-interactive)
```

## In-Ink Fix Flow (the main path)

`Ctrl+E` from inside ggcoder, or `ggcoder pixel`, opens `PixelOverlay`. Keys: `↑↓ navigate · Enter fix one · f fix all · d delete · Esc close`.

When a fix starts, `startPixelFix(errorId)` in `App.tsx` swaps **four** things in lockstep before calling `agentLoop.run(prep.prompt)`:

1. `process.chdir(prep.projectPath)` — for code reading `process.cwd()` directly.
2. `setCurrentTools(rebuildToolsForCwd(prep.projectPath))` — read/write/edit/bash/find/grep/ls/tasks/sub-agent are all baked with `cwd` at creation, so they MUST be rebuilt; chdir alone is not enough.
3. System prompt is rebuilt with the new project root (`buildSystemPrompt(prep.projectPath, …)`) and swapped into `messagesRef.current[0]` — this is the only place the model itself learns "where it is".
4. `setDisplayedCwd(prep.projectPath)` — Banner + Footer read this. Because Banner lives inside Ink's `<Static>`, also bump `staticKey` so Static remounts and re-renders the banner with the new path.

Reset chat state (`setHistory`, `setLiveItems`, `setStaticKey`, screen clear) **AFTER** the chdir is committed — otherwise the old-cwd banner gets written first and you see two banners stacked.

`onDone` in `useAgentLoop` finalizes the fix: `finalizePixelFix(prep)` observes the `fix/pixel-{id}` branch + commits and patches the D1 status to `awaiting_review` or `failed`. Run-all picks up the next open error via the same path.

## Backend (`packages/gg-pixel-server/`)

Hono on Workers + D1. Routes:

- `POST /ingest` — SDK posts events; server dedupes by `(project_id, fingerprint)`. Validated + size-capped + per-project unique-fingerprint cap (10K). CORS-open since the publishable `project_key` is the auth boundary for ingest only.
- `POST /api/projects` — globally rate-limited (100/hr). Returns `{ id, key, secret }` once on creation; the `secret` is the bearer token for every other `/api/*` call from that project's owner.
- `GET /api/projects/:id/errors` — bearer-authed (`Authorization: Bearer sk_live_…`); 403 if the secret doesn't own the project.
- `GET /api/errors/:id` — bearer-authed + cross-project scoped (403 if the bearer's project doesn't own the row).
- `PATCH /api/errors/:id` — bearer-authed + scoped. Drives `open → in_progress → awaiting_review → merged` (or `failed`).
- `DELETE /api/errors/:id` — bearer-authed + scoped (used by `d` in the overlay).

`~/.gg/projects.json` stores `{ name, path, secret }` per project. The CLI reads the secret on every management call. Re-run `ggcoder pixel install` to refresh the secret if a mapping is legacy (no `secret` field).
