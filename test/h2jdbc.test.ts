import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { queryAll } from '../src/drivers/cursor';
import { h2Driver, h2FileProblem, h2JdbcUrl } from '../src/drivers/h2';
import { runningBridges } from '../src/drivers/jdbc/bridge';
import type { ConnectionConfig, Session } from '../src/drivers/types';

const h2 = (patch: Partial<ConnectionConfig>): ConnectionConfig => ({ id: 'h', name: 'h', driver: 'h2', user: 'sa', ...patch });

describe('H2 JDBC URL', () => {
  it('Embedded, Remote and URL only, with driver options as ;KEY=VALUE', () => {
    assert.equal(h2JdbcUrl(h2({ file: '/d/shop.mv.db' })), 'jdbc:h2:file:/d/shop;IFEXISTS=TRUE');
    assert.equal(h2JdbcUrl(h2({ file: '/d/old.h2.db' })), 'jdbc:h2:file:/d/old;MV_STORE=FALSE;IFEXISTS=TRUE');
    assert.equal(h2JdbcUrl(h2({ host: 'db', database: '~/test' })), 'jdbc:h2:tcp://db:9092/~/test');
    assert.equal(h2JdbcUrl(h2({ host: 'db', port: 9123, database: 'x', driverOptions: { AUTO_SERVER: 'TRUE' } })), 'jdbc:h2:tcp://db:9123/x;AUTO_SERVER=TRUE');
    assert.equal(h2JdbcUrl(h2({ connectionType: 'url', url: 'h2:mem:t' })), 'jdbc:h2:mem:t');
    assert.equal(h2JdbcUrl(h2({ connectionType: 'url', url: 'jdbc:h2:tcp://h/x' })), 'jdbc:h2:tcp://h/x');
    assert.throws(() => h2JdbcUrl(h2({ host: 'db' })), /database/);
  });

  it('an H2 1.4 jar opens .h2.db PageStore files; 2.x jars explain', () => {
    assert.equal(h2FileProblem('/d/old.h2.db', '/j/h2-1.4.200.jar', ''), undefined);
    assert.match(String(h2FileProblem('/d/old.h2.db', '/j/h2-2.3.232.jar', '')), /PageStore/);
  });
});

/*
 * Java와 H2 jar가 있어야 하는 테스트. 둘 다 주면 돈다(없으면 건너뛴다).
 *   BINDB_TEST_JAVA=/…/bin/java   BINDB_TEST_H2_JAR=/…/h2-2.3.232.jar
 */
const java = process.env.BINDB_TEST_JAVA;
const jar = process.env.BINDB_TEST_H2_JAR;

