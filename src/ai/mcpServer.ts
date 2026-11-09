import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ConnectionStore } from '../core/connections';
import type { SessionManager } from '../core/sessions';
import { drivers, type ConnectionConfig, type MetaTable } from '../drivers';

/*
 * BindB MCP 서버. AI 에이전트(Copilot 에이전트 모드 · Claude Code · Codex 등)가 BindB의 연결로
 * 스키마를 읽고 조회를 실행하게 한다.
 *  - 전송: Streamable HTTP, 127.0.0.1에서만, Bearer 토큰 필수
 *  - 비밀번호 · 접속 문자열은 내보내지 않는다. 연결은 이름으로만 가리킨다
 *  - 조회는 읽기 전용 트랜잭션(SessionManager.readOnlyQuery), 행 수 · 셀 길이 상한
 *  - 쓰기 도구(execute_statement)는 설정 bindb.ai.allowWrites를 켜고, 연결이 읽기 전용이 아닐 때만
 * MCP 명세: 도구 입력 검사, 접근 제어, 출력 정리는 서버 몫이다.
 */

export interface McpOptions {
  allowWrites: () => boolean;
  /** 쓰기 도구를 실행하기 전 사용자 확인(VS Code 창) */
  confirmWrite: (connection: string, sql: string) => Promise<boolean>;
}

const MAX_ROWS = 1000;
const DEFAULT_ROWS = 100;
const MAX_CELL = 500;

function cell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `<binary ${v.byteLength} bytes>`;
  if (typeof v === 'object') v = JSON.stringify(v);
  if (typeof v === 'string' && v.length > MAX_CELL) return `${v.slice(0, MAX_CELL)}… (${v.length} chars)`;
  return v;
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ ...text(message), isError: true });

/** 연결 하나를 AI에 보여 줄 모양(비밀 값 없음) */
function describeConnection(c: ConnectionConfig) {
  return {
    name: c.name,
    driver: drivers[c.driver].label,
    kind: c.kind === 'ddl' ? 'ddl (SQL files)' : 'database',
    database: c.database ?? (c.file ? c.file.split(/[\\/]/).pop() : undefined),
    readOnly: !!c.readOnly,
    comment: c.comment,
  };
}

