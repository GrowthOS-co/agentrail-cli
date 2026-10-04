import type { Runtime } from './runtime.js';

/**
 * Variables coding agents set in the commands they run. Most agents also run
 * commands without a terminal, which alone selects JSON.
 */
const AGENT_VARIABLES = ['AGENT', 'AI_AGENT', 'CLAUDECODE', 'CURSOR_AGENT'];

export type OutputMode = 'json' | 'table';

/** JSON for programs and agents, a table for a person (CLI-003). */
export function outputMode(runtime: Runtime, json: boolean): OutputMode {
  const agent = AGENT_VARIABLES.some((name) => runtime.env[name]);
  return json || agent || !runtime.stdout.isTTY ? 'json' : 'table';
}

/** A message for the person or agent: always stderr, never mixed with data. */
export function say(runtime: Runtime, message: string): void {
  if (message.length > 0) runtime.stderr.write(`${message}\n`);
}

/** Data: always stdout. */
export function printData(
  runtime: Runtime,
  mode: OutputMode,
  data: unknown,
): void {
  runtime.stdout.write(
    mode === 'json' ? `${JSON.stringify(data, null, 2)}\n` : render(data),
  );
}

const MAX_COLUMNS = 6;
const MAX_CELL = 48;

type Row = Readonly<Record<string, unknown>>;

function isScalar(value: unknown): boolean {
  return (
    value === null || ['string', 'number', 'boolean'].includes(typeof value)
  );
}

function cell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : isScalar(value)
          ? JSON.stringify(value)
          : Array.isArray(value)
            ? `${value.length} items`
            : JSON.stringify(value);
  return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL - 1)}…` : text;
}

function table(rows: readonly Row[]): string {
  const columns = [
    ...new Set(
      rows.flatMap((row) =>
        Object.keys(row).filter((key) => isScalar(row[key])),
      ),
    ),
  ].slice(0, MAX_COLUMNS);
  if (columns.length === 0) return `${rows.length} items\n`;
  const cells = rows.map((row) => columns.map((column) => cell(row[column])));
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...cells.map((line) => line[index]?.length ?? 0)),
  );
  const line = (values: readonly string[]) =>
    values
      .map((value, index) => value.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();
  return `${[line(columns), ...cells.map(line)].join('\n')}\n`;
}

/** A person's view of a tool's data: its list as a table, else its fields. */
export function render(data: unknown): string {
  if (Array.isArray(data)) return table(data as Row[]);
  if (typeof data !== 'object' || data === null) return `${cell(data)}\n`;
  const record = data as Row;
  if (Array.isArray(record.items)) {
    const more =
      typeof record.nextCursor === 'string'
        ? `More: --cursor ${record.nextCursor}\n`
        : '';
    return `${table(record.items as Row[])}${more}`;
  }
  const width = Math.max(...Object.keys(record).map((key) => key.length));
  return `${Object.entries(record)
    .map(([key, value]) => `${key.padEnd(width)}  ${cell(value)}`)
    .join('\n')}\n`;
}