describe('H2 through the JDBC bridge (real Java)', { skip: !(java && jar) && 'set BINDB_TEST_JAVA and BINDB_TEST_H2_JAR' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bindb-h2-'));
  const opts = { h2Jar: jar! };
  const javaHome = java ? path.dirname(path.dirname(java)) : '';
  let oldHome: string | undefined;

  /** URL only로 DB를 만든다(IFEXISTS 없이) */
  async function create(name: string, settings: string, sql: string[]) {
    const s = await h2Driver.connect(h2({ connectionType: 'url', url: `jdbc:h2:file:${path.join(dir, name)}${settings}` }), opts);
    for (const q of sql) await queryAll(s, q);
    await s.close();
  }

  before(async () => {
    oldHome = process.env.JAVA_HOME;
    process.env.JAVA_HOME = javaHome;
    // Java 앱의 기본 설정(이름은 대문자, 스키마 PUBLIC)
    await create('javaapp', '', ["CREATE TABLE CUSTOMER (ID INT PRIMARY KEY, NAME VARCHAR(50))", "INSERT INTO CUSTOMER VALUES (1, 'Ann'), (2, 'Bob')", 'CREATE TABLE "lower_t" (x INT)']);
    // 예전 BindB(H2 PG 서버)가 만든 것과 같은 PostgreSQL 모드(이름은 소문자)
    await create('pgmode', ';MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE', ["CREATE TABLE customer (id INT PRIMARY KEY, name VARCHAR(50))", "INSERT INTO customer VALUES (1, 'Ann')"]);
  });
  after(() => {
    process.env.JAVA_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  });

  const file = (name: string, patch: Partial<ConnectionConfig> = {}) => h2({ file: path.join(dir, `${name}.mv.db`), ...patch });

  // H2 PG 서버는 DATABASE_TO_LOWER=TRUE를 강제해서 이런 DB를 아예 열지 못했다(설계 점검 3번)
  it('opens a database made by a Java app (schema PUBLIC, upper-case names)', async () => {
    const s = await h2Driver.connect(file('javaapp'), opts);
    assert.deepEqual(await queryAll(s, 'SELECT * FROM CUSTOMER ORDER BY ID'), [[1, 'Ann'], [2, 'Bob']]);
    const meta = await h2Driver.introspect(s, file('javaapp'));
    assert.deepEqual(
      meta.map((m) => `${m.schema}.${m.name}:${m.primaryKey ?? ''}`),
      ['PUBLIC.CUSTOMER:ID', 'PUBLIC.lower_t:'],
    );
    await s.close();
  });

  it('still opens databases made in PostgreSQL mode by earlier BindB versions', async () => {
    const s = await h2Driver.connect(file('pgmode'), opts);
    assert.deepEqual(await queryAll(s, 'SELECT name FROM customer'), [['Ann']]);
    await s.close();
  });

  it('starts Java only while connected, one process shared by sessions', async () => {
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(runningBridges(), 0);
    const a = await h2Driver.connect(file('javaapp'), opts);
    const b = await h2Driver.connect(file('javaapp'), opts);
    assert.equal(runningBridges(), 1);
    await a.close();
    assert.equal(runningBridges(), 1, 'still used by b');
    await b.close();
    assert.equal(runningBridges(), 0);
  });

  it('pages through large results and cancels long queries', async () => {
    const s = await h2Driver.connect(file('javaapp'), opts);
    const c = await s.execute('SELECT X FROM SYSTEM_RANGE(1, 30000)');
    let n = 0;
    for (;;) {
      const r = await c.fetch(4000);
      n += r.rows.length;
      if (r.done) break;
    }
    assert.equal(n, 30000);
    const run = s.execute('SELECT COUNT(*) FROM SYSTEM_RANGE(1, 1000000) a, SYSTEM_RANGE(1, 1000000) b').then(
      () => 'finished',
      (e: Error) => e.message,
    );
    await new Promise((r) => setTimeout(r, 300));
    await s.cancel();
    assert.match(await run, /cancel/i);
    assert.deepEqual(await queryAll(s, 'SELECT 1'), [[1]]);
    await s.close();
  });

  it('values: ? parameters, NULL, binary, exact big numbers, timestamps as text', async () => {
    const s = await h2Driver.connect(file('javaapp'), opts);
    await queryAll(s, 'CREATE TABLE T2 (ID INT PRIMARY KEY, NOTE VARCHAR(50), B VARBINARY(4), D TIMESTAMP(6) WITH TIME ZONE)');
    const c = await s.execute('INSERT INTO T2 VALUES (?, ?, ?, ?)', ['1', "it's \\ ü", null, '2024-01-01 00:00:00.123456+09']);
    assert.equal(c.affectedRows, 1);
    const [row] = await queryAll(s, `SELECT NOTE, B, D, X'00FF', CAST(9223372036854775807 AS BIGINT), CAST(1.50 AS DECIMAL(5, 2)) FROM T2`);
    assert.deepEqual(row.slice(0, 3), ["it's \\ ü", null, '2024-01-01 00:00:00.123456+09']);
    assert.equal((row[3] as Buffer).toString('hex'), '00ff');
    assert.deepEqual(row.slice(4), ['9223372036854775807', '1.50']);
    await queryAll(s, 'DROP TABLE T2');
    await s.close();
  });

  // close가 작업 스레드에서 실행 중인 쿼리 뒤에 줄을 서서, 쿼리가 끝날 때까지 닫히지 않았다
  it('closing a session does not wait for its running query', async () => {
    const s = await h2Driver.connect(file('javaapp'), opts);
    const run = s.execute('SELECT COUNT(*) FROM SYSTEM_RANGE(1, 1000000) a, SYSTEM_RANGE(1, 1000000) b').catch((e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 300));
    const t = Date.now();
    await s.close();
    assert.ok(Date.now() - t < 3000, `close took ${Date.now() - t} ms`);
    await run;
  });

  // H2는 UUID를 JDBC 타입 BINARY로 알려서 바이트로 보였다
  it('UUID, JSON, ENUM and GEOMETRY come back as text; binary types as bytes', async () => {
    const s = await h2Driver.connect(file('javaapp'), opts);
    const [row] = await queryAll(
      s,
      `SELECT CAST('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' AS UUID), JSON '{"k":1}', CAST('b' AS ENUM('a','b')), GEOMETRY 'POINT(1 2)', CAST(X'00ff' AS BINARY(2)), CAST(X'01' AS BLOB)`,
    );
    assert.deepEqual(row.slice(0, 4), ['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '{"k":1}', 'b', 'POINT (1 2)']);
    assert.deepEqual(row.slice(4).map((b) => (b as Buffer).toString('hex')), ['00ff', '01']);
    await s.close();
  });

  it('a file opened by another program: says how to share it (AUTO_SERVER)', async () => {
    const holder = await h2Driver.connect(h2({ connectionType: 'url', url: `jdbc:h2:file:${path.join(dir, 'javaapp')}` }), opts);
    // 같은 JVM은 파일을 함께 쓰므로, 다른 JVM(다른 VM 옵션)으로 연다
    await assert.rejects(h2Driver.connect(file('javaapp', { vmOptions: '-Dbindb.test=other' }), opts), /already in use[\s\S]*AUTO_SERVER=TRUE/);
    await holder.close();
  });

  it('Create database: a missing file is an error unless it is turned on', async () => {
    const missing = file('brand-new');
    await assert.rejects(h2Driver.connect(missing, opts), /not found.*Create database/);
    const s = await h2Driver.connect({ ...missing, createDatabase: true }, opts);
    await queryAll(s, 'CREATE TABLE N (ID INT)');
    await s.close();
    const again = await h2Driver.connect(missing, opts);
    assert.deepEqual(await queryAll(again, 'SELECT COUNT(*) FROM N'), [['0']]);
    await again.close();
  });

  it('isolation level is applied through JDBC', async () => {
    const s = await h2Driver.connect(file('javaapp', { isolation: 'serializable' }), opts);
    assert.deepEqual(await queryAll(s, 'SELECT ISOLATION_LEVEL FROM INFORMATION_SCHEMA.SESSIONS WHERE SESSION_ID = SESSION_ID()'), [['SERIALIZABLE']]);
    await s.close();
  });

  it('Introspect using JDBC metadata gives the same tables, keys and readable types', async () => {
    const s = await h2Driver.connect(file('javaapp'), opts);
    const viaInfo = await h2Driver.introspect(s, file('javaapp'));
    const viaJdbc = await h2Driver.introspect(s, file('javaapp', { introspectJdbc: true }));
    const shape = (m: typeof viaInfo) => m.map((t) => `${t.schema}.${t.name}:${t.kind}:${t.primaryKey ?? ''}:${t.columns.map((c) => c.name)}`);
    assert.deepEqual(shape(viaJdbc), shape(viaInfo));
    assert.equal(viaJdbc.find((t) => t.name === 'CUSTOMER')!.columns[0].type, 'INTEGER');
    await s.close();
  });

  it('a killed Java process is reported as a lost connection', async () => {
    const s = await h2Driver.connect(file('javaapp'), opts);
    const lost: string[] = [];
    s.onLost?.((e) => lost.push(e.message));
    execSync('pkill -9 -f bindb.JdbcBridge');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(lost.length, 1);
    await assert.rejects(s.execute('SELECT 1'), /closed/);
    await s.close();
    assert.equal(runningBridges(), 0);
  });

  // 읽기 전용은 SessionManager가 실행 전에 판정한다. 드라이버가 막으면 접속 직후의 SET TIME ZONE · 시작 스크립트까지 막혔다
  it('a read-only data source still runs its setup statements (SET …)', async () => {
    const s = await h2Driver.connect(file('javaapp', { readOnly: true }), opts);
    try {
      await (await s.execute("SET TIME ZONE 'Asia/Seoul'")).close();
      assert.deepEqual(await queryAll(s, 'SELECT COUNT(*) FROM CUSTOMER'), [['2']]);
    } finally {
      await s.close();
    }
  });
});
