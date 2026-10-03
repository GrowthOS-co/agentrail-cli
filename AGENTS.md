# agentrail-cli agent map

The `agentrail` command, published to npm as `agentrail-cli`. It is a
connected app of the Agentrail MCP server: it signs in with the OAuth device
flow and runs the server's tools, so its product commands come from the
server's tool list and a new tool needs no CLI release. What it must do is
specified in the Agentrail product spec, `docs/product/agent-interfaces.md`
§9 in the private `GrowthOS-co/argus` repository.

## Commands

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- `node dist/cli.js --env dev <command>` runs a build against dev.

## Rules no machine can check

- Understand the existing code before editing; follow the approved plan and
  ask before changing its scope.
- One pull request per piece of work. Bring `main` in with
  `git merge --no-ff`. Never rebase, amend a pushed commit, or force-push.
- A test must earn its place: finish "this test fails if someone …" with a
  realistic change, and watch it fail by making that change.
- Never hide a failure: no swallowed error, no default for a value that must
  exist. A message the user sees names the command that fixes it, and an exit
  code keeps its meaning (`src/errors.ts`).
- Data goes to stdout, every message to stderr. The CLI never prompts
  without a terminal.
- This repository is public. Never commit a secret, a token, or anything
  from a real account; client IDs and public URLs are not secrets.
- Every environment's values live in `src/environments.ts`; dev is only ever
  chosen explicitly.
