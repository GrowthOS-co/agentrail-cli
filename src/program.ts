import { inspect } from 'node:util';

import { Command, CommanderError, Option } from 'commander';

import { agentsFrom, setUpAgents } from './agent-setup.js';
import {
  commandOf,
  fetchCatalog,
  flagOf,
  inputOf,
  kindOf,
  loadCatalog,
} from './catalog.js';
import { deleteCredential, loadCredential } from './credentials.js';
import { diagnose } from './doctor.js';
import { selectEnvironment, type Environment } from './environments.js';
import { CliError, EXIT, type ExitCode } from './errors.js';
import {
  completeDeviceLogin,
  loginCommand,
  pendingLogin,
  startDeviceLogin,
} from './login.js';
import { withServer, type CatalogTool, type Connection } from './mcp.js';
import { outputMode, printData, say } from './output.js';
import type { Runtime } from './runtime.js';
import { newestVersion, UPDATE_TIMEOUT_MS, updateNotice } from './updates.js';
import { VERSION } from './version.js';
import { isNewer } from './versions.js';
import {
  findLinkFile,
  removeLink,
  workspaceFor,
  writeLink,
} from './workspace.js';

const ISSUES_URL = 'https://github.com/GrowthOS-co/agentrail-cli/issues';

const BUILT_INS = [
  'login',
  'logout',
  'whoami',
  'tools',
  'link',
  'unlink',
  'doctor',
  'update',
  'agent',
];
/** Options every command has; a tool input with one of these names is not a flag. */
const GLOBAL_OPTIONS = new Set([
  'env',
  'json',
  'workspace',
  'input',
  'inputFile',
  'updateCheck',
]);
/** Global options that take a value, so the word after one is not a command. */
const VALUED_GLOBALS = new Set(['--env', '--workspace']);

interface GlobalOptions {
  readonly env?: string;
  readonly json?: boolean;
  readonly workspace?: string;
}

/** The command words before any flag: `simulations list-runs`. */
function commandWords(argv: readonly string[]): {
  words: string[];
  env: string | undefined;
  help: boolean;
} {
  const words: string[] = [];
  let env: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--env') env = argv[index + 1];
    if (token.startsWith('--env=')) env = token.slice('--env='.length);
    if (VALUED_GLOBALS.has(token)) {
      index += 1;
    } else if (!token.startsWith('-') && words.length < 2) {
      words.push(token);
    }
  }
  return { words, env, help: argv.includes('--help') || argv.includes('-h') };
}

