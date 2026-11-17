import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import { queryAll } from '../src/drivers/cursor';
import { sqliteDriver } from '../src/drivers/sqlite';
import type { ConnectionConfig } from '../src/drivers/types';

const dir = mkdtempSync(path.join(tmpdir(), 'bindb-sqlite-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const cfg = (file: string): ConnectionConfig => ({ id: 'x', name: 'x', driver: 'sqlite', file });

async function exec(file: string, sql: string) {
  const s = await sqliteDriver.connect(cfg(file), {});
  await (await s.execute(sql)).close();
  await s.close();
}

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
