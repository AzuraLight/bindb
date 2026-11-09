import { Client, TypeOverrides, type ClientConfig } from 'pg';
import Cursor from 'pg-cursor';
import { connect } from 'node:net';
import { tokenize } from '../language/tokenizer';
import { driverOptionValues, isSslUnsupported, resolveTarget, tlsOptions } from './common';
import { BufferedCursor, emptyCursor, queryAll } from './cursor';
import { introspectInfoSchema } from './infoSchema';
import { levelsBySchema, loadsSources, type IntrospectionLevel } from './introspection';
import type { ConnectionConfig, ConnectOptions, Driver, MetaTable, QueryCursor, Session } from './types';

const FIRST_BATCH = 200;

/**
 * 값은 서버가 보낸 글자 그대로 받고, 아래 타입만 JS 값으로 바꾼다.
 * node-postgres의 기본 변환은 그리드 · 복사 · 내보내기 · 편집에서 값을 바꿔 버린다:
 *  - date/timestamp: Node 프로세스의 로컬 시간대 Date가 되어 시간대만큼 밀리고 마이크로초가 사라진다
 *    (https://node-postgres.com/features/types)
 *  - 배열 · point · circle: JS 배열 · 객체가 되어 JSON으로 보인다. `{a,b}` 대신 `["a","b"]`라서
 *    그 셀을 고쳐 저장하면 malformed array literal로 실패한다
 * 바꾸는 타입(OID는 PostgreSQL pg_type.dat 기준): bool 16 · bytea 17 · int2 21 · int4 23 · oid 26 ·
 * float4 700 · float8 701 · json 114 · jsonb 3802. int8 · numeric은 node-postgres도 글자로 준다.
 * 쿼리마다 types를 넘긴다 — pg-cursor는 클라이언트의 types를 쓰지 않는다(pg-cursor/index.js).
 */
const PARSED_OIDS = new Set([16, 17, 21, 23, 26, 700, 701, 114, 3802]);
export const pgTextTypes = new TypeOverrides();
const defaultParser = pgTextTypes.getTypeParser.bind(pgTextTypes);
pgTextTypes.getTypeParser = ((oid: number, format?: 'text' | 'binary') =>
  format === 'binary' || PARSED_OIDS.has(oid) ? defaultParser(oid, format) : (v: string) => v) as typeof pgTextTypes.getTypeParser;

function readCursor(cursor: Cursor, n: number): Promise<{ rows: unknown[][]; result: any }> {
  return new Promise((resolve, reject) => {
    // @types/pg-cursor는 세 번째 인자(result)를 빠뜨린다.
    (cursor.read as any)(n, (err: Error | undefined, rows: unknown[][], result: any) =>
      err ? reject(err) : resolve({ rows, result }),
    );
  });
}

function closeCursor(cursor: Cursor): Promise<void> {
  return new Promise((resolve) => cursor.close(() => resolve()));
}

/**
 * pg 접속 설정. Authentication이 pgpass면 비밀번호 자리에 ~/.pgpass를 읽는 함수를 넣는다
 * (pg 자체의 pgpass 지원은 pg@9에서 빠진다고 안내하며, 이 방식을 권한다).
 */
export function pgClientConfig(cfg: ConnectionConfig, opts: ConnectOptions): ClientConfig {
  const { cfg: t, password } = resolveTarget(cfg, opts);
  const host = t.host ?? 'localhost';
  const port = t.port ?? 5432;
  return {
    ...driverOptionValues(cfg),
    host,
    port,
    database: t.database,
    user: t.user,
    // 터널을 거치면 pgpass는 실제 호스트 · 포트로 찾는다
    password:
      cfg.auth === 'pgpass'
        ? () => readPgpass({ host: opts.realTarget?.host ?? host, port: opts.realTarget?.port ?? port, database: t.database, user: t.user })
        : password,
    connectionTimeoutMillis: (cfg.connectTimeout ?? 10) * 1000,
    types: pgTextTypes,
    ssl: tlsOptions(t, opts) ?? false,
  };
}

function readPgpass(info: { host: string; port: number; database?: string; user?: string }): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pgpass = require('pgpass') as (conn: object, cb: (pass?: string) => void) => void;
  return new Promise((resolve, reject) =>
    pgpass(info, (pass) => (pass === undefined ? reject(new Error('No matching entry in ~/.pgpass.')) : resolve(pass))),
  );
}

