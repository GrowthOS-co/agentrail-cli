import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

/** One thing the fake's token endpoint answers a device-code poll with. */
export type DeviceAnswer = { error: string } | 'tokens';

/**
 * A stand-in for an Agentrail environment over real HTTP: the MCP server's
 * protected-resource metadata, an authorization server with device and token
 * endpoints, and an MCP server with a few tools that accepts only the tokens
 * this fake issued. It records what the CLI sent.
 */
export interface FakeAgentrail {
  readonly mcpUrl: string;
  readonly deviceRequests: URLSearchParams[];
  readonly tokenRequests: URLSearchParams[];
  readonly toolCalls: { name: string; input: Record<string, unknown> }[];
  /** What the next device-code polls are answered with, in order. */
  readonly deviceAnswers: DeviceAnswer[];
  /** Access tokens the MCP server accepts, and refresh tokens still good. */
  readonly accessTokens: Set<string>;
  readonly refreshTokens: Set<string>;
  close(): Promise<void>;
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function agentrailServer(calls: FakeAgentrail['toolCalls']): McpServer {
  const server = new McpServer({ name: 'fake-agentrail', version: '0.0.0' });
  const record = (name: string, input: Record<string, unknown>) => {
    calls.push({ name, input });
  };
  const reply = (summary: string, data: Record<string, unknown>) => ({
    content: [
      { type: 'text' as const, text: `${summary}\n\n${JSON.stringify(data)}` },
    ],
    structuredContent: data,
  });
  server.registerTool(
    'workspaces_list',
    {
      title: 'List workspaces',
      description: 'Lists the workspaces.',
      inputSchema: z.object({
        limit: z.number().optional().describe('Items per page.'),
        cursor: z.string().optional().describe('Next page.'),
      }),
      annotations: { readOnlyHint: true },
    },
    (input) => {
      record('workspaces_list', input);
      return reply('1 workspace in Acme.', {
        items: [{ id: 'ws-acme', name: 'Acme' }],
        nextCursor: null,
        defaultWorkspaceId: 'ws-acme',
      });
    },
  );
  server.registerTool(
    'competitors_list',
    {
      title: 'List competitors',
      description: 'Lists the competitors the workspace tracks.',
      inputSchema: z.object({
        workspaceId: z.string().optional().describe('Workspace to use.'),
        limit: z.number().int().optional().describe('Items per page.'),
        needsAttention: z.boolean().optional().describe('Only flagged ones.'),
      }),
      annotations: { readOnlyHint: true },
    },
    (input) => {
      record('competitors_list', input);
      return reply('1 competitor.', {
        items: [{ id: 'c-1', name: 'Rival', aliases: [] }],
        nextCursor: null,
      });
    },
  );
  server.registerTool(
    'competitors_create',
    {
      title: 'Add a competitor',
      description: 'Adds a competitor.',
      inputSchema: z.object({
        workspaceId: z.string().optional().describe('Workspace to use.'),
        name: z.string().describe("The competitor's name."),
        aliases: z.array(z.string()).optional().describe('Other names.'),
      }),
    },
    (input) => {
      record('competitors_create', input);
      if (input.name === 'Taken') {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'Rival Taken exists.' }],
        };
      }
      return reply('Added competitor c-2.', { id: 'c-2', name: input.name });
    },
  );
  return server;
}

export async function startFakeAgentrail(): Promise<FakeAgentrail> {
  let issued = 0;
  const fake = {
    deviceRequests: [] as URLSearchParams[],
    tokenRequests: [] as URLSearchParams[],
    toolCalls: [] as FakeAgentrail['toolCalls'],
    deviceAnswers: [] as DeviceAnswer[],
    accessTokens: new Set<string>(),
    refreshTokens: new Set<string>(),
  };
  const issue = () => {
    issued += 1;
    const accessToken = `access-${String(issued)}`;
    const refreshToken = `refresh-${String(issued)}`;
    fake.accessTokens.add(accessToken);
    fake.refreshTokens.add(refreshToken);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 3600,
    };
  };
  const mcp = createMcpHandler(() => agentrailServer(fake.toolCalls), {
    legacy: 'stateless',
    responseMode: 'json',
  });

  const http = createServer((request, response) => {
    void (async () => {
      const origin = `http://${String(request.headers.host)}`;
      const path = request.url ?? '/';
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (path === '/.well-known/oauth-protected-resource/mcp') {
        json(200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        });
      } else if (path === '/.well-known/oauth-authorization-server') {
        json(200, {
          issuer: origin,
          device_authorization_endpoint: `${origin}/oauth2/device_authorization`,
          token_endpoint: `${origin}/oauth2/token`,
        });
      } else if (path === '/oauth2/device_authorization') {
        fake.deviceRequests.push(new URLSearchParams(await bodyOf(request)));
        json(200, {
          device_code: 'device-1',
          user_code: 'ABCD-EFGH',
          verification_uri: `${origin}/device`,
          verification_uri_complete: `${origin}/device?code=ABCD-EFGH`,
          expires_in: 300,
          interval: 5,
        });
      } else if (path === '/oauth2/token') {
        const form = new URLSearchParams(await bodyOf(request));
        fake.tokenRequests.push(form);
        if (form.get('grant_type') === 'refresh_token') {
          const presented = form.get('refresh_token') ?? '';
          if (!fake.refreshTokens.delete(presented)) {
            json(400, { error: 'invalid_grant' });
            return;
          }
          json(200, issue());
          return;
        }
        const answer = fake.deviceAnswers.shift() ?? { error: 'expired_token' };
        if (answer === 'tokens') json(200, issue());
        else json(400, answer);
      } else if (path === '/mcp') {
        const token = /^Bearer (.+)$/u.exec(
          request.headers.authorization ?? '',
        )?.[1];
        if (token === undefined || !fake.accessTokens.has(token)) {
          json(401, { error: 'invalid_token' });
          return;
        }
        const body = await bodyOf(request);
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === 'string') headers.set(name, value);
        }
        const answer = await mcp.fetch(
          new Request(`${origin}/mcp`, {
            method: request.method ?? 'POST',
            headers,
            ...(body ? { body } : {}),
          }),
          body ? { parsedBody: JSON.parse(body) as unknown } : {},
        );
        response.writeHead(answer.status, Object.fromEntries(answer.headers));
        response.end(await answer.text());
      } else {
        json(404, { error: 'not_found' });
      }
    })();
  });
  await new Promise<void>((resolve) => {
    http.listen(0, '127.0.0.1', resolve);
  });
  const { port } = http.address() as AddressInfo;
  return {
    ...fake,
    mcpUrl: `http://127.0.0.1:${String(port)}/mcp`,
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => {
          resolve();
        });
      }),
  };
}
