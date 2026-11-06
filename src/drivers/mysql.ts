import mysql, { type Connection, type ConnectionOptions } from 'mysql2';
import { driverOptionValues, resolveTarget, tlsOptions } from './common';
import { BufferedCursor, emptyCursor } from './cursor';
import { introspectInfoSchema } from './infoSchema';
import type { ConnectionConfig, ConnectOptions, Driver, QueryCursor, Session } from './types';

const FIRST_BATCH = 200;

function connect(options: ConnectionOptions): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const conn = mysql.createConnection(options);
    conn.connect((err) => (err ? reject(err) : resolve(conn)));
  });
}

function run(conn: Connection, sql: string): Promise<void> {
  return new Promise((resolve, reject) => conn.query(sql, (err) => (err ? reject(err) : resolve())));
}

class MySqlSession implements Session {
  private lostListeners: ((e: Error) => void)[] = [];
  constructor(
    private readonly conn: Connection,
    private readonly options: ConnectionOptions,
  ) {
    conn.on('error', (e: Error) => this.lostListeners.forEach((l) => l(e)));
    conn.on('end', () => this.lostListeners.forEach((l) => l(new Error('The connection was closed.'))));
  }

  onLost(listener: (e: Error) => void): void {
    this.lostListeners.push(listener);
  }

  async execute(sql: string, params?: readonly unknown[]): Promise<QueryCursor> {
    const query = this.conn.query({ sql, rowsAsArray: true, ...(params?.length ? { values: [...params] } : {}) });
    let fields: { name: string; type?: number }[] | undefined;
    query.on('fields', (f: any[]) => (fields = f));
    const iter = query.stream({ highWaterMark: FIRST_BATCH })[Symbol.asyncIterator]();

    const first = await iter.next();
    if (!fields) {
      // SELECT가 아닌 문장: 스트림의 유일한 값이 ResultSetHeader다.
      await drain(iter);
      return emptyCursor(first.done ? undefined : (first.value as any)?.affectedRows);
    }

    let finished = !!first.done;
    const readMore = async (n: number) => {
      const rows: unknown[][] = [];
      while (rows.length < n && !finished) {
        const r = await iter.next();
        if (r.done) finished = true;
        else rows.push(r.value);
      }
      return rows;
    };
    const onClose = async () => {
      if (finished) return;
      // 중간에 닫으면 서버 쪽 쿼리를 죽이고 남은 스트림을 비워야 연결을 다시 쓸 수 있다.
      await this.cancel().catch(() => {});
      await drain(iter);
      finished = true;
    };
    return new BufferedCursor(
      fields.map((f) => ({ name: f.name })),
      first.done ? [] : [first.value],
      finished,
      readMore,
      onClose,
    );
  }

  async cancel(): Promise<void> {
    const killer = await connect(this.options);
    try {
      await run(killer, `KILL QUERY ${this.conn.threadId}`);
    } finally {
      killer.destroy();
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.conn.end(() => resolve()));
  }
}

async function drain(iter: AsyncIterator<unknown>): Promise<void> {
  try {
    while (!(await iter.next()).done);
  } catch {
    // 취소된 쿼리는 에러로 끝난다.
  }
}

function mysqlOptions(cfg: ConnectionConfig, opts: ConnectOptions): ConnectionOptions {
  const { cfg: t, password } = resolveTarget(cfg, opts);
  return {
    ...(driverOptionValues(cfg) as ConnectionOptions),
    host: t.host ?? 'localhost',
    port: t.port ?? 3306,
    database: t.database,
    user: t.user,
    password,
    connectTimeout: (cfg.connectTimeout ?? 10) * 1000,
    // mysql2는 verifyIdentity를 켜지 않으면 서버 인증서의 호스트 이름을 검사하지 않는다. Verify full이면 켠다.
    ssl: (() => {
      const tls = tlsOptions(t, opts);
      if (!tls) return undefined;
      // 터널을 거치면 mysql2의 호스트 이름 확인이 127.0.0.1로 하게 된다 — 실제 호스트 이름으로 확인한다
      if (opts.realTarget && t.ssl === 'verify') {
        const { checkServerIdentity } = require('node:tls') as typeof import('node:tls');
        const real = opts.realTarget.host;
        return { ...tls, verifyIdentity: false, checkServerIdentity: (_h: string, cert: import('node:tls').PeerCertificate) => checkServerIdentity(real, cert) } as ConnectionOptions['ssl'];
      }
      return { ...tls, verifyIdentity: t.ssl === 'verify' } as ConnectionOptions['ssl'];
    })(),
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  };
}

export const mysqlDriver: Driver = {
  id: 'mysql',
  label: 'MySQL / MariaDB',
  defaultPort: 3306,
  quote: '`',
  defaultSchema: (cfg) => (cfg.connectionType === 'url' ? resolveTarget(cfg, {}).cfg.database : cfg.database),

  async connect(cfg, opts) {
    const options = mysqlOptions(cfg, opts);
    const conn = await connect(options);
    try {
      if (cfg.readOnly) await run(conn, 'SET SESSION TRANSACTION READ ONLY');
    } catch (e) {
      conn.destroy();
      throw e;
    }
    return new MySqlSession(conn, options);
  },

  introspect(session, cfg) {
    const system = `table_schema IN ('mysql', 'information_schema', 'performance_schema', 'sys')`;
    const parts: string[] = [];
    if (!cfg.showSystemSchemas) parts.push(`NOT ${system}`);
    // Single database mode: 연결 설정의 데이터베이스만
    const db = cfg.singleDatabase ? mysqlDriver.defaultSchema(cfg) : undefined;
    if (db) parts.push(`table_schema = '${db.replace(/'/g, "''")}'`);
    return introspectInfoSchema(session, parts.join(' AND ') || '1 = 1', cfg, (s) =>
      /^(mysql|information_schema|performance_schema|sys)$/i.test(s),
    );
  },
};
