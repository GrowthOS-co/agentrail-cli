import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Environment } from './environments.js';
import { CliError, EXIT } from './errors.js';
import { isSystemError, readJson, writePrivateJson } from './files.js';
import type { CatalogTool, PropertySchema } from './mcp.js';
import { withServer } from './mcp.js';
import type { Runtime } from './runtime.js';

/**
 * The tool list is fetched from the server and kept this long, so a burst of
 * commands asks once, and help works offline. A command that is not in a
 * kept list asks again: a new tool needs no CLI release (CLI-001).
 */
const FRESH_FOR_MS = 10 * 60_000;

interface CachedCatalog {
  readonly fetchedAt: string;
  readonly tools: readonly CatalogTool[];
}

export interface Catalog {
  readonly tools: readonly CatalogTool[];
  /** True when read from the cache rather than the server just now. */
  readonly cached: boolean;
}

function cachePath(runtime: Runtime, environment: Environment): string {
  return join(runtime.configDir, 'catalog', `${environment.name}.json`);
}

/** The kept catalog. One cut short or of another shape counts as none. */
async function cachedCatalog(
  runtime: Runtime,
  environment: Environment,
): Promise<CachedCatalog | undefined> {
  let value: unknown;
  try {
    value = await readJson(cachePath(runtime, environment));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const cache = value as Partial<CachedCatalog> | null | undefined;
  return typeof cache?.fetchedAt === 'string' && Array.isArray(cache.tools)
    ? (cache as CachedCatalog)
    : undefined;
}

/** The catalog from the server, kept for the next command. */
export async function fetchCatalog(
  runtime: Runtime,
  environment: Environment,
): Promise<Catalog> {
  const tools = await withServer(runtime, environment, (server) =>
    server.listTools(),
  );
  const cache: CachedCatalog = {
    fetchedAt: runtime.now().toISOString(),
    tools,
  };
  await writePrivateJson(cachePath(runtime, environment), cache);
  return { tools, cached: false };
}

/**
 * A fresh kept catalog, else the server's. For help only, a stale kept one
 * is used when the server cannot be asked.
 */
export async function loadCatalog(
  runtime: Runtime,
  environment: Environment,
  purpose: 'run' | 'help',
): Promise<Catalog> {
  const cache = await cachedCatalog(runtime, environment);
  const age = cache
    ? runtime.now().getTime() - new Date(cache.fetchedAt).getTime()
    : Infinity;
  if (cache && age < FRESH_FOR_MS) return { tools: cache.tools, cached: true };
  try {
    return await fetchCatalog(runtime, environment);
  } catch (error) {
    if (purpose === 'help' && cache)
      return { tools: cache.tools, cached: true };
    throw error;
  }
}

/** `simulations_list_runs` is `agentrail simulations list-runs`. */
export function commandOf(toolName: string): { area: string; action: string } {
  const [area = toolName, ...rest] = toolName.split('_');
  return { area, action: rest.join('-') };
}

/** `needsAttention` is `--needs-attention`. */
export function flagOf(property: string): string {
  return property.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

type ValueKind = 'string' | 'number' | 'boolean' | 'json';

function typesOf(schema: PropertySchema): readonly string[] {
  if (schema.anyOf) return schema.anyOf.flatMap(typesOf);
  if (schema.type === undefined) return ['json'];
  return typeof schema.type === 'string' ? [schema.type] : schema.type;
}

/** How a flag's text becomes the value a tool's input schema expects. */
export function kindOf(schema: PropertySchema): {
  kind: ValueKind;
  nullable: boolean;
} {
  const types = typesOf(schema);
  const nullable = types.includes('null');
  const [only, ...others] = types.filter((type) => type !== 'null');
  if (only === undefined || others.length > 0)
    return { kind: 'json', nullable };
  switch (only) {
    case 'string':
      return { kind: 'string', nullable };
    case 'number':
    case 'integer':
      return { kind: 'number', nullable };
    case 'boolean':
      return { kind: 'boolean', nullable };
    default:
      return { kind: 'json', nullable };
  }
}

/** Parses one flag's text into its value, refusing what does not fit. */
export function valueOf(
  text: string | true,
  schema: PropertySchema,
  flag: string,
): unknown {
  const { kind, nullable } = kindOf(schema);
  if (nullable && text === 'null') return null;
  switch (kind) {
    case 'boolean':
      if (text === true || text === 'true') return true;
      if (text === 'false') return false;
      throw new CliError(EXIT.usage, `--${flag} takes true or false.`);
    case 'number': {
      const number = Number(text);
      if (text === true || text.trim() === '' || !Number.isFinite(number)) {
        throw new CliError(EXIT.usage, `--${flag} takes a number.`);
      }
      return number;
    }
    case 'string':
      if (text === true) {
        throw new CliError(EXIT.usage, `--${flag} takes a value.`);
      }
      return text;
    case 'json':
      try {
        return JSON.parse(String(text)) as unknown;
      } catch {
        throw new CliError(
          EXIT.usage,
          `--${flag} takes JSON, such as '["a","b"]' or '{"key":"value"}'.`,
        );
      }
  }
}

/**
 * A tool's input from `--input`/`--input-file`, then each flag over it, then
 * the workspace the CLI resolved. Required fields still missing are named.
 */
export async function inputOf(
  tool: CatalogTool,
  options: Readonly<Record<string, unknown>>,
  workspaceId: string | undefined,
  cwd: string,
): Promise<Record<string, unknown>> {
  const properties = tool.inputSchema.properties ?? {};
  let input: Record<string, unknown> = {};
  if (typeof options.inputFile === 'string') {
    input = parseObject(
      await inputFile(resolve(cwd, options.inputFile)),
      '--input-file',
    );
  }
  if (typeof options.input === 'string') {
    input = { ...input, ...parseObject(options.input, '--input') };
  }
  for (const [property, schema] of Object.entries(properties)) {
    // Commander stores `--needs-attention` as `needsAttention`: the
    // property's own name.
    const given = options[property];
    if (given !== undefined) {
      input[property] = valueOf(
        given as string | true,
        schema,
        flagOf(property),
      );
    }
  }
  if ('workspaceId' in properties && workspaceId !== undefined) {
    input.workspaceId ??= workspaceId;
  }
  const missing = (tool.inputSchema.required ?? []).filter(
    (property) => input[property] === undefined,
  );
  if (missing.length > 0) {
    throw new CliError(
      EXIT.usage,
      `Missing ${missing.map((property) => `--${flagOf(property)}`).join(', ')}.`,
    );
  }
  return input;
}

async function inputFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (
      isSystemError(error) &&
      ['ENOENT', 'EISDIR', 'EACCES'].includes(error.code ?? '')
    ) {
      throw new CliError(
        EXIT.usage,
        `--input-file: cannot read ${path} (${error.code ?? ''}).`,
        { cause: error },
      );
    }
    throw error;
  }
}

function parseObject(text: string, source: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliError(EXIT.usage, `${source} is not valid JSON.`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError(EXIT.usage, `${source} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}