export function schemaMarkdown(cfg: ConnectionConfig, tables: MetaTable[]): string {
  const lines = [`# ${cfg.name} (${drivers[cfg.driver].label})`, ''];
  const bySchema = new Map<string, MetaTable[]>();
  for (const t of tables) bySchema.set(t.schema, [...(bySchema.get(t.schema) ?? []), t]);
  for (const [schema, list] of bySchema) {
    lines.push(`## ${schema}`, '');
    for (const t of list) {
      const cols = t.columns.map((c) => `${c.name}${c.type ? ` ${c.type}` : ''}`).join(', ');
      lines.push(`- ${t.kind === 'view' ? 'view' : 'table'} **${t.name}**(${cols})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** 요청마다 새로 만드는 MCP 서버(무상태) */
function buildServer(store: ConnectionStore, sessions: SessionManager, opts: McpOptions): McpServer {
  const server = new McpServer({ name: 'bindb', version: '0.2.0' });
  const find = (name: string) => store.findByName(name);
  const names = () => store.list().map((c) => c.name).join(', ') || '(none)';

  server.registerTool(
    'list_connections',
    {
      title: 'List database connections',
      description: 'Lists the database connections configured in BindB (names, driver, database, read-only flag). Use a name from here in the other tools.',
      annotations: { readOnlyHint: true },
    },
    async () => text(store.list().map(describeConnection)),
  );

  server.registerTool(
    'get_schema',
    {
      title: 'Get database schema',
      description: 'Returns the tables, views and columns of a BindB connection as Markdown. Optionally limited to one schema or table.',
      inputSchema: { connection: z.string().describe('Connection name from list_connections'), schema: z.string().optional(), table: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ connection, schema, table }) => {
      const cfg = find(connection);
      if (!cfg) return fail(`No connection named "${connection}". Available: ${names()}`);
      try {
        let tables = await sessions.metadata(cfg);
        if (schema) tables = tables.filter((t) => t.schema.toLowerCase() === schema.toLowerCase());
        if (table) tables = tables.filter((t) => t.name.toLowerCase() === table.toLowerCase());
        return text(schemaMarkdown(cfg, tables));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'run_query',
    {
      title: 'Run a read-only query',
      description: `Runs one SQL query on a BindB connection inside a read-only transaction that is always rolled back, and returns up to "limit" rows (default ${DEFAULT_ROWS}, max ${MAX_ROWS}). Long values are truncated. Statements that change data fail.`,
      inputSchema: {
        connection: z.string(),
        sql: z.string().describe('A single SQL statement'),
        limit: z.number().int().min(1).max(MAX_ROWS).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ connection, sql, limit }) => {
      const cfg = find(connection);
      if (!cfg) return fail(`No connection named "${connection}". Available: ${names()}`);
      try {
        const r = await sessions.readOnlyQuery(cfg, sql.trim().replace(/;\s*$/, ''), limit ?? DEFAULT_ROWS);
        return text({ columns: r.columns, rows: r.rows.map((row) => row.map(cell)), rowCount: r.rows.length, truncated: r.truncated });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'explain_query',
    {
      title: 'Explain a query plan',
      description: 'Returns the database execution plan for a query (EXPLAIN) without running it.',
      inputSchema: { connection: z.string(), sql: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ connection, sql }) => {
      const cfg = find(connection);
      if (!cfg) return fail(`No connection named "${connection}". Available: ${names()}`);
      const prefix = cfg.driver === 'sqlite' ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN ';
      try {
        const r = await sessions.readOnlyQuery(cfg, prefix + sql.trim().replace(/;\s*$/, ''), MAX_ROWS);
        return text(r.rows.map((row) => row.map(cell).join(' | ')).join('\n'));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'execute_statement',
    {
      title: 'Execute a statement that changes data or schema',
      description:
        'Executes one SQL statement that may change data or schema (INSERT/UPDATE/DELETE/DDL) and commits it. Only available when the user has enabled "bindb.ai.allowWrites" and the connection is not read-only; the user is asked to confirm each statement in VS Code.',
      inputSchema: { connection: z.string(), sql: z.string() },
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    async ({ connection, sql }) => {
      const cfg = find(connection);
      if (!cfg) return fail(`No connection named "${connection}". Available: ${names()}`);
      if (!opts.allowWrites()) return fail('Writes from AI tools are disabled. The user can enable the setting "bindb.ai.allowWrites".');
      if (cfg.readOnly) return fail(`${cfg.name} is read-only.`);
      if (!(await opts.confirmWrite(cfg.name, sql))) return fail('The user declined this statement.');
      try {
        const cursor = await sessions.execute(cfg, sql.trim().replace(/;\s*$/, ''), { client: 'ai' });
        const affected = cursor.affectedRows;
        await cursor.close();
        return text({ ok: true, affectedRows: affected ?? null });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return server;
}

/** 로컬 HTTP MCP 서버. start/stop은 여러 번 불러도 된다 */
export class BindbMcpServer {
  private http?: Server;
  private listening?: Promise<number>;

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly opts: McpOptions,
    private readonly token: () => Promise<string>,
  ) {}

  get running(): boolean {
    return !!this.http?.listening;
  }

  start(port: number): Promise<number> {
    if (this.listening) return this.listening;
    const attempt = (async () => {
      const token = await this.token();
      const expected = Buffer.from(`Bearer ${token}`);
      const http = createServer((req, res) => void this.handle(req, res, expected));
      this.http = http;
      return new Promise<number>((resolve, reject) => {
        http.once('error', (e) => {
          this.listening = undefined;
          this.http = undefined;
          reject(e);
        });
        http.listen(port, '127.0.0.1', () => resolve((http.address() as { port: number }).port));
      });
    })();
    this.listening = attempt;
    // 어디서 실패하든(토큰 · 포트) 다음 start가 다시 시도할 수 있게 비운다
    attempt.catch(() => {
      if (this.listening === attempt) this.listening = undefined;
    });
    return attempt;
  }

  async stop(): Promise<void> {
    const http = this.http;
    this.http = undefined;
    this.listening = undefined;
    if (http) await new Promise<void>((r) => http.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse, expected: Buffer): Promise<void> {
    if (!isLocalRequest(req.headers.host, req.headers.origin, req.socket.localPort ?? 0)) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'forbidden origin' }));
      return;
    }
    const auth = Buffer.from(String(req.headers.authorization ?? ''));
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    // 무상태: 요청마다 서버 · 전송을 새로 만든다
    const server = buildServer(this.store, this.sessions, this.opts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    }
  }
}

/**
 * Streamable HTTP 서버는 Origin을 확인해야 한다(MCP 명세 2025-06-18 basic/transports, MUST):
 * 브라우저 페이지가 자기 도메인을 127.0.0.1로 돌려(DNS 리바인딩) 이 서버에 요청할 수 있다.
 *  - Host: 이 포트의 127.0.0.1 · localhost만
 *  - Origin: 없거나(CLI · 확장 클라이언트는 보내지 않는다) 같은 로컬 주소만
 */
export function isLocalRequest(host: string | undefined, origin: string | undefined, port: number): boolean {
  const local = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!host || !local.includes(host.toLowerCase())) return false;
  return origin === undefined || local.some((h) => origin.toLowerCase() === `http://${h}`);
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}