/**
 * COPY … FROM STDIN / TO STDOUT는 COPY 하위 프로토콜로 데이터를 주고받는다. pg-cursor는 이를 처리하지 못해
 * pg 안에서 잡히지 않는 예외(handleCopyData is not a function)가 나고 그 연결은 끝나지 않는다.
 * 보내기 전에 막는다. 서버 파일로 쓰는 COPY … TO '경로'는 일반 응답이라 그대로 둔다.
 */
export function usesCopyProtocol(sql: string): boolean {
  const words = tokenize(sql, 'postgres')
    .filter((t) => t.type === 'word')
    .map((t) => t.text.toUpperCase());
  return words[0] === 'COPY' && (words.includes('STDIN') || words.includes('STDOUT'));
}

/**
 * CancelRequest: Int32 16 · Int32 80877102 · Int32 프로세스 id · Int32 비밀 키를 보내고 서버가 연결을 닫는다(응답 없음).
 * https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-CANCELING-REQUESTS
 * SSH 터널을 거치면 host · port는 터널의 로컬 끝이다(같은 서버로 간다).
 */
export function sendCancelRequest(host: string, port: number, pid: number, key: number): Promise<void> {
  const packet = Buffer.alloc(16);
  packet.writeInt32BE(16, 0);
  packet.writeInt32BE(80877102, 4);
  packet.writeInt32BE(pid, 8);
  packet.writeInt32BE(key, 12);
  return new Promise((resolve, reject) => {
    const socket = host.startsWith('/') ? connect(`${host}/.s.PGSQL.${port}`) : connect(port, host);
    socket.setTimeout(5000, () => socket.destroy(new Error('Timed out sending the cancel request.')));
    socket.once('connect', () => socket.end(packet));
    socket.once('error', reject);
    socket.once('close', (hadError) => (hadError ? undefined : resolve()));
  });
}

/**
 * 머티리얼라이즈드 뷰는 SQL 표준이 아니라 information_schema에 나오지 않는다.
 * pg_matviews · pg_attribute에서 읽어 뷰로 더한다(읽기 전용, 정의는 Load sources for를 따른다).
 * https://www.postgresql.org/docs/current/view-pg-matviews.html
 */
async function materializedViews(
  session: Session,
  filter: string,
  cfg: ConnectionConfig,
  isSystem: (s: string) => boolean,
  /** 같은 스키마의 테이블이 받은 수준(머티리얼라이즈드 뷰도 그 수준을 따른다) */
  known: Map<string, IntrospectionLevel>,
): Promise<MetaTable[]> {
  let views: unknown[][];
  try {
    views = await queryAll(
      session,
      `SELECT table_schema, table_name, definition FROM (
         SELECT schemaname AS table_schema, matviewname AS table_name, definition FROM pg_catalog.pg_matviews) m
       WHERE ${filter} ORDER BY table_schema, table_name`,
    );
  } catch {
    return [];
  }
  if (!views.length) return [];
  const own = levelsBySchema(cfg, views.map(([s]) => String(s)), 'public', isSystem);
  const levelOf = (schema: string) => known.get(schema) ?? own.get(schema) ?? 3;
  // 열 이름은 1단계에서도 읽는다. 타입은 2단계부터
  const columns = await queryAll(
    session,
    `SELECT table_schema, table_name, column_name, data_type FROM (
       SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, a.attnum
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
        WHERE c.relkind = 'm' AND a.attnum > 0 AND NOT a.attisdropped) m
     WHERE ${filter} ORDER BY table_schema, table_name, attnum`,
  );
  const byKey = new Map<string, MetaTable>();
  for (const [schema, name, def] of views) {
    const level = levelOf(String(schema));
    byKey.set(`${schema}\u0000${name}`, {
      schema: String(schema),
      name: String(name),
      kind: 'view',
      columns: [],
      level,
      ...(loadsSources(cfg, level, isSystem(String(schema))) && def != null ? { definition: String(def) } : {}),
    });
  }
  for (const [schema, table, name, type] of columns) {
    const t = byKey.get(`${schema}\u0000${table}`);
    t?.columns.push({ name: String(name), type: t.level === 1 || type == null ? undefined : String(type) });
  }
  return [...byKey.values()];
}

