import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import { queryAll } from '../src/drivers/cursor';
import { sqliteDriver } from '../src/drivers/sqlite';
import type { ConnectionConfig } from '../src/drivers/types';
import { readViewSource, viewDdlText, viewMigration, viewSourceFromRows } from '../src/core/viewSource';

const dir = mkdtempSync(path.join(tmpdir(), 'bindb-sqlite-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const cfg = (file: string): ConnectionConfig => ({ id: 'x', name: 'x', driver: 'sqlite', file });

async function exec(file: string, sql: string) {
  const s = await sqliteDriver.connect(cfg(file), {});
  await (await s.execute(sql)).close();
  await s.close();
}

describe('sqlite view DDL', () => {
  type SqliteSession = Awaited<ReturnType<typeof sqliteDriver.connect>>;
  /** 이 세션에서 뷰 정의를 읽는다(편집기와 같은 조회) */
  const readView = (s: SqliteSession, v: { schema: string; name: string }) => readViewSource('sqlite', v, (q) => queryAll(s, q.sql, q.params));
  /** 마이그레이션을 한 트랜잭션으로 실행한다(UI와 같다): 실패하면 ROLLBACK하고 그 오류를 던진다 */
  const submit = async (s: SqliteSession, statements: string[]) => {
    await (await s.execute('BEGIN')).close();
    try {
      for (const sql of statements) await (await s.execute(sql)).close();
      await (await s.execute('COMMIT')).close();
    } catch (e) {
      await (await s.execute('ROLLBACK')).close();
      throw e;
    }
  };

  it('reads the view body and replaces the view with DROP + CREATE in one transaction', async () => {
    const file = path.join(dir, 'views.db');
    await exec(file, 'CREATE TABLE t (id INTEGER, name TEXT)');
    await exec(file, 'CREATE VIEW v AS SELECT id FROM t');
    const s = await sqliteDriver.connect(cfg(file), {});
    const v = { schema: 'main', name: 'v' };
    const read = () => readView(s, v);
    const body = async () => (await read())?.definition;
    assert.equal(await body(), 'SELECT id FROM t');
    const m = viewMigration('sqlite', viewDdlText({ ...(await read())!, definition: 'SELECT id, name FROM t' }), v);
    assert.ok(!('error' in m));
    await submit(s, m.statements);
    assert.equal(await body(), 'SELECT id, name FROM t');
    // CREATE가 실패하면 DROP도 되돌린다(뷰가 사라지지 않는다)
    const bad = viewMigration('sqlite', 'CREATE VIEW v AS SELECT FROM WHERE', v);
    assert.ok(!('error' in bad));
    await (await s.execute('BEGIN')).close();
    await (await s.execute(bad.statements[0])).close();
    await assert.rejects(s.execute(bad.statements[1]));
    await (await s.execute('ROLLBACK')).close();
    assert.equal(await body(), 'SELECT id, name FROM t');
    await s.close();
  });

  // 코드 리뷰에서 찾은 것: 열 목록이 사라지고, DROP VIEW가 INSTEAD OF 트리거를 지웠다
  it('keeps the column list and the INSTEAD OF triggers; Force on a missing view creates it', async () => {
    const file = path.join(dir, 'views2.db');
    await exec(file, 'CREATE TABLE t (id INTEGER, name TEXT)');
    await exec(file, 'CREATE VIEW v(a, b) AS SELECT id, name FROM t');
    await exec(file, 'CREATE TRIGGER v_ins INSTEAD OF INSERT ON v BEGIN INSERT INTO t VALUES (new.a, new.b); END');
    const s = await sqliteDriver.connect(cfg(file), {});
    const v = { schema: 'main', name: 'v' };
    const src = (await readView(s, v))!;
    const edited = viewDdlText(src).replace('FROM t', 'FROM t WHERE id > 0');
    const m = viewMigration('sqlite', edited, v, src.triggers);
    assert.ok(!('error' in m));
    await submit(s, m.statements);
    assert.deepEqual(await queryAll(s, "SELECT name FROM pragma_table_info('v')"), [['a'], ['b']]);
    assert.deepEqual(await queryAll(s, "SELECT name FROM sqlite_master WHERE type = 'trigger'"), [['v_ins']]);
    await (await s.execute("INSERT INTO v VALUES (7, 'x')")).close();
    assert.deepEqual(await queryAll(s, 'SELECT a, b FROM v'), [[7, 'x']]);
    // 뷰가 없어진 뒤의 Force Refactoring: DROP VIEW IF EXISTS라 실패하지 않는다
    await (await s.execute('DROP VIEW v')).close();
    const force = viewMigration('sqlite', edited, v);
    assert.ok(!('error' in force));
    await submit(s, force.statements);
    assert.ok(await readView(s, v));
    await s.close();
  });

  it('several triggers (mixed-case view name, quoted trigger name) come back in order; triggers of other views are left alone', async () => {
    const file = path.join(dir, 'views3.db');
    await exec(file, 'CREATE TABLE t (id INTEGER, name TEXT, log TEXT)');
    await exec(file, 'CREATE VIEW "MyView"(a, b) AS SELECT id, name FROM t');
    await exec(file, 'CREATE VIEW other AS SELECT id FROM t');
    await exec(file, 'CREATE TRIGGER ins INSTEAD OF INSERT ON myview BEGIN INSERT INTO t (id, name) VALUES (new.a, new.b); END');
    await exec(file, 'CREATE TRIGGER "upd trigger" INSTEAD OF UPDATE OF b ON "MyView" BEGIN UPDATE t SET name = new.b WHERE id = old.a; END');
    await exec(file, 'CREATE TRIGGER del INSTEAD OF DELETE ON MYVIEW BEGIN DELETE FROM t WHERE id = old.a; END');
    await exec(file, 'CREATE TRIGGER other_ins INSTEAD OF INSERT ON other BEGIN SELECT 1; END');
    const s = await sqliteDriver.connect(cfg(file), {});
    const v = { schema: 'main', name: 'MyView' };
    const src = (await readView(s, v))!;
    assert.equal(src.triggers.length, 3);
    const m = viewMigration('sqlite', viewDdlText(src).replace('FROM t', 'FROM t WHERE id > 0'), v, src.triggers);
    assert.ok(!('error' in m));
    await submit(s, m.statements);
    assert.deepEqual(await queryAll(s, "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name"), [['del'], ['ins'], ['other_ins'], ['upd trigger']]);
    await (await s.execute("INSERT INTO \"MyView\" VALUES (1, 'x')")).close();
    await (await s.execute("UPDATE \"MyView\" SET b = 'y' WHERE a = 1")).close();
    assert.deepEqual(await queryAll(s, 'SELECT a, b FROM "MyView"'), [[1, 'y']]);
    await (await s.execute('DELETE FROM "MyView"')).close();
    assert.deepEqual(await queryAll(s, 'SELECT count(*) FROM t'), [[0]]);
    await s.close();
  });

  // SQLite는 CREATE TRIGGER 때 new.열을 확인하지 않는다 — 지운 열을 쓰는 트리거도 다시 만들어지고, 쓸 때 실패한다
  it('a trigger that uses a column the edit removes is recreated; it fails only when it fires', async () => {
    const file = path.join(dir, 'views4.db');
    await exec(file, 'CREATE TABLE t (id INTEGER, name TEXT)');
    await exec(file, 'CREATE VIEW v(a, b) AS SELECT id, name FROM t');
    await exec(file, 'CREATE TRIGGER v_ins INSTEAD OF INSERT ON v BEGIN INSERT INTO t VALUES (new.a, new.b); END');
    const s = await sqliteDriver.connect(cfg(file), {});
    const v = { schema: 'main', name: 'v' };
    const src = (await readView(s, v))!;
    const m = viewMigration('sqlite', 'CREATE VIEW v(a) AS SELECT id FROM t', v, src.triggers);
    assert.ok(!('error' in m));
    await submit(s, m.statements);
    assert.deepEqual(await queryAll(s, "SELECT name FROM pragma_table_info('v')"), [['a']]);
    assert.deepEqual(await queryAll(s, "SELECT name FROM sqlite_master WHERE type = 'trigger'"), [['v_ins']]);
    await assert.rejects(s.execute('INSERT INTO v VALUES (1)'), /no such column: new\.b/);
    await s.close();
  });

  it('when a trigger cannot be recreated the transaction rolls back and keeps the old view and triggers', async () => {
    const file = path.join(dir, 'views5.db');
    await exec(file, 'CREATE TABLE t (id INTEGER, name TEXT)');
    await exec(file, 'CREATE VIEW v(a, b) AS SELECT id, name FROM t');
    await exec(file, 'CREATE TRIGGER v_ins INSTEAD OF INSERT ON v BEGIN INSERT INTO t VALUES (new.a, new.b); END');
    await exec(file, 'CREATE TRIGGER v_del INSTEAD OF DELETE ON v BEGIN DELETE FROM t WHERE id = old.a; END');
    const s = await sqliteDriver.connect(cfg(file), {});
    const v = { schema: 'main', name: 'v' };
    const before = (await readView(s, v))!;
    // 두 번째 트리거를 다시 만들 수 없다(그 사이 대상이 바뀐 경우를 흉내 낸다): 첫 트리거 · DROP · CREATE까지 모두 되돌려야 한다
    const m = viewMigration('sqlite', viewDdlText(before).replace('FROM t', 'FROM t WHERE id > 0'), v, [before.triggers[0], 'CREATE TRIGGER v_bad INSTEAD OF INSERT ON gone BEGIN SELECT 1; END']);
    assert.ok(!('error' in m));
    await assert.rejects(submit(s, m.statements), /no such table/);
    const after = (await readView(s, v))!;
    assert.deepEqual([after.header, after.definition, after.triggers], [before.header, before.definition, before.triggers]);
    assert.equal(before.triggers.length, 2);
    await (await s.execute("INSERT INTO v VALUES (5, 'z')")).close();
    assert.deepEqual(await queryAll(s, 'SELECT a, b FROM v'), [[5, 'z']]);
    await s.close();
  });

  it('TEMP view text: SQLite stores CREATE TEMP VIEW without TEMP, and parseViewDdl keeps the column list', async () => {
    const file = path.join(dir, 'views6.db');
    await exec(file, 'CREATE TABLE t (id INTEGER, name TEXT)');
    const s = await sqliteDriver.connect(cfg(file), {});
    // 연결이 닫히면 TEMP 뷰는 사라지므로 이 세션에서 만든다
    await (await s.execute('CREATE TEMP VIEW tv (x, "y z") AS SELECT id, name FROM t')).close();
    const [[text]] = await queryAll(s, "SELECT sql FROM sqlite_temp_master WHERE name = 'tv'");
    const src = viewSourceFromRows('sqlite', { schema: 'main', name: 'tv' }, [text]);
    assert.deepEqual([src.header, src.definition], ['CREATE VIEW tv (x, "y z") AS', 'SELECT id, name FROM t']);
    // 탐색기가 읽는 sqlite_master에는 TEMP 뷰가 없다(편집기도 main 뷰만 연다)
    assert.equal(await readView(s, { schema: 'main', name: 'tv' }), undefined);
    await s.close();
  });
});

describe('sqlite driver', () => {
  it('reads FTS5 tables (the reported "no such module: fts5" bug)', async () => {
    const file = path.join(dir, 'fts.db');
    await exec(file, 'CREATE VIRTUAL TABLE docs USING fts5(title, body)');
    await exec(file, "INSERT INTO docs VALUES ('hello world', 'x')");

    const s = await sqliteDriver.connect(cfg(file), {});
    const meta = await sqliteDriver.introspect(s, cfg(file));
    const docs = meta.find((t) => t.name === 'docs');
    assert.deepEqual(docs?.columns.map((c) => c.name), ['title', 'body']);
    assert.deepEqual(await queryAll(s, "SELECT title FROM docs WHERE docs MATCH 'hello'"), [['hello world']]);
    await s.close();
  });

  it('reads foreign keys: composite, implicit primary key, several between the same tables', async () => {
    const file = path.join(dir, 'fk.db');
    for (const sql of [
      'CREATE TABLE Users (id INTEGER PRIMARY KEY, name TEXT)',
      'CREATE TABLE pairs (a INT, b INT, PRIMARY KEY (b, a))',
      'CREATE TABLE orders (id INT, created_by INT REFERENCES users(id), updated_by INT REFERENCES USERS, pa INT, pb INT, FOREIGN KEY (pb, pa) REFERENCES pairs)',
      'CREATE VIEW v AS SELECT * FROM orders',
    ]) await exec(file, sql);
    const s = await sqliteDriver.connect(cfg(file), {});
    try {
      const meta = await sqliteDriver.introspect(s, cfg(file));
      const fks = (name: string) => meta.find((t) => t.name === name)?.foreignKeys?.map((k) => `${k.columns}->${k.refSchema}.${k.refTable}(${k.refColumns})`).sort();
      assert.deepEqual(fks('orders'), ['created_by->main.Users(id)', 'pb,pa->main.pairs(b,a)', 'updated_by->main.Users(id)']);
      assert.equal(fks('Users'), undefined);
      assert.equal(fks('v'), undefined);
      // 1단계는 열 이름만 — 외래 키도 없다
      const lvl1 = await sqliteDriver.introspect(s, { ...cfg(file), introspectionLevel: 1 } as ConnectionConfig);
      assert.equal(lvl1.find((t) => t.name === 'orders')?.foreignKeys, undefined);
    } finally {
      await s.close();
    }
  });

  it('writes changes back to the file and reports affected rows', async () => {
    const file = path.join(dir, 'rw.db');
    await exec(file, 'CREATE TABLE t(a)');
    const s = await sqliteDriver.connect(cfg(file), {});
    const cur = await s.execute('INSERT INTO t VALUES (1), (2)');
    assert.equal(cur.affectedRows, 2);
    assert.deepEqual(cur.columns, []);
    await cur.close();
    await s.close();

    const again = await sqliteDriver.connect(cfg(file), {});
    assert.deepEqual(await queryAll(again, 'SELECT a FROM t ORDER BY a'), [[1], [2]]);
    await again.close();
  });

  it('works on a WAL database another connection is writing to, without losing its changes', async () => {
    const file = path.join(dir, 'wal.db');
    // 다른 앱 역할: node:sqlite로 따로 연 연결
    const app = new DatabaseSync(file);
    app.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(a); INSERT INTO t VALUES (1)");

    const s = await sqliteDriver.connect(cfg(file), {});
    assert.deepEqual(await queryAll(s, 'SELECT a FROM t'), [[1]]);
    app.exec('INSERT INTO t VALUES (2)');
    await (await s.execute('INSERT INTO t VALUES (3)')).close();
    app.exec('INSERT INTO t VALUES (4)');
    assert.deepEqual(await queryAll(s, 'SELECT a FROM t ORDER BY a'), [[1], [2], [3], [4]]);
    assert.equal(app.prepare('SELECT count(*) AS n FROM t').get()?.n, 4);
    await s.close();
    app.close();
  });

  it('read-only connections are enforced by SQLite itself', async () => {
    const file = path.join(dir, 'ro.db');
    await exec(file, 'CREATE TABLE t(a)');
    const s = await sqliteDriver.connect({ ...cfg(file), readOnly: true }, {});
    // 판정기가 읽기로 보는 PRAGMA 괄호 형태도 SQLite가 막는다
    await assert.rejects(s.execute('PRAGMA user_version(7)'), /readonly|read-only/i);
    assert.deepEqual(await queryAll(s, 'PRAGMA user_version'), [[0]]);
    await s.close();
  });

  it('refuses several statements at once instead of silently running only the first', async () => {
    const file = path.join(dir, 'multi.db');
    await exec(file, 'CREATE TABLE t(a)');
    const s = await sqliteDriver.connect(cfg(file), {});
    await assert.rejects(s.execute('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)'), /one statement/);
    assert.deepEqual(await queryAll(s, 'SELECT count(*) FROM t'), [[0]]);
    await s.close();
  });

  it('keeps large integers exact and returns blobs as bytes', async () => {
    const file = path.join(dir, 'types.db');
    const s = await sqliteDriver.connect(cfg(file), {});
    const [[big, small, blob]] = await queryAll(s, "SELECT 9007199254740993, 42, x'0102'");
    assert.equal(big, 9007199254740993n);
    assert.equal(small, 42);
    assert.deepEqual([...(blob as Uint8Array)], [1, 2]);
    await s.close();
  });

  it('does not keep a read lock after a query, so another app can still write (rollback journal)', async () => {
    const file = path.join(dir, 'lock.db');
    await exec(file, 'CREATE TABLE t(a)');
    await exec(file, 'INSERT INTO t VALUES (1), (2), (3)');
    const s = await sqliteDriver.connect(cfg(file), {});
    const cur = await s.execute('SELECT a FROM t');
    assert.deepEqual((await cur.fetch(1)).rows, [[1]]); // 결과를 다 넘기지 않은 채로 둔다
    const app = new DatabaseSync(file, { timeout: 0 });
    app.exec('INSERT INTO t VALUES (4)'); // 잠겨 있으면 "database is locked"
    app.close();
    await cur.close();
    await s.close();
  });

  it('runs INSERT … RETURNING at execute time and reports affected rows', async () => {
    const file = path.join(dir, 'ret.db');
    await exec(file, 'CREATE TABLE t(a)');
    const s = await sqliteDriver.connect(cfg(file), {});
    const cur = await s.execute('INSERT INTO t VALUES (1), (2) RETURNING a');
    assert.equal(cur.affectedRows, 2);
    await cur.close(); // 행을 읽지 않고 닫아도
    assert.deepEqual(await queryAll(s, 'SELECT count(*) FROM t'), [[2]]);
    await s.close();
  });

  it('binds booleans and undefined, and refuses objects instead of shifting parameters', async () => {
    const file = path.join(dir, 'bind.db');
    const s = await sqliteDriver.connect(cfg(file), {});
    const cur = await s.execute('SELECT ?, ?', [true, undefined]);
    assert.deepEqual((await cur.fetch(10)).rows, [[1, null]]);
    await cur.close();
    await assert.rejects(s.execute('SELECT ?, ?', [new Date(0), 1]), /Cannot bind/);
    await s.close();
  });

  it('cancel stops a long query without blocking this process, and the next query reconnects', async () => {
    const file = path.join(dir, 'cancel.db');
    const s = await sqliteDriver.connect(cfg(file), {});
    let lost: Error | undefined;
    s.onLost?.((e) => (lost = e));
    const long = s.execute('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000000000) SELECT count(*) FROM c');
    // 쿼리가 도는 동안 이 프로세스(확장 호스트 역할)의 타이머가 돈다 = 멈추지 않았다
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(Date.now() - t0 < 1000, 'event loop kept running during the query');
    await s.cancel();
    await assert.rejects(long, /cancelled/i);
    assert.match(String(lost?.message), /cancelled/i);
    const again = await sqliteDriver.connect(cfg(file), {});
    assert.deepEqual(await queryAll(again, 'SELECT 1'), [[1]]);
    await again.close();
  });

  it('waiting for another app\'s lock does not block this process', async () => {
    const file = path.join(dir, 'busy.db');
    await exec(file, 'CREATE TABLE t(a)');
    const app = new DatabaseSync(file);
    app.exec('BEGIN EXCLUSIVE; INSERT INTO t VALUES (1)');
    const s = await sqliteDriver.connect(cfg(file), {});
    const waiting = s.execute('INSERT INTO t VALUES (2)');
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(Date.now() - t0 < 1000, 'event loop kept running while SQLite waited for the lock');
    app.exec('COMMIT');
    await (await waiting).close(); // 잠금이 풀리면 기다리던 쓰기가 끝난다
    assert.deepEqual(await queryAll(s, 'SELECT a FROM t ORDER BY a'), [[1], [2]]);
    app.close();
    await s.close();
  });

  it('killing a write in the middle leaves the database intact (journal rollback)', async () => {
    const file = path.join(dir, 'kill.db');
    await exec(file, 'CREATE TABLE t(a)');
    await exec(file, 'INSERT INTO t VALUES (1)');
    const s = await sqliteDriver.connect(cfg(file), {});
    await (await s.execute('BEGIN')).close();
    await (await s.execute('INSERT INTO t SELECT x FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200000) SELECT x FROM c)')).close();
    const long = s.execute('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000000000) SELECT count(*) FROM c');
    await new Promise((r) => setTimeout(r, 200));
    await s.cancel();
    await assert.rejects(long, /cancelled/i);
    const check = await sqliteDriver.connect(cfg(file), {});
    assert.deepEqual(await queryAll(check, 'PRAGMA integrity_check'), [['ok']]);
    assert.deepEqual(await queryAll(check, 'SELECT count(*) FROM t'), [[1]], 'the uncommitted insert was rolled back');
    await check.close();
  });

  it('a backslash does not hide a second statement (SQLite has no backslash escapes)', async () => {
    const file = path.join(dir, 'bs.db');
    await exec(file, 'CREATE TABLE t(a)');
    await exec(file, 'INSERT INTO t VALUES (1)');
    const s = await sqliteDriver.connect(cfg(file), {});
    await assert.rejects(s.execute("SELECT 'a\\'; DELETE FROM t; --'"), /one statement/);
    assert.deepEqual(await queryAll(s, 'SELECT count(*) FROM t'), [[1]]);
    await s.close();
  });

  it('close() during a long query returns right away instead of waiting for it', async () => {
    const s = await sqliteDriver.connect(cfg(path.join(dir, 'close.db')), {});
    const long = s.execute('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000000000) SELECT count(*) FROM c');
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await s.close();
    assert.ok(Date.now() - t0 < 1500, `close took ${Date.now() - t0} ms`);
    await assert.rejects(long);
  });

  it('pages a result bigger than the in-memory buffer and counts rows exactly', async () => {
    const s = await sqliteDriver.connect(cfg(path.join(dir, 'big.db')), {});
    const cur = await s.execute('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 150000) SELECT x FROM c');
    let total = 0;
    let last = 0;
    for (;;) {
      const { rows, done } = await cur.fetch(7000);
      total += rows.length;
      if (rows.length) last = rows[rows.length - 1][0] as number;
      if (done) break;
    }
    await cur.close();
    assert.equal(total, 150000);
    assert.equal(last, 150000);
    await s.close();
  });

  it('a statement that returns rows but changes nothing reports 0 changed rows', async () => {
    const file = path.join(dir, 'chg.db');
    await exec(file, 'CREATE TABLE t(a)');
    const s = await sqliteDriver.connect(cfg(file), {});
    await (await s.execute('INSERT INTO t VALUES (1), (2), (3)')).close();
    const cur = await s.execute('UPDATE t SET a = a WHERE a > 100 RETURNING a');
    assert.equal(cur.affectedRows, 0);
    await cur.close();
    await s.close();
  });

  it('BEGIN IMMEDIATE starts a transaction, not a block', async () => {
    const file = path.join(dir, 'imm.db');
    await exec(file, 'CREATE TABLE t(a)');
    const s = await sqliteDriver.connect(cfg(file), {});
    for (const sql of ['BEGIN IMMEDIATE', 'INSERT INTO t VALUES (1)', 'COMMIT']) await (await s.execute(sql)).close();
    assert.deepEqual(await queryAll(s, 'SELECT count(*) FROM t'), [[1]]);
    await s.close();
  });
});
