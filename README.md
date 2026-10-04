# agentrail-cli

The Agentrail command line. Sign in once, then use every Agentrail tool —
competitors, prompts, evaluations, simulation runs, the Brand Vault — from a
terminal or from an AI coding agent.

> Agentrail's production environment is not open yet. Until it is, use the
> dev environment: pass `--env dev` or set `AGENTRAIL_ENV=dev`.

## Use

```sh
npm install -g agentrail-cli@next      # pre-releases, while production is not open
agentrail --env dev login              # sign in in your browser
agentrail --env dev tools              # every command your role can use
agentrail --env dev competitors list
agentrail --env dev agent setup        # Claude Code, Codex and Cursor
agentrail --env dev doctor             # what is missing, and how to fix it
```

From a clone of this repository: `pnpm install && pnpm build`, then
`node dist/cli.js --env dev login`.

The package installs one command, `agentrail`. Never install a package named
just `agentrail`: it belongs to someone else.

- **Commands come from Agentrail.** `agentrail <area> <action>` runs an
  Agentrail tool, and its inputs are flags (`--limit 5`, `--needs-attention`).
  Lists and objects take JSON (`--tag-ids '["…"]'`), and `--input` or
  `--input-file` passes a whole input. `agentrail tools` lists them all, and a
  tool Agentrail adds works without updating the CLI.
- **Workspace.** Commands use `--workspace <id>`, then `AGENTRAIL_WORKSPACE`,
  then the workspace `agentrail link <id>` recorded for the directory, then
  your default workspace.
- **Output.** A table in a terminal; JSON when output is not a terminal, with
  `--json`, or inside a coding agent. Data goes to stdout, messages to stderr.
- **Agents.** Without a terminal, `agentrail login` prints the sign-in URL
  and code as JSON; run it again once the person has confirmed the code.
- **Coding agents.** `agentrail agent setup` installs the Agentrail skill and
  adds the Agentrail MCP server to Claude Code, Codex and Cursor for every
  project of yours (`--project` for this repository only, `--only` to pick
  agents, `--read-only` for the server that only reads). Each agent signs in
  to the server itself. In Claude Code you can also run
  `/plugin marketplace add GrowthOS-co/agentrail-cli`, and any agent that
  reads Agent Skills can use `npx skills add GrowthOS-co/agentrail-cli`.
- **Updates.** `agentrail update` shows the newest version and how to install
  it. Commands check npm at most once a day and say so on stderr;
  `--no-update-check` or `AGENTRAIL_NO_UPDATE_CHECK=1` turns that off.
- **Credentials** are kept in the OS keychain. `login --insecure-storage`
  keeps them in a file only you can read instead. A token in
  `AGENTRAIL_TOKEN` is used as given and never stored.

## Exit codes

| Code | Meaning                                                                           |
| ---- | --------------------------------------------------------------------------------- |
| 0    | Done                                                                              |
| 1    | Agentrail refused: not found, not allowed, or invalid input                       |
| 2    | The command line is wrong, or this CLI is too old: the message says how to update |
| 3    | Not signed in, or the sign-in expired: run `agentrail login`                      |
| 4    | Agentrail or the network could not be reached                                     |

## Releasing

Bump `version` in `package.json` and `.claude-plugin/plugin.json` together,
merge, then push the tag `v<version>`. The Release workflow publishes it to
npm with provenance once the `npm` environment's reviewer approves: a
pre-release such as `0.1.0-dev.2` under `next`, a release under `latest`.

## License

Apache-2.0
