import { Client, TypeOverrides, type ClientConfig } from 'pg';
import Cursor from 'pg-cursor';
import { driverOptionValues, resolveTarget, tlsOptions } from './common';
import { BufferedCursor, emptyCursor } from './cursor';
import { introspectInfoSchema } from './infoSchema';
import type { ConnectionConfig, ConnectOptions, Driver, QueryCursor, Session } from './types';

const FIRST_BATCH = 200;

/**
 * 날짜 · 시각 타입은 서버가 보낸 글자 그대로 받는다.
 * node-postgres는 기본으로 date/timestamp를 Node 프로세스의 로컬 시간대 Date로 바꿔서
 * 시간대만큼 밀리고 마이크로초가 사라진다(https://node-postgres.com/features/types).
 * OID와 배열 OID는 PostgreSQL pg_type.dat 기준.
 * 쿼리마다 types를 넘긴다 — pg-cursor는 클라이언트의 types를 쓰지 않는다(pg-cursor/index.js).
 */
export const rawDateTypes = new TypeOverrides();
for (const oid of [1082, 1182, 1083, 1183, 1114, 1115, 1184, 1185, 1186, 1187, 1266, 1270]) {
  rawDateTypes.setTypeParser(oid, 'text', (v: string) => v);
}

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
    types: rawDateTypes,
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
    const cursor = this.client.query(new Cursor(sql, params?.length ? [...params] : undefined, { rowMode: 'array', types: rawDateTypes }));
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
  },

  introspect(session, cfg) {
    // Show internal system schemas를 켜면 pg_catalog · information_schema · pg_toast도 읽는다
    const filter = cfg.showSystemSchemas
      ? `table_schema NOT LIKE 'pg\\_temp%'`
      : `table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg\\_toast%' AND table_schema NOT LIKE 'pg\\_temp%'`;
    return introspectInfoSchema(session, filter, cfg, (s) => /^(pg_catalog|information_schema|pg_toast.*)$/.test(s));
  },
};
