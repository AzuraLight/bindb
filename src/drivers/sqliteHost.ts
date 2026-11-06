import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { classifySql } from '../core/classify';
import { splitStatements } from '../language/splitter';

/*
 * SQLite 실행 프로세스(자식). 확장 호스트에서 fork로 띄우고 IPC(serialization: 'advanced')로 주고받는다.
 *  - node:sqlite는 동기 API라(https://nodejs.org/api/sqlite.html) 확장 호스트에서 돌리면 쿼리 · 잠금 대기 동안
 *    확장 호스트 전체가 멈춘다. 여기서 돌리면 확장 호스트는 멈추지 않는다.
 *  - node:sqlite에는 sqlite3_interrupt가 없고, worker_threads의 terminate()는 실행 중인 쿼리가 끝날 때까지
 *    돌아오지 않는다(VS Code 1.103 런타임에서 확인). 취소는 이 프로세스를 끝내는 것으로 한다.
 *    도중에 끝나도 SQLite가 다음에 열 때 저널로 되돌린다(https://www.sqlite.org/atomiccommit.html).
 *  - 결과는 이 프로세스에서 끝까지 읽어 둔다(읽기 잠금을 바로 푼다). 확장 호스트에는 요청한 만큼만 보낸다.
 */

export type Request =
  | { id: number; op: 'open'; file: string; readOnly: boolean; timeout: number }
  | { id: number; op: 'execute'; sql: string; params: unknown[] }
  | { id: number; op: 'fetch'; cursor: number; n: number }
  | { id: number; op: 'closeCursor'; cursor: number }
  | { id: number; op: 'close' };

export type Response =
  | { id: number; ok: true; columns?: string[]; affected?: number; cursor?: number; rows?: unknown[][]; done?: boolean; sqliteVersion?: string }
  | { id: number; ok: false; error: string };

