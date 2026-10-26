import mysql, { type Connection, type ConnectionOptions } from 'mysql2';
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
  constructor(
    private readonly conn: Connection,
    private readonly options: ConnectionOptions,
  ) {}

  async execute(sql: string): Promise<QueryCursor> {
    const query = this.conn.query({ sql, rowsAsArray: true });
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
  return {
    host: cfg.host ?? 'localhost',
    port: cfg.port ?? 3306,
    database: cfg.database,
    user: cfg.user,
    password: opts.password,
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
  defaultSchema: (cfg) => cfg.database,

  async connect(cfg, opts) {
    const options = mysqlOptions(cfg, opts);
    const conn = await connect(options);
    if (cfg.readOnly) await run(conn, 'SET SESSION TRANSACTION READ ONLY');
    return new MySqlSession(conn, options);
  },

  introspect(session) {
    return introspectInfoSchema(
      session,
      `table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')`,
    );
  },
};
