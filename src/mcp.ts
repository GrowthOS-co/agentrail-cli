import {
  Client,
  ProtocolError,
  SdkError,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import { commandFor } from './credentials.js';
import { clientIdOf, type Environment } from './environments.js';
import { CliError, EXIT } from './errors.js';
import type { Runtime } from './runtime.js';
import { accessToken } from './session.js';
import { VERSION } from './version.js';

/** A JSON Schema property, as far as the CLI reads one. */
export interface PropertySchema {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly anyOf?: readonly PropertySchema[];
  readonly $ref?: string;
}

/** A tool as the server lists it. */
export interface CatalogTool {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly inputSchema: {
    readonly properties?: Readonly<Record<string, PropertySchema>>;
    readonly required?: readonly string[];
  };
  readonly annotations?: { readonly readOnlyHint?: boolean } | undefined;
}

/** A tool's answer: its summary for people, and its data. */
export type ToolReply =
  | {
      readonly kind: 'result';
      readonly summary: string;
      readonly data: unknown;
    }
  | { readonly kind: 'refused'; readonly message: string };

export interface Connection {
  listTools(): Promise<CatalogTool[]>;
  callTool(name: string, input: Record<string, unknown>): Promise<ToolReply>;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  return first?.type === 'text' && typeof first.text === 'string'
    ? first.text
    : '';
}

/**
 * The server's answer to a CLI older than the oldest it serves (CLI-008). Its
 * message names the command that updates the CLI.
 */
const OUTDATED_CLI = -32000;

/** What a failure talking to the server means for the person running us. */
function asCliError(error: unknown, environment: Environment): unknown {
  if (error instanceof CliError) return error;
  if (error instanceof SdkHttpError && error.status === 401) {
    return new CliError(
      EXIT.signIn,
      `Agentrail ${environment.name} did not accept your sign-in. Run ${commandFor(environment, 'login')}.`,
      { cause: error },
    );
  }
  if (error instanceof ProtocolError && error.code === OUTDATED_CLI) {
    return new CliError(EXIT.usage, error.message, { cause: error });
  }
  if (error instanceof ProtocolError) {
    return new CliError(
      EXIT.refused,
      `${error.message}. Run agentrail tools to see the commands you can use.`,
      { cause: error },
    );
  }
  if (error instanceof SdkError || error instanceof TypeError) {
    return new CliError(
      EXIT.unavailable,
      `Could not use Agentrail ${environment.name} at ${environment.mcpUrl}: ${error.message}`,
      { cause: error },
    );
  }
  return error;
}

/**
 * Connects to the environment's MCP server as the signed-in user, runs `use`,
 * and disconnects. The CLI is a connected app like any MCP host: it sees the
 * tools the user's role allows, and nothing else.
 */
export async function withServer<T>(
  runtime: Runtime,
  environment: Environment,
  use: (connection: Connection) => Promise<T>,
): Promise<T> {
  // An environment that does not exist yet says so before anything else.
  clientIdOf(environment);
  const token = await accessToken(runtime, environment);
  const client = new Client({ name: 'agentrail-cli', version: VERSION });
  const transport = new StreamableHTTPClientTransport(
    new URL(environment.mcpUrl),
    {
      requestInit: {
        headers: {
          authorization: `Bearer ${token}`,
          // How the server knows a CLI too old to serve (CLI-008).
          'user-agent': `agentrail-cli/${VERSION}`,
        },
      },
      fetch: runtime.fetch,
    },
  );
  const connection: Connection = {
    async listTools() {
      const tools: CatalogTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(
          cursor === undefined ? {} : { cursor },
        );
        tools.push(...(page.tools as CatalogTool[]));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return tools;
    },
    async callTool(name, input) {
      const result = await client.callTool({ name, arguments: input });
      const text = textOf(result.content);
      if (result.isError === true) return { kind: 'refused', message: text };
      // The server's text is the summary, a blank line, then the data.
      return {
        kind: 'result',
        summary: text.split('\n\n')[0] ?? '',
        data: result.structuredContent,
      };
    },
  };
  try {
    await client.connect(transport);
    return await use(connection);
  } catch (error) {
    throw asCliError(error, environment);
  } finally {
    await client.close();
  }
}