function globalsOf(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

/** One tool as `agentrail <area> <action>`, its inputs as flags. */
function addToolCommand(
  area: Command,
  tool: CatalogTool,
  runtime: Runtime,
  environment: Environment,
): void {
  const { action } = commandOf(tool.name);
  const command = area
    .command(action)
    .summary(tool.title ?? tool.name)
    .description(tool.description ?? tool.title ?? tool.name);
  const required = new Set(tool.inputSchema.required ?? []);
  for (const [property, schema] of Object.entries(
    tool.inputSchema.properties ?? {},
  )) {
    // The workspace comes from --workspace, AGENTRAIL_WORKSPACE or the link.
    if (property === 'workspaceId' || GLOBAL_OPTIONS.has(property)) continue;
    const flag = flagOf(property);
    const value = kindOf(schema).kind === 'boolean' ? '[value]' : '<value>';
    const description = `${schema.description ?? ''}${required.has(property) ? ' (required)' : ''}`;
    command.addOption(new Option(`--${flag} ${value}`, description.trim()));
  }
  command
    .option(
      '--input <json>',
      'The whole input as a JSON object; flags override it.',
    )
    .option(
      '--input-file <path>',
      'The whole input from a JSON file; flags override it.',
    )
    .action(async (options: Record<string, unknown>, self: Command) => {
      const globals = globalsOf(self);
      const workspaceId = await workspaceFor(
        runtime,
        environment,
        globals.workspace,
      );
      const input = await inputOf(tool, options, workspaceId, runtime.cwd);
      const reply = await withServer(runtime, environment, (server) =>
        server.callTool(tool.name, input),
      );
      if (reply.kind === 'refused') {
        throw new CliError(EXIT.refused, reply.message);
      }
      say(runtime, reply.summary);
      printData(
        runtime,
        outputMode(runtime, globals.json === true),
        reply.data,
      );
    });
}

/**
 * The commands of one area from the catalog. A command the kept catalog does
 * not have is looked up on the server before it is called unknown.
 */
async function addAreaCommands(
  program: Command,
  runtime: Runtime,
  environment: Environment,
  words: readonly string[],
  help: boolean,
): Promise<void> {
  const [areaName = '', actionName] = words;
  const matching = (tools: readonly CatalogTool[]) =>
    tools.filter((tool) => commandOf(tool.name).area === areaName);
  let catalog = await loadCatalog(runtime, environment, help ? 'help' : 'run');
  const known = (tools: readonly CatalogTool[]) =>
    matching(tools).length > 0 &&
    (actionName === undefined ||
      matching(tools).some(
        (tool) => commandOf(tool.name).action === actionName,
      ));
  if (!known(catalog.tools) && catalog.cached && !help) {
    catalog = await fetchCatalog(runtime, environment);
  }
  const tools = matching(catalog.tools);
  if (tools.length === 0) {
    throw new CliError(
      EXIT.usage,
      `Unknown command "${areaName}". Run agentrail tools to see every command.`,
    );
  }
  const area = program
    .command(areaName)
    .description(`Agentrail ${areaName} commands.`)
    .showHelpAfterError('Run agentrail tools to see every command.');
  for (const tool of tools) addToolCommand(area, tool, runtime, environment);
}

async function everyWorkspace(
  server: Connection,
): Promise<{ id: string; name: string }[]> {
  const workspaces: { id: string; name: string }[] = [];
  let cursor: string | undefined;
  do {
    const reply = await server.callTool('workspaces_list', {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (reply.kind === 'refused')
      throw new CliError(EXIT.refused, reply.message);
    const page = reply.data as {
      items: { id: string; name: string }[];
      nextCursor: string | null;
    };
    workspaces.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return workspaces;
}

function builtIns(program: Command, runtime: Runtime): void {
  const environmentOf = (command: Command) =>
    selectEnvironment(globalsOf(command).env, runtime);

  program
    .command('login')
    .description(
      'Sign in to Agentrail in your browser. Without a terminal, the first run prints the sign-in URL and code as JSON and the next run finishes signing in.',
    )
    .option(
      '--insecure-storage',
      'Keep the credential in a file only you can read, instead of the OS keychain.',
    )
    .action(async (options: { insecureStorage?: boolean }, self: Command) => {
      const environment = environmentOf(self);
      const storage = options.insecureStorage === true ? 'file' : 'keychain';
      const next = loginCommand(environment, storage);
      if (!runtime.stdinIsTTY) {
        const pending = await pendingLogin(runtime, environment);
        if (!pending) {
          const started = await startDeviceLogin(runtime, environment, storage);
          printData(runtime, 'json', {
            status: 'pending',
            verificationUrl:
              started.verificationUriComplete ?? started.verificationUri,
            userCode: started.userCode,
            expiresAt: started.expiresAt,
            next,
          });
          say(
            runtime,
            `Ask the user to open the URL and confirm code ${started.userCode}, then run ${next} again.`,
          );
          return;
        }
        // Asking for a file on the finishing run is heard: it is how a
        // sign-in the keychain could not keep is finished.
        const credential = await completeDeviceLogin(
          runtime,
          environment,
          storage === 'file' ? { ...pending, storage } : pending,
        );
        printData(runtime, 'json', {
          status: 'signed_in',
          environment: environment.name,
          email: credential.email ?? null,
        });
        return;
      }
      const started = await startDeviceLogin(runtime, environment, storage);
      const url = started.verificationUriComplete ?? started.verificationUri;
      say(
        runtime,
        `To sign in to Agentrail ${environment.name}, open ${url} and confirm the code ${started.userCode}.`,
      );
      runtime.openBrowser(url);
      const credential = await completeDeviceLogin(
        runtime,
        environment,
        started,
      );
      say(
        runtime,
        `Signed in to Agentrail ${environment.name}${credential.email ? ` as ${credential.email}` : ''}.`,
      );
    });

  program
    .command('logout')
    .description('Forget this computer’s sign-in.')
    .action(async (_options: unknown, self: Command) => {
      const environment = environmentOf(self);
      const removed = await deleteCredential(runtime, environment);
      const places = [
        ...(removed.file ? ['the credentials file'] : []),
        ...(removed.keychain ? ['the OS keychain'] : []),
      ];
      const unchecked =
        removed.keychainFailure === undefined
          ? ''
          : ` Could not check the OS keychain (${removed.keychainFailure}).`;
      if (places.length === 0 && removed.keychainFailure !== undefined) {
        throw new CliError(
          EXIT.signIn,
          `No credentials file for Agentrail ${environment.name}.${unchecked}`,
        );
      }
      say(
        runtime,
        places.length === 0
          ? `Not signed in to Agentrail ${environment.name}.`
          : `Signed out of Agentrail ${environment.name}: removed the sign-in from ${places.join(' and ')}.${unchecked}`,
      );
      if (runtime.env.AGENTRAIL_TOKEN) {
        say(
          runtime,
          'AGENTRAIL_TOKEN is still set, and commands use it: unset it to stop.',
        );
      }
    });

  program
    .command('whoami')
    .description(
      'Show who you are signed in as and the workspace commands use.',
    )
    .action(async (_options: unknown, self: Command) => {
      const environment = environmentOf(self);
      // AGENTRAIL_TOKEN wins over a stored sign-in, so it is the one shown.
      const given = Boolean(runtime.env.AGENTRAIL_TOKEN);
      const stored = given
        ? undefined
        : await loadCredential(runtime, environment);
      const reply = await withServer(runtime, environment, (server) =>
        server.callTool('workspaces_list', {}),
      );
      if (reply.kind === 'refused')
        throw new CliError(EXIT.refused, reply.message);
      const linked = await workspaceFor(
        runtime,
        environment,
        globalsOf(self).workspace,
      );
      const data = reply.data as { defaultWorkspaceId: string };
      say(runtime, reply.summary);
      if (given) say(runtime, 'Signed in with the token in AGENTRAIL_TOKEN.');
      printData(runtime, outputMode(runtime, globalsOf(self).json === true), {
        environment: environment.name,
        email: stored?.credential.email ?? null,
        signedInUntil: stored?.credential.expiresAt ?? null,
        workspaceId: linked ?? data.defaultWorkspaceId,
      });
    });

  program
    .command('tools')
    .description('List every Agentrail command your role can use.')
    .action(async (_options: unknown, self: Command) => {
      const environment = environmentOf(self);
      const { tools } = await fetchCatalog(runtime, environment);
      const mode = outputMode(runtime, globalsOf(self).json === true);
      printData(
        runtime,
        mode,
        tools.map((tool) => {
          const { area, action } = commandOf(tool.name);
          return {
            command: `${area} ${action}`,
            title: tool.title ?? tool.name,
            readOnly: tool.annotations?.readOnlyHint === true,
            ...(mode === 'json' ? { description: tool.description ?? '' } : {}),
          };
        }),
      );
      say(
        runtime,
        'Run agentrail <area> <action> --help for a command’s inputs.',
      );
    });

  program
    .command('link')
    .description(
      'Use a workspace for every command run in this directory and those under it.',
    )
    .argument(
      '[workspaceId]',
      'The workspace; agentrail workspaces list shows them.',
    )
    .action(
      async (
        workspaceId: string | undefined,
        _options: unknown,
        self: Command,
      ) => {
        const environment = environmentOf(self);
        if (workspaceId === undefined) {
          throw new CliError(
            EXIT.usage,
            'Name the workspace: agentrail link <workspaceId>. Run agentrail workspaces list to see them.',
          );
        }
        const workspaces = await withServer(
          runtime,
          environment,
          everyWorkspace,
        );
        const workspace = workspaces.find((one) => one.id === workspaceId);
        if (!workspace) {
          throw new CliError(
            EXIT.refused,
            `No workspace ${workspaceId} in your organization. Run agentrail workspaces list to see them.`,
          );
        }
        const path = await writeLink(runtime.cwd, {
          environment: environment.name,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        });
        say(
          runtime,
          `Commands under ${runtime.cwd} now use "${workspace.name}" in ${environment.name} (${path}).`,
        );
      },
    );

  program
    .command('doctor')
    .description('Check what Agentrail commands need, and say what to fix.')
    .action(async (_options: unknown, self: Command) => {
      const environment = environmentOf(self);
      const { checks, exitCode } = await diagnose(runtime, environment);
      printData(
        runtime,
        outputMode(runtime, globalsOf(self).json === true),
        checks,
      );
      if (exitCode !== EXIT.ok) {
        const first = checks.find((check) => check.status === 'failed');
        throw new CliError(exitCode, first?.detail ?? 'A check failed.');
      }
    });

  program
    .command('update')
    .description(
      'Show whether a newer agentrail-cli exists, and how to install it.',
    )
    .action(async (_options: unknown, self: Command) => {
      const found = await newestVersion(runtime, UPDATE_TIMEOUT_MS);
      const upToDate =
        found.newest === undefined || !isNewer(found.newest, found.installed);
      printData(runtime, outputMode(runtime, globalsOf(self).json === true), {
        ...found,
        upToDate,
      });
      say(
        runtime,
        upToDate
          ? `agentrail-cli ${found.installed} is the newest on ${found.channel}.`
          : `Update to ${found.newest}: ${found.upgrade}`,
      );
    });

  program
    .command('agent')
    .description('Set up coding agents to use Agentrail.')
    .command('setup')
    .description(
      'Install the Agentrail skill and MCP server into Claude Code, Codex and Cursor, for every project of yours.',
    )
    .option(
      '--only <agents>',
      'Only these, comma-separated: claude, codex, cursor.',
    )
    .option(
      '--project',
      'Into this repository instead, for everyone working in it.',
    )
    .option(
      '--read-only',
      'Use the read-only MCP server, which offers only tools that read.',
    )
    .action(
      async (
        options: { only?: string; project?: boolean; readOnly?: boolean },
        self: Command,
      ) => {
        const environment = environmentOf(self);
        const { steps, failure } = await setUpAgents(runtime, environment, {
          only: agentsFrom(options.only),
          project: options.project === true,
          readOnly: options.readOnly === true,
        });
        printData(
          runtime,
          outputMode(runtime, globalsOf(self).json === true),
          steps,
        );
        if (failure) throw failure;
        if (steps.every((step) => step.status === 'skipped')) {
          say(
            runtime,
            'No coding agent found: install Claude Code, Codex or Cursor first.',
          );
        }
      },
    );

  program
    .command('unlink')
    .description('Stop using the workspace linked to this directory.')
    .action(async () => {
      const found = await findLinkFile(runtime.cwd);
      if (!found) {
        say(runtime, 'No workspace is linked here.');
        return;
      }
      await removeLink(found.path);
      say(runtime, `Removed ${found.path}.`);
    });
}

function baseProgram(runtime: Runtime): Command {
  return new Command('agentrail')
    .description(
      'Agentrail from a terminal or an AI coding agent. Run agentrail tools for every product command, and agentrail <area> --help for one area.',
    )
    .version(VERSION)
    .option(
      '--env <name>',
      'prod or dev. Defaults to AGENTRAIL_ENV, then prod.',
    )
    .option(
      '--workspace <id>',
      'The workspace to use. Defaults to AGENTRAIL_WORKSPACE, then this directory’s link, then your default.',
    )
    .option('--json', 'Print data as JSON, as when output is not a terminal.')
    .option('--no-update-check', 'Do not check npm for a newer version today.')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        runtime.stdout.write(text);
      },
      writeErr: (text) => {
        runtime.stderr.write(text);
      },
    });
}

/** Runs one command line and returns its exit code. */
export async function run(
  runtime: Runtime,
  argv: readonly string[],
): Promise<ExitCode> {
  // Asked alongside the command, so it adds no wait unless the command ends
  // first, and then at most the check's 2 s, once a day. Its notice goes to
  // stderr once the command is done. A failure it does not know is shown in
  // full, but the command's exit code stays the command's.
  const notice = updateNotice(runtime, argv).catch(
    (error: unknown) => `The update check failed:\n${inspect(error)}`,
  );
  try {
    const program = baseProgram(runtime);
    builtIns(program, runtime);
    const { words, env, help } = commandWords(argv);
    const [first] = words;
    if (first !== undefined && first !== 'help' && !BUILT_INS.includes(first)) {
      const environment = selectEnvironment(env, runtime);
      await addAreaCommands(program, runtime, environment, words, help);
    }
    await program.parseAsync([...argv], { from: 'user' });
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    if (error instanceof CliError) {
      say(runtime, error.message);
      return error.exitCode;
    }
    // A failure the CLI does not know: shown in full, with a code no script
    // reads as Agentrail's answer.
    say(
      runtime,
      `agentrail-cli failed unexpectedly. Please report it at ${ISSUES_URL}:\n${inspect(error)}`,
    );
    return EXIT.unexpected;
  } finally {
    const text = await notice;
    if (text !== undefined) say(runtime, text);
  }
}
