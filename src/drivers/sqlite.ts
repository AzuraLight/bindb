import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { BufferedCursor, emptyCursor, queryAll } from './cursor';
import type { Driver, MetaTable, QueryCursor, Session } from './types';

let sqlJs: Promise<SqlJsStatic> | undefined;

/** wasm은 빌드 때 out/ 으로 복사된다(esbuild.mjs). 번들 없이 돌 때(테스트)는 node_modules에서 찾는다. */
function loadSqlJs(): Promise<SqlJsStatic> {
  return (sqlJs ??= initSqlJs({
    locateFile: (f) => {
      const bundled = path.join(__dirname, f);
      return existsSync(bundled) ? bundled : require.resolve(`sql.js/dist/${f}`);
    },
  }));
}

/** 이 문장이 파일 내용을 바꾸지 않는다고 확신할 수 있는가 */
function isReadOnlyStatement(sql: string): boolean {
  return /^\s*(select|explain|values)\b/i.test(sql);
}

/**
 * sql.js는 DB 전체를 메모리에 올린다. 쓰기 문장이 끝날 때마다 파일로 내보낸다.
 * 다른 프로세스가 같은 파일을 동시에 고치면 마지막에 쓴 쪽이 이긴다.
 */
class SqliteSession implements Session {
  constructor(
    private readonly db: Database,
    private readonly file: string,
    private readonly readOnly: boolean,
  ) {}

  async execute(sql: string): Promise<QueryCursor> {
    const writes = !isReadOnlyStatement(sql);
    if (writes && this.readOnly) throw new Error('Connection is read-only.');

    const stmt = this.db.prepare(sql);
    const columns = stmt.getColumnNames().map((name) => ({ name }));
    if (columns.length === 0) {
      try {
        stmt.step();
      } finally {
        stmt.free();
      }
      const affected = this.db.getRowsModified();
      if (writes) this.persist();
      return emptyCursor(affected);
    }

    const readMore = async (n: number) => {
      const rows: unknown[][] = [];
      while (rows.length < n && stmt.step()) rows.push(stmt.get());
      return rows;
    };
    return new BufferedCursor(columns, [], false, readMore, async () => {
      stmt.free();
      // INSERT … RETURNING 처럼 결과셋이 있는 쓰기 문장
      if (writes) this.persist();
    });
  }

  async cancel(): Promise<void> {
    // sql.js는 동기 실행이라 취소할 지점이 없다.
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private persist(): void {
    writeFileSync(this.file, this.db.export());
  }
}

export const sqliteDriver: Driver = {
  id: 'sqlite',
  label: 'SQLite',
  quote: '"',
  defaultSchema: () => 'main',

  async connect(cfg) {
    if (!cfg.file) throw new Error('SQLite connection has no file.');
    const SQL = await loadSqlJs();
    const db = existsSync(cfg.file) ? new SQL.Database(readFileSync(cfg.file)) : new SQL.Database();
    return new SqliteSession(db, cfg.file, !!cfg.readOnly);
  },

  async introspect(session) {
    const objects = await queryAll(
      session,
      `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`,
    );
    const out: MetaTable[] = [];
    for (const [name, type] of objects) {
      const cols = await queryAll(
        session,
        `SELECT name, type FROM pragma_table_info('${String(name).replace(/'/g, "''")}')`,
      );
      out.push({
        schema: 'main',
        name: String(name),
        kind: type === 'view' ? 'view' : 'table',
        columns: cols.map(([n, t]) => ({ name: String(n), type: t ? String(t) : undefined })),
      });
    }
    return out;
  },
};
