import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { queryAll } from '../src/drivers/cursor';
import { mysqlDriver } from '../src/drivers/mysql';
import { postgresDriver, usesCopyProtocol } from '../src/drivers/postgres';
import type { ConnectionConfig, Session } from '../src/drivers/types';
import { splitStatements } from '../src/language/splitter';
import { isolationSql, switchSchemaSql } from '../src/core/sessionSql';
import { sqlLiteral } from '../src/shared/exportFormats';

/*
 * 실제 서버가 있어야 하는 테스트. 환경 변수로 서버를 주면 돈다(없으면 건너뛴다).
 *   BINDB_TEST_PG=127.0.0.1:5432     (사용자 postgres, 비밀번호 없음 · DB postgres)
 *   BINDB_TEST_MYSQL=127.0.0.1:3306  (사용자 root, 비밀번호 없음 · DB bindb_test를 지웠다 다시 만든다)
 */

const target = (v: string | undefined) => {
  if (!v) return undefined;
  const [host, port] = v.split(':');
  return { host, port: Number(port) };
};
const pgAt = target(process.env.BINDB_TEST_PG);
const myAt = target(process.env.BINDB_TEST_MYSQL);

/** 커서를 끝까지 읽는다 */
async function run(s: Session, sql: string) {
  const c = await s.execute(sql);
  const rows: unknown[][] = [];
  for (;;) {
    const r = await c.fetch(500);
    rows.push(...r.rows);
    if (r.done) break;
  }
  return { cols: c.columns.map((x) => x.name), rows, affected: c.affectedRows };
}

describe('COPY sub-protocol detection', () => {
  it('flags COPY … STDIN / STDOUT only', () => {
    for (const sql of ['COPY (SELECT 1) TO STDOUT', 'copy t from stdin', 'COPY t TO STDOUT WITH (FORMAT csv)', '/* x */ COPY t (a) FROM STDIN']) {
      assert.equal(usesCopyProtocol(sql), true, sql);
    }
    for (const sql of ["COPY t TO '/tmp/x'", "COPY t FROM '/tmp/stdin'", "SELECT 'COPY t TO STDOUT'", 'SELECT stdout FROM t']) {
      assert.equal(usesCopyProtocol(sql), false, sql);
    }
  });
});