/** 정수는 BigInt로 읽고(정밀도 보존), 안전한 범위면 number로 */
function normalize(v: unknown): unknown {
  if (typeof v === 'bigint' && v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
  return v;
}

/**
 * node:sqlite가 묶을 수 있는 값: null · number · bigint · string · TypedArray/DataView.
 * 객체를 첫 값으로 넘기면 이름 있는 매개변수로 해석해 나머지가 밀린다 — 미리 바꾸거나 거부한다.
 */
function bindable(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' || ArrayBuffer.isView(v)) return v;
  throw new Error(`Cannot bind a ${Object.prototype.toString.call(v)} value to an SQLite parameter.`);
}

/** FTS5 등 이 빌드에 없는 모듈을 쓰면 원인을 덧붙인다 */
function message(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return /no such module/i.test(text)
    ? `${text} (the SQLite built into this VS Code — ${process.versions.sqlite ?? 'unknown version'} — does not include this module)`
    : text;
}

/** 결과를 미리 읽어 둘 최대 행 수. 넘으면 나머지는 요청할 때 읽는다 */
export const BUFFER_ROWS = 100_000;

export class SqliteEngine {
  private db?: DatabaseSync;
  private readOnly = false;
  /** 남은 행: 메모리에 읽어 둔 것(rows) + 아직 SQLite에서 읽지 않은 것(rest, 잠금을 잡고 있다) */
  private cursors = new Map<number, { rows: unknown[][]; at: number; rest?: Iterator<unknown> }>();
  private nextCursor = 1;

  open(file: string, readOnly: boolean, timeout: number): void {
    // 읽기 전용은 파일이 없으면 열지 못한다(공식 문서). 그 밖에는 없으면 새로 만든다.
    if (readOnly && !existsSync(file)) throw new Error(`SQLite file not found: ${file} (a read-only connection cannot create it).`);
    this.db = new DatabaseSync(file, { readOnly, timeout });
    this.readOnly = readOnly;
  }

  execute(sql: string, params: unknown[]): { columns: string[]; affected?: number; cursor?: number } {
    const db = this.db;
    if (!db) throw new Error('The SQLite database is not open.');
    // prepare는 첫 문장만 컴파일하고 나머지를 말없이 버린다 — 여러 문장이면 실행하지 않는다(SQLite 문법으로 나눈다)
    if (splitStatements(sql, 'sqlite').filter((s) => s.text.trim()).length > 1) {
      throw new Error('SQLite runs one statement at a time; nothing was executed.');
    }
    const c = classifySql(sql, 'sqlite');
    // 판정은 친절한 오류용. 실제로 막는 것은 읽기 전용으로 연 파일(SQLite가 거부)
    if (c.kind === 'write' && this.readOnly) throw new Error(`Connection is read-only: ${c.reason ?? 'this statement may change data'}.`);

    const stmt = db.prepare(sql);
    stmt.setReturnArrays(true);
    stmt.setReadBigInts(true);
    const args = params.map(bindable) as never[];
    const columns = stmt.columns().map((col) => col.name);
    if (columns.length === 0) {
      const r = stmt.run(...args);
      return { columns, affected: Number(r.changes) };
    }
    // 결과를 바로 읽어 읽기 잠금을 푼다(RETURNING이 있는 쓰기도 여기서 실행된다).
    // 아주 큰 결과는 BUFFER_ROWS까지만 메모리에 두고, 나머지는 요청할 때 SQLite에서 이어 읽는다(그동안 읽기 잠금이 남는다).
    const before = c.kind === 'write' ? this.totalChanges() : 0;
    const iter = stmt.iterate(...args);
    const rows: unknown[][] = [];
    let rest: Iterator<unknown> | undefined;
    for (;;) {
      if (rows.length >= BUFFER_ROWS) {
        rest = iter;
        break;
      }
      const next = iter.next();
      if (next.done) break;
      rows.push((next.value as unknown as unknown[]).map(normalize));
    }
    // total_changes(): 이 연결이 지금까지 바꾼 행 수 — 앞뒤 차이가 이 문장이 바꾼 행 수(https://www.sqlite.org/lang_corefunc.html)
    const affected = c.kind === 'write' && !rest ? this.totalChanges() - before : undefined;
    const cursor = this.nextCursor++;
    this.cursors.set(cursor, { rows, at: 0, rest });
    return { columns, affected, cursor };
  }

  private totalChanges(): number {
    const st = this.db!.prepare('SELECT total_changes()');
    st.setReturnArrays(true);
    return Number((st.get() as unknown as unknown[])[0]);
  }

  fetch(cursor: number, n: number): { rows: unknown[][]; done: boolean } {
    const c = this.cursors.get(cursor);
    if (!c) return { rows: [], done: true };
    const rows = c.rows.slice(c.at, c.at + n);
    c.at += rows.length;
    if (c.at >= c.rows.length) {
      c.rows = [];
      c.at = 0;
    }
    while (rows.length < n && c.rest) {
      const next = c.rest.next();
      if (next.done) c.rest = undefined;
      else rows.push((next.value as unknown as unknown[]).map(normalize));
    }
    const done = c.at >= c.rows.length && !c.rest;
    if (done) this.cursors.delete(cursor);
    return { rows, done };
  }

  closeCursor(cursor: number): void {
    // 다 읽지 않은 문장을 끝내 읽기 잠금을 푼다
    this.cursors.get(cursor)?.rest?.return?.();
    this.cursors.delete(cursor);
  }

  close(): void {
    for (const c of this.cursors.values()) c.rest?.return?.();
    this.cursors.clear();
    if (this.db?.isOpen) this.db.close();
    this.db = undefined;
  }

  handle(req: Request): Response {
    try {
      switch (req.op) {
        case 'open':
          this.open(req.file, req.readOnly, req.timeout);
          return { id: req.id, ok: true, sqliteVersion: process.versions.sqlite };
        case 'execute':
          return { id: req.id, ok: true, ...this.execute(req.sql, req.params) };
        case 'fetch':
          return { id: req.id, ok: true, ...this.fetch(req.cursor, req.n) };
        case 'closeCursor':
          this.closeCursor(req.cursor);
          return { id: req.id, ok: true };
        case 'close':
          this.close();
          return { id: req.id, ok: true };
      }
    } catch (e) {
      return { id: req.id, ok: false, error: message(e) };
    }
  }
}

// 자식 프로세스로 실행됐을 때만 IPC를 연다
if (process.send && process.env.BINDB_SQLITE_HOST === '1') {
  const engine = new SqliteEngine();
  process.on('message', (req: Request) => {
    const res = engine.handle(req);
    process.send!(res);
    if (req.op === 'close') process.disconnect();
  });
  // 확장 호스트가 사라지면 같이 끝난다
  process.on('disconnect', () => {
    engine.close();
    process.exit(0);
  });
}
