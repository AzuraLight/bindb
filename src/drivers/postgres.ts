import { Client, type ClientConfig } from 'pg';
import Cursor from 'pg-cursor';
import { BufferedCursor, emptyCursor } from './cursor';
import { introspectInfoSchema } from './infoSchema';
import type { ConnectionConfig, ConnectOptions, Driver, QueryCursor, Session } from './types';

const FIRST_BATCH = 200;

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

export function pgClientConfig(cfg: ConnectionConfig, opts: ConnectOptions): ClientConfig {
  return {
    host: cfg.host ?? 'localhost',
    port: cfg.port ?? 5432,
    database: cfg.database,
    user: cfg.user,
    password: opts.password,
  };
}

class PgSession implements Session {
  constructor(
    private readonly client: Client,
    private readonly clientConfig: ClientConfig,
  ) {}

  async execute(sql: string): Promise<QueryCursor> {
    const cursor = this.client.query(new Cursor(sql, undefined, { rowMode: 'array' }));
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
    if (cfg.readOnly) await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    return new PgSession(client, clientConfig);
  },

  introspect(session) {
    return introspectInfoSchema(
      session,
      `table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg\\_toast%' AND table_schema NOT LIKE 'pg\\_temp%'`,
    );
  },
};
