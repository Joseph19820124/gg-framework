# Publishing to npm

Trigger: publish / release / bump version / npm publish

Must use `pnpm publish` (not `npm publish`) so `workspace:*` references resolve to real versions.

## Steps

1. Bump version in all 3 `package.json` files (keep them in sync)
2. Build all packages: `pnpm build`
3. Publish in dependency order:

```bash
pnpm --filter @kenkaiiii/gg-ai publish --no-git-checks
pnpm --filter @kenkaiiii/gg-agent publish --no-git-checks
pnpm --filter @kenkaiiii/ggcoder publish --no-git-checks
```

## Auth

- npm granular access token must be set: `npm set //registry.npmjs.org/:_authToken=<token>`
- All packages use `"publishConfig": { "access": "public" }` (required for scoped packages)
- `--no-git-checks` skips git dirty/tag checks (needed since we don't tag releases)

## Verify

```bash
npm view @kenkaiiii/ggcoder versions --json   # check published versions
npm i -g @kenkaiiii/ggcoder@<version>         # test install
ggcoder --help                                # verify CLI works
```

If `npm i` gets ETARGET after publishing, clear cache: `npm cache clean --force`