describe('PostgreSQL (real server)', { skip: !pgAt && 'set BINDB_TEST_PG=host:port' }, () => {
  let s: Session;
  const cfgPg = () => ({ id: 't', name: 't', driver: 'postgres', ...pgAt, database: 'postgres', user: 'postgres' }) as ConnectionConfig;
  before(async () => {
    s = await postgresDriver.connect(cfgPg(), {});
  });
  after(() => s?.close());

  // pg-cursor는 COPY 하위 프로토콜을 처리하지 못해 잡히지 않는 예외가 나고 그 연결이 끝나지 않았다
  it('refuses COPY … TO STDOUT / FROM STDIN and keeps the session usable', async () => {
    for (const sql of ['COPY (SELECT 1) TO STDOUT', 'copy pg_class from stdin']) {
      await assert.rejects(s.execute(sql), /not supported/, sql);
      assert.deepEqual(await queryAll(s, 'SELECT 1'), [[1]]);
    }
  });

  it('still runs COPY to a server file', async () => {
    assert.equal((await run(s, "COPY (SELECT 1) TO '/dev/null'")).affected, 1);
  });

  // 머티리얼라이즈드 뷰는 information_schema에 없어서 탐색기에서 빠졌다
  it('lists materialized views (as views) with their columns', async () => {
    await queryAll(s, 'DROP MATERIALIZED VIEW IF EXISTS bindb_mv');
    await queryAll(s, 'CREATE MATERIALIZED VIEW bindb_mv AS SELECT 1 AS x, 2::text AS y');
    const meta = await postgresDriver.introspect(s, { id: 't', name: 't', driver: 'postgres' } as ConnectionConfig);
    const mv = meta.find((m) => m.name === 'bindb_mv');
    assert.deepEqual(mv && { kind: mv.kind, cols: mv.columns.map((c) => `${c.name}:${c.type}`), def: /SELECT/.test(mv.definition ?? '') }, {
      kind: 'view',
      cols: ['x:integer', 'y:text'],
      def: true,
    });
    await queryAll(s, 'DROP MATERIALIZED VIEW bindb_mv');
  });

  // pg_cancel_backend는 새로 로그인해야 해서 연결 수 한도 · 권한 · PgBouncer에서 실패할 수 있다
  it('cancels with a protocol CancelRequest, without logging in again', async () => {
    const victim = await postgresDriver.connect(cfgPg(), {});
    await queryAll(s, `ALTER ROLE postgres CONNECTION LIMIT -1`);
    const before = Number((await queryAll(s, `SELECT count(*) FROM pg_stat_activity WHERE usename = 'postgres'`))[0][0]);
    const run = victim.execute('SELECT pg_sleep(30)').then(() => 'finished', (e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    await victim.cancel();
    assert.match(await run, /canceling statement due to user request/);
    assert.ok(Date.now() - started < 3000);
    const after = Number((await queryAll(s, `SELECT count(*) FROM pg_stat_activity WHERE usename = 'postgres'`))[0][0]);
    assert.equal(after, before, 'no extra session was opened');
    assert.deepEqual(await queryAll(victim, 'SELECT 1'), [[1]]);
    await victim.close();
  });

  it('SSL mode Prefer falls back to plain text when the server has no SSL; Require does not', async () => {
    const plain = await postgresDriver.connect({ ...cfgPg(), ssl: 'prefer' }, {});
    assert.deepEqual(await queryAll(plain, 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()'), [[false]]);
    await plain.close();
    await assert.rejects(postgresDriver.connect({ ...cfgPg(), ssl: 'require' }, {}), /does not support SSL/);
  });

  // search_path를 고른 스키마 하나로 바꾸면 public의 확장 함수 · 타입을 못 찾았다
  it('switching schema keeps the rest of search_path', async () => {
    await queryAll(s, 'DROP SCHEMA IF EXISTS bindb_s CASCADE');
    await queryAll(s, 'CREATE SCHEMA bindb_s');
    await queryAll(s, 'CREATE OR REPLACE FUNCTION public.bindb_ext() RETURNS int LANGUAGE sql AS $$ SELECT 7 $$');
    const base = String((await queryAll(s, 'SHOW search_path'))[0][0]);
    await queryAll(s, switchSchemaSql({ id: 't', name: 't', driver: 'postgres' } as ConnectionConfig, 'bindb_s', base)!);
    assert.deepEqual(await queryAll(s, 'SELECT current_schema(), bindb_ext()'), [['bindb_s', 7]]);
    await queryAll(s, `SET search_path TO ${base}`);
    await queryAll(s, 'DROP FUNCTION public.bindb_ext()');
    await queryAll(s, 'DROP SCHEMA bindb_s');
  });

  it('isolation level: the session default follows Transaction control', async () => {
    const x = await postgresDriver.connect(cfgPg(), {});
    await queryAll(x, isolationSql({ driver: 'postgres', isolation: 'serializable' })!);
    assert.deepEqual(await queryAll(x, 'SHOW transaction_isolation'), [['serializable']]);
    await x.close();
  });

  // DataGrip 자동 수준: 현재 스키마의 객체가 1000개를 넘으면 2단계(소스 코드 없음)
  it('automatic introspection level drops to 2 above 1000 objects in the current schema', async () => {
    await queryAll(s, 'DROP SCHEMA IF EXISTS bindb_lvl CASCADE');
    await queryAll(s, 'CREATE SCHEMA bindb_lvl');
    await queryAll(s, "DO $$ BEGIN FOR i IN 1..1000 LOOP EXECUTE format('CREATE TABLE bindb_lvl.t%s (id int PRIMARY KEY)', i); END LOOP; END $$");
    await queryAll(s, 'CREATE VIEW bindb_lvl.v AS SELECT 1 AS x');
    const cfg = { id: 't', name: 't', driver: 'postgres', schemaPattern: undefined } as ConnectionConfig;
    const level = async () => {
      const meta = (await postgresDriver.introspect(s, cfg)).filter((m) => m.schema === 'bindb_lvl');
      const v = meta.find((m) => m.name === 'v')!;
      return { n: meta.length, level: v.level, def: !!v.definition, pk: meta.find((m) => m.name === 't1')?.primaryKey };
    };
    // bindb_lvl은 현재 스키마가 아니다 → 3000개 이하면 2단계
    assert.deepEqual(await level(), { n: 1001, level: 2, def: false, pk: ['id'] });
    // 스키마마다 지정하면 그 값
    const meta3 = (await postgresDriver.introspect(s, { ...cfg, schemaLevels: { bindb_lvl: 3 } })).find((m) => m.schema === 'bindb_lvl' && m.name === 'v')!;
    assert.deepEqual([meta3.level, !!meta3.definition], [3, true]);
    const meta1 = (await postgresDriver.introspect(s, { ...cfg, schemaLevels: { bindb_lvl: 1 } })).find((m) => m.schema === 'bindb_lvl' && m.name === 't1')!;
    assert.deepEqual([meta1.level, meta1.columns, meta1.primaryKey], [1, [{ name: 'id', type: undefined }], undefined]);
    await queryAll(s, 'DROP SCHEMA bindb_lvl CASCADE');
  });

  // 배열 · point가 JS 배열 · 객체로 바뀌어 JSON으로 보였고, 그 셀을 저장하면 malformed array literal로 실패했다
  it('returns arrays, geometric and date values as PostgreSQL text, and keeps numbers, booleans, bytea and json', async () => {
    const r = await run(
      s,
      `SELECT '{"a,b","c\\"d",NULL}'::text[], '{1,2}'::int[], '(1,2)'::point, '<(0,0),1>'::circle, '2024-01-01'::date,
              '1 day 02:03'::interval, 42::int4, 0.5::float8, true, '\\x00ff'::bytea, '{"k":[1]}'::jsonb, 9223372036854775807::int8, 1.50::numeric`,
    );
    const [row] = r.rows;
    assert.deepEqual(row.slice(0, 6), ['{"a,b","c\\"d",NULL}', '{1,2}', '(1,2)', '<(0,0),1>', '2024-01-01', '1 day 02:03:00']);
    assert.deepEqual(row.slice(6, 9), [42, 0.5, true]);
    assert.ok(Buffer.isBuffer(row[9]));
    assert.deepEqual(row.slice(10), [{ k: [1] }, '9223372036854775807', '1.50']);
  });

  it('a value shown in the grid can be written back unchanged', async () => {
    await queryAll(s, 'DROP TABLE IF EXISTS bindb_rt');
    await queryAll(s, `CREATE TABLE bindb_rt (id int PRIMARY KEY, ta text[], p point, d timestamptz)`);
    await queryAll(s, `INSERT INTO bindb_rt VALUES (1, '{"a,b","c\\"d",NULL}', '(1,2)', '2024-01-01 00:00:00.123456+00')`);
    const [[, ta, p, d]] = (await run(s, 'SELECT * FROM bindb_rt')).rows;
    // 그리드 편집은 값을 매개변수(글자)로 보낸다
    const c = await s.execute('UPDATE bindb_rt SET ta = $1, p = $2, d = $3 WHERE id = $4', [ta, p, d, 1]);
    assert.equal(c.affectedRows, 1);
    const [[same]] = await queryAll(s, `SELECT ta = '{"a,b","c\\"d",NULL}' AND p ~= '(1,2)' AND d = '2024-01-01 00:00:00.123456+00' FROM bindb_rt`);
    assert.equal(same, true);
    await queryAll(s, 'DROP TABLE bindb_rt');
  });
});

describe('MySQL (real server)', { skip: !myAt && 'set BINDB_TEST_MYSQL=host:port' }, () => {
  const cfg = { id: 't', name: 't', driver: 'mysql', ...myAt, database: 'bindb_test', user: 'root' } as ConnectionConfig;
  let s: Session;
  before(async () => {
    const boot = await mysqlDriver.connect({ ...cfg, database: undefined }, {});
    await queryAll(boot, 'DROP DATABASE IF EXISTS bindb_test');
    await queryAll(boot, 'CREATE DATABASE bindb_test');
    await boot.close();
    s = await mysqlDriver.connect(cfg, {});
    for (const sql of [
      'CREATE TABLE e1 (id int PRIMARY KEY, note varchar(50))',
      "INSERT INTO e1 VALUES (1, 'a'), (2, 'b')",
      "CREATE PROCEDURE p2() BEGIN SELECT 1 AS a; SELECT 'x' AS b, 'y' AS c; END",
      "CREATE PROCEDURE p_empty_first() BEGIN SELECT id FROM e1 WHERE 1 = 0; SELECT 'x' AS b; END",
      "CREATE PROCEDURE p_update_then_select() BEGIN UPDATE e1 SET note = 'u' WHERE id = 1; SELECT id, note FROM e1 ORDER BY id; END",
      "CREATE PROCEDURE p_update_only() BEGIN UPDATE e1 SET note = 'v' WHERE id IN (1, 2); END",
    ]) await queryAll(s, sql);
  });
  after(async () => {
    await queryAll(s, 'DROP DATABASE IF EXISTS bindb_test').catch(() => {});
    await s?.close();
  });

  // 뒤 결과 집합의 행과 CALL 끝의 OK 패킷(객체)이 첫 결과의 행으로 섞였다
  it('CALL shows only the first result set with columns', async () => {
    assert.deepEqual(await run(s, 'CALL p2()'), { cols: ['a'], rows: [['1']], affected: undefined });
  });

  it('CALL whose first SELECT is empty keeps columns and rows from the same set', async () => {
    assert.deepEqual(await run(s, 'CALL p_empty_first()'), { cols: ['id'], rows: [], affected: undefined });
  });

  it('CALL with UPDATE then SELECT shows the SELECT', async () => {
    const r = await run(s, 'CALL p_update_then_select()');
    assert.deepEqual(r.cols, ['id', 'note']);
    assert.deepEqual(r.rows, [[1, 'u'], [2, 'b']]);
  });

  it('CALL with only an UPDATE has no result set', async () => {
    const r = await run(s, 'CALL p_update_only()');
    assert.deepEqual([r.cols, r.rows], [[], []]);
    assert.deepEqual(await queryAll(s, 'SELECT 42'), [['42']]);
  });

  // DELIMITER 줄까지 SQL로 보내서 프로시저 덤프가 실패했다
  it('runs a DELIMITER script statement by statement', async () => {
    const script = [
      'DROP PROCEDURE IF EXISTS p_delim;',
      'DELIMITER $$',
      "CREATE PROCEDURE p_delim() BEGIN SELECT 'a;b' AS v; SELECT 2; END$$",
      'DELIMITER //',
      'DROP PROCEDURE IF EXISTS p_delim2//',
      'CREATE PROCEDURE p_delim2() BEGIN SELECT 3; END //',
      'DELIMITER ;',
      'CALL p_delim();',
    ].join('\n');
    const statements = splitStatements(script, 'mysql').map((x) => x.text);
    assert.equal(statements.length, 5);
    let last;
    for (const sql of statements) last = await run(s, sql);
    assert.deepEqual(last, { cols: ['v'], rows: [['a;b']], affected: undefined });
    assert.deepEqual(await queryAll(s, 'SELECT 1'), [['1']]);
  });

  // 서버의 자체 서명 인증서(ca.pem): 체인은 맞지만 호스트 이름(127.0.0.1)은 인증서에 없다
  it('SSL modes: Verify CA checks the chain only, Verify full also the host name; Require + CA file acts as Verify CA', { skip: !process.env.BINDB_TEST_MYSQL_CA && 'set BINDB_TEST_MYSQL_CA=…/ca.pem' }, async () => {
    const ca = process.env.BINDB_TEST_MYSQL_CA!;
    const ok = async (patch: Partial<ConnectionConfig>) => {
      const x = await mysqlDriver.connect({ ...cfg, ...patch }, {});
      const [[cipher]] = await queryAll(x, "SHOW SESSION STATUS LIKE 'Ssl_cipher'").then((r) => r.map((row) => [row[1]]));
      await x.close();
      return cipher;
    };
    assert.ok(await ok({ ssl: 'prefer' }), 'prefer uses SSL when the server has it');
    assert.ok(await ok({ ssl: 'verify-ca', sslCaFile: ca }));
    assert.ok(await ok({ ssl: 'require', sslCaFile: ca }));
    await assert.rejects(mysqlDriver.connect({ ...cfg, ssl: 'verify', sslCaFile: ca }, {}), /IP|altnames|Hostname|identity/i);
    await assert.rejects(mysqlDriver.connect({ ...cfg, ssl: 'verify-ca' }, {}), /self[- ]signed|certificate/i);
  });

  // \ 가 든 값의 SQL INSERT가 NO_BACKSLASH_ESCAPES 모드에서 다른 값이 됐다
  it('SQL INSERT literals mean the same with and without NO_BACKSLASH_ESCAPES', async () => {
    const value = "a\\'b ü \\n";
    const lit = sqlLiteral('mysql', value);
    for (const mode of ['', 'NO_BACKSLASH_ESCAPES']) {
      await queryAll(s, `SET SESSION sql_mode = '${mode}'`);
      assert.deepEqual(await queryAll(s, `SELECT ${lit}`), [[value]], mode || 'default');
    }
    await queryAll(s, `SET SESSION sql_mode = DEFAULT`);
  });

  it('isolation level: the session default follows Transaction control', async () => {
    await queryAll(s, isolationSql({ driver: 'mysql', isolation: 'readCommitted' })!);
    assert.deepEqual(await queryAll(s, 'SELECT @@transaction_isolation'), [['READ-COMMITTED']]);
    await queryAll(s, 'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  });

  it('plain statements are unchanged', async () => {
    assert.equal((await run(s, "UPDATE e1 SET note = 'w' WHERE id = 2")).affected, 1);
    assert.deepEqual(await run(s, 'SELECT id, note FROM e1 WHERE 1 = 0'), { cols: ['id', 'note'], rows: [], affected: undefined });
  });
});