async function connectPg(cfg: ConnectionConfig, opts: ConnectOptions): Promise<Session> {
  const clientConfig = pgClientConfig(cfg, opts);
  const client = new Client(clientConfig);
  await client.connect();
  try {
    if (cfg.readOnly) await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  } catch (e) {
    await client.end().catch(() => {});
    throw e;
  }
  return new PgSession(client, clientConfig);
}

class PgSession implements Session {
  private lostListeners: ((e: Error) => void)[] = [];
  constructor(
    private readonly client: Client,
    private readonly clientConfig: ClientConfig,
  ) {
    // 'error'를 받는 곳이 없으면 서버가 연결을 끊을 때 확장 호스트에서 잡히지 않는 예외가 된다
    client.on('error', (e) => this.lostListeners.forEach((l) => l(e)));
    client.on('end', () => this.lostListeners.forEach((l) => l(new Error('The connection was closed.'))));
  }

  onLost(listener: (e: Error) => void): void {
    this.lostListeners.push(listener);
  }

  async execute(sql: string, params?: readonly unknown[]): Promise<QueryCursor> {
    if (usesCopyProtocol(sql)) {
      throw new Error('COPY … FROM STDIN / TO STDOUT is not supported here. Use Export in the result grid, or COPY … TO / FROM a server file.');
    }
    const cursor = this.client.query(new Cursor(sql, params?.length ? [...params] : undefined, { rowMode: 'array', types: pgTextTypes }));
    let first;
    try {
      first = await readCursor(cursor, FIRST_BATCH);
    } catch (e) {
      await closeCursor(cursor);
      throw e;
    }
    const fields: { name: string }[] = first.result?.fields ?? [];
    if (fields.length === 0) {
      await closeCursor(cursor);
      return emptyCursor(first.result?.rowCount ?? undefined);
    }
    return new BufferedCursor(
      fields.map((f) => ({ name: f.name })),
      first.rows,
      first.rows.length < FIRST_BATCH,
      async (n) => (await readCursor(cursor, n)).rows,
      () => closeCursor(cursor),
    );
  }

  async cancel(): Promise<void> {
    const pid = (this.client as any).processID;
    if (!pid) return;
    // 표준 방식: 새 연결로 CancelRequest(16바이트)를 보낸다 — 로그인이 필요 없어서 연결 수 한도 · 권한과
    // 상관없이 된다. 보낼 수조차 없을 때만(소켓 오류) 로그인해서 pg_cancel_backend를 부른다.
    const key = (this.client as any).secretKey;
    if (typeof key === 'number') {
      const sent = await sendCancelRequest(String(this.clientConfig.host ?? 'localhost'), Number(this.clientConfig.port ?? 5432), pid, key).then(
        () => true,
        () => false,
      );
      if (sent) return;
    }
    const killer = new Client(this.clientConfig);
    await killer.connect();
    try {
      await killer.query('SELECT pg_cancel_backend($1)', [pid]);
    } finally {
      await killer.end();
    }
  }

  close(): Promise<void> {
    return this.client.end();
  }
}

export const postgresDriver: Driver = {
  id: 'postgres',
  label: 'PostgreSQL',
  defaultPort: 5432,
  quote: '"',
  defaultSchema: () => 'public',

  async connect(cfg, opts) {
    try {
      return await connectPg(cfg, opts);
    } catch (e) {
      // SSL mode Prefer: 서버가 SSL을 지원하지 않으면 평문으로 다시 붙는다(libpq와 같다)
      const t = resolveTarget(cfg, opts);
      if (t.cfg.ssl !== 'prefer' || !isSslUnsupported(e)) throw e;
      return connectPg({ ...t.cfg, connectionType: 'default', url: undefined, ssl: 'disable' }, { ...opts, password: t.password });
    }
  },

  async introspect(session, cfg) {
    // Show internal system schemas를 켜면 pg_catalog · information_schema · pg_toast도 읽는다
    const filter = cfg.showSystemSchemas
      ? `table_schema NOT LIKE 'pg\\_temp%'`
      : `table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg\\_toast%' AND table_schema NOT LIKE 'pg\\_temp%'`;
    const isSystem = (s: string) => /^(pg_catalog|information_schema|pg_toast.*)$/.test(s);
    const tables = await introspectInfoSchema(session, filter, cfg, isSystem, 'public');
    const known = new Map(tables.map((t) => [t.schema, t.level ?? 3] as const));
    return [...tables, ...(await materializedViews(session, filter, cfg, isSystem, known))];
  },
};
