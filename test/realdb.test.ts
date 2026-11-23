import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { queryAll } from '../src/drivers/cursor';
import { mysqlDriver } from '../src/drivers/mysql';
import { postgresDriver, usesCopyProtocol } from '../src/drivers/postgres';
import type { CodeStyle, ConnectionConfig, DriverId, Session } from '../src/drivers/types';
import { splitStatements } from '../src/language/splitter';
import { isolationSql, switchSchemaSql } from '../src/core/sessionSql';
import { sqlLiteral } from '../src/shared/exportFormats';
import { readViewSource, sameDefinition, sameSource, viewDdlText, viewMigration, type ViewName } from '../src/core/viewSource';
import { withCodeStyle } from '../src/core/ddl';

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

/** 뷰 DDL 편집기와 같은 조회로 이 세션에서 뷰 정의를 읽는다 */
const readView = (s: Session, driver: DriverId, v: ViewName, style?: CodeStyle) => readViewSource(driver, v, (q) => queryAll(s, q.sql, q.params), style);
/** 소문자 키워드 · 필요할 때만 인용하는 코드 스타일 */
const LOWER = { keywordCase: 'lower', quoteIdentifiers: 'needed' } as const;

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

  it('reads foreign keys from pg_catalog: composite, cross-schema, two to the same table', async () => {
    await queryAll(s, 'DROP SCHEMA IF EXISTS bindb_fk CASCADE');
    for (const q of [
      'CREATE SCHEMA bindb_fk',
      'CREATE TABLE bindb_fk.users (id int PRIMARY KEY)',
      'CREATE TABLE bindb_fk.pairs (a int, b int, PRIMARY KEY (b, a))',
      'CREATE TABLE public.bindb_orders (id int, created_by int REFERENCES bindb_fk.users, updated_by int REFERENCES bindb_fk.users(id), pa int, pb int, CONSTRAINT p FOREIGN KEY (pa, pb) REFERENCES bindb_fk.pairs (a, b))',
      // 다른 테이블의 같은 이름 제약(PostgreSQL은 테이블마다 고유) — 섞이지 않아야 한다
      'CREATE TABLE bindb_fk.other (x int, y int, CONSTRAINT p FOREIGN KEY (y, x) REFERENCES bindb_fk.pairs (a, b))',
    ]) await queryAll(s, q);
    try {
      const meta = await postgresDriver.introspect(s, { id: 't', name: 't', driver: 'postgres' } as ConnectionConfig);
      const fks = (schema: string, name: string) =>
        meta.find((t) => t.schema === schema && t.name === name)?.foreignKeys?.map((k) => `${k.columns}->${k.refSchema}.${k.refTable}(${k.refColumns})`).sort();
      assert.deepEqual(fks('public', 'bindb_orders'), ['created_by->bindb_fk.users(id)', 'pa,pb->bindb_fk.pairs(a,b)', 'updated_by->bindb_fk.users(id)']);
      assert.deepEqual(fks('bindb_fk', 'other'), ['y,x->bindb_fk.pairs(a,b)']);
    } finally {
      await queryAll(s, 'DROP TABLE public.bindb_orders');
      await queryAll(s, 'DROP SCHEMA bindb_fk CASCADE');
    }
  });

  it('reads table, view and column comments (level 2 and up)', async () => {
    await queryAll(s, 'DROP SCHEMA IF EXISTS bindb_cm CASCADE');
    for (const q of [
      'CREATE SCHEMA bindb_cm',
      'CREATE TABLE bindb_cm.t (id int, "Mixed" text, nocomment int)',
      "COMMENT ON TABLE bindb_cm.t IS 'the table'",
      "COMMENT ON COLUMN bindb_cm.t.id IS 'key'",
      'COMMENT ON COLUMN bindb_cm.t."Mixed" IS \'mixed case\'',
      'CREATE VIEW bindb_cm.v AS SELECT id FROM bindb_cm.t',
      "COMMENT ON VIEW bindb_cm.v IS 'the view'",
      'CREATE MATERIALIZED VIEW bindb_cm.mv AS SELECT 1 AS x',
      "COMMENT ON MATERIALIZED VIEW bindb_cm.mv IS 'the matview'",
      "COMMENT ON COLUMN bindb_cm.mv.x IS 'mx'",
      'ALTER TABLE bindb_cm.t DROP COLUMN nocomment',
    ]) await queryAll(s, q);
    try {
      const base = { id: 't', name: 't', driver: 'postgres' } as ConnectionConfig;
      const meta = (await postgresDriver.introspect(s, base)).filter((m) => m.schema === 'bindb_cm');
      const t = meta.find((m) => m.name === 't')!;
      assert.equal(t.comment, 'the table');
      assert.deepEqual(t.columns.map((c) => `${c.name}:${c.comment ?? ''}`), ['id:key', 'Mixed:mixed case']);
      assert.equal(meta.find((m) => m.name === 'v')?.comment, 'the view');
      const mv = meta.find((m) => m.name === 'mv');
      assert.deepEqual([mv?.comment, mv?.columns[0].comment], ['the matview', 'mx']);
      const lvl1 = (await postgresDriver.introspect(s, { ...base, schemaLevels: { bindb_cm: 1 } })).find((m) => m.schema === 'bindb_cm' && m.name === 't')!;
      assert.equal(lvl1.comment, undefined);
      assert.equal(lvl1.columns[0].comment, undefined);
    } finally {
      await queryAll(s, 'DROP SCHEMA bindb_cm CASCADE');
    }
  });

  // 뷰 DDL 편집기: 캐시한 정의와 편집기가 새로 읽은 정의가 평소에 같아야 열 때마다 경고하지 않는다
  it('view DDL: cached and freshly read definitions match; Submit replaces the view', async () => {
    await queryAll(s, 'DROP SCHEMA IF EXISTS bindb_vs CASCADE');
    for (const q of [
      'CREATE SCHEMA bindb_vs',
      'CREATE TABLE bindb_vs.t (id int, name text)',
      'CREATE VIEW bindb_vs.v AS SELECT id FROM bindb_vs.t WHERE id > 0',
      'CREATE MATERIALIZED VIEW bindb_vs.m AS SELECT id FROM bindb_vs.t',
    ]) await queryAll(s, q);
    try {
      const meta = await postgresDriver.introspect(s, { ...cfgPg(), introspectionLevel: 3, loadSources: 'all' });
      const fresh = (name: string) => readView(s, 'postgres', { schema: 'bindb_vs', name });
      for (const name of ['v', 'm']) {
        const cached = meta.find((t) => t.schema === 'bindb_vs' && t.name === name)?.definition;
        const now = await fresh(name);
        assert.ok(cached && now && sameDefinition(cached, now.definition, 'postgres'), name);
        assert.equal(now?.materialized, name === 'm');
      }
      const v = { schema: 'bindb_vs', name: 'v' };
      // 편집기에 여는 DDL을 그대로 Submit해도 같은 뷰가 된다
      const opened = viewDdlText((await fresh('v'))!);
      const same = viewMigration('postgres', opened, v);
      assert.ok(!('error' in same));
      for (const sql of same.statements) await queryAll(s, sql);
      assert.ok(sameDefinition((await fresh('v'))!.definition, meta.find((t) => t.name === 'v' && t.schema === 'bindb_vs')!.definition!, 'postgres'));
      const m = viewMigration('postgres', 'CREATE VIEW bindb_vs.v AS SELECT id, name FROM bindb_vs.t WHERE id > 1', v);
      assert.ok(!('error' in m));
      for (const sql of m.statements) await queryAll(s, sql);
      assert.match((await fresh('v'))!.definition, /name/);
      // PostgreSQL의 CREATE OR REPLACE VIEW는 열을 뺄 수 없다 — 서버 오류가 그대로 보인다
      const drop = viewMigration('postgres', 'CREATE VIEW bindb_vs.v AS SELECT id FROM bindb_vs.t', v);
      assert.ok(!('error' in drop));
      await assert.rejects(queryAll(s, drop.statements[0]), /cannot drop columns from view/);
    } finally {
      await queryAll(s, 'DROP SCHEMA bindb_vs CASCADE');
    }
  });

  // 코드 리뷰에서 찾은 것: 본문만 다시 만들어 보안 옵션 · CHECK OPTION이 사라졌다
  it('view DDL: Submit of the opened DDL keeps security_barrier, security_invoker and check_option', async () => {
    await queryAll(s, 'DROP SCHEMA IF EXISTS bindb_vo CASCADE');
    for (const q of [
      'CREATE SCHEMA bindb_vo',
      'CREATE TABLE bindb_vo.t (id int, owner text)',
      'CREATE VIEW bindb_vo.v WITH (security_barrier = true, security_invoker = true) AS SELECT id FROM bindb_vo.t WHERE id > 0 WITH LOCAL CHECK OPTION',
    ]) await queryAll(s, q);
    try {
      const v = { schema: 'bindb_vo', name: 'v' };
      const fresh = () => readView(s, 'postgres', v);
      const before = (await fresh())!;
      const m = viewMigration('postgres', viewDdlText(before).replace('id > 0', 'id > 1'), v);
      assert.ok(!('error' in m));
      for (const sql of m.statements) await queryAll(s, sql);
      const [[options]] = await queryAll(s, "SELECT array_to_string(reloptions, ',') FROM pg_class WHERE oid = 'bindb_vo.v'::regclass");
      assert.deepEqual(String(options).split(',').sort(), ['check_option=local', 'security_barrier=true', 'security_invoker=true']);
      assert.match((await fresh())!.definition, /id > 1/);
    } finally {
      await queryAll(s, 'DROP SCHEMA bindb_vo CASCADE');
    }
  });

  it('view DDL round trip: every reloption combination, quoted mixed-case / special names, comments and strings with semicolons', async () => {
    const schema = 'Bindb "Mixed" S;';
    const q = (s: string) => `"${s.split('"').join('""')}"`;
    await queryAll(s, `DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
    await queryAll(s, `CREATE SCHEMA ${q(schema)}`);
    await queryAll(s, `CREATE TABLE ${q(schema)}.t (id int, "Name" text)`);
    const opts = ['security_barrier = true', 'security_invoker = true', 'check_option = local'];
    const names = ['MixedCase', 'semi;colon view', 'a"b', 'select', 'ünï', 'v5', 'v6', 'v7'];
    const reloptions = async (name: string) =>
      String((await queryAll(s, `SELECT coalesce(array_to_string(c.reloptions, ','), '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [schema, name]))[0][0])
        .split(',')
        .filter(Boolean)
        .sort();
    try {
      for (let mask = 0; mask < 8; mask++) {
        const name = names[mask];
        const on = opts.filter((_, i) => mask & (1 << i));
        const withOpts = on.filter((o) => !o.startsWith('check_option'));
        const check = on.some((o) => o.startsWith('check_option')) ? ' WITH LOCAL CHECK OPTION' : '';
        await queryAll(
          s,
          `CREATE VIEW ${q(schema)}.${q(name)}${withOpts.length ? ` WITH (${withOpts.join(', ')})` : ''} AS
             SELECT id, "Name", 'a;b' AS s, $$x;y$$ AS d /* c; */ FROM ${q(schema)}.t -- trailing; comment
             WHERE id > 0 AND "Name" <> 'it''s;'${check}`,
        );
        const v = { schema, name };
        for (const style of [undefined, LOWER]) {
          const fresh = () => readView(s, 'postgres', v, style);
          const before = (await fresh())!;
          const optsBefore = await reloptions(name);
          const m = withCodeStyle(style, () => viewMigration('postgres', viewDdlText(before), v));
          assert.ok(!('error' in m), `${name}: ${'error' in m ? m.error : ''}`);
          for (const sql of m.statements) await queryAll(s, sql);
          const after = (await fresh())!;
          assert.ok(sameSource(before, after, 'postgres'), `${name} ${style ? 'needed' : 'always'}: ${viewDdlText(before)} → ${viewDdlText(after)}`);
          assert.deepEqual(await reloptions(name), optsBefore, name);
          assert.equal(optsBefore.length, on.length, name);
        }
        assert.match((await readView(s, 'postgres', v))!.definition, /'a;b'::text AS s/);
      }
      // 같은 뷰가 하나 더 생기지 않았다(대소문자 · 특수 문자 이름을 바르게 인용했다)
      assert.deepEqual(
        (await queryAll(s, 'SELECT table_name FROM information_schema.views WHERE table_schema = $1', [schema])).map((r) => String(r[0])).sort(),
        [...names].sort(),
      );
    } finally {
      await queryAll(s, `DROP SCHEMA ${q(schema)} CASCADE`);
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

  it('reads foreign keys from key_column_usage', async () => {
    await queryAll(s, 'CREATE TABLE fk_pairs (a int, b int, PRIMARY KEY (b, a))');
    await queryAll(s, 'CREATE TABLE fk_child (id int, x int, y int, e int, FOREIGN KEY (x, y) REFERENCES fk_pairs (b, a), FOREIGN KEY (e) REFERENCES e1 (id))');
    const meta = await mysqlDriver.introspect(s, cfg);
    const fk = meta.find((t) => t.name === 'fk_child')?.foreignKeys?.map((k) => `${k.columns}->${k.refSchema}.${k.refTable}(${k.refColumns})`).sort();
    assert.deepEqual(fk, ['e->bindb_test.e1(id)', 'x,y->bindb_test.fk_pairs(b,a)']);
  });

  it('reads table and column comments, not the VIEW marker of views', async () => {
    await queryAll(s, "CREATE TABLE cm_t (id int COMMENT 'key', x int) COMMENT = 'the table'");
    await queryAll(s, 'CREATE VIEW cm_v AS SELECT id FROM cm_t');
    const meta = await mysqlDriver.introspect(s, cfg);
    const t = meta.find((m) => m.name === 'cm_t')!;
    assert.equal(t.comment, 'the table');
    assert.deepEqual(t.columns.map((c) => `${c.name}:${c.comment ?? ''}`), ['id:key', 'x:']);
    assert.equal(meta.find((m) => m.name === 'cm_v')?.comment, undefined);
  });

  it('view DDL: cached and freshly read definitions match; Submit keeps SQL SECURITY and replaces the view', async () => {
    await queryAll(s, 'CREATE TABLE vs_t (id int, name varchar(20))');
    await queryAll(s, 'CREATE SQL SECURITY INVOKER VIEW vs_v AS SELECT id FROM vs_t WHERE id > 0');
    const v = { schema: 'bindb_test', name: 'vs_v' };
    const fresh = () => readView(s, 'mysql', v);
    const meta = await mysqlDriver.introspect(s, { ...cfg, introspectionLevel: 3, loadSources: 'all' });
    const cached = meta.find((t) => t.name === 'vs_v')?.definition;
    const now = await fresh();
    assert.ok(cached && now && sameDefinition(cached, now.definition, 'mysql'));
    const m = viewMigration('mysql', 'CREATE SQL SECURITY INVOKER VIEW vs_v AS SELECT id, name FROM vs_t', v);
    assert.ok(!('error' in m));
    assert.deepEqual(m.statements, ['CREATE OR REPLACE SQL SECURITY INVOKER VIEW `bindb_test`.`vs_v` AS SELECT id, name FROM vs_t']);
    for (const sql of m.statements) await queryAll(s, sql);
    assert.match((await fresh())!.definition, /`name`/);
    assert.deepEqual(await queryAll(s, "SELECT security_type FROM information_schema.views WHERE table_schema = 'bindb_test' AND table_name = 'vs_v'"), [['INVOKER']]);
  });

  // 코드 리뷰에서 찾은 것: 본문만 다시 만들어 DEFINER · SQL SECURITY · ALGORITHM · CHECK OPTION이 바뀌었다
  it('view DDL: Submit of the opened DDL keeps ALGORITHM, DEFINER, SQL SECURITY and CHECK OPTION', async () => {
    await queryAll(s, 'CREATE TABLE vo_t (id int, name varchar(20))');
    await queryAll(s, "CREATE USER IF NOT EXISTS 'vo_app'@'%'");
    await queryAll(s, 'CREATE ALGORITHM=MERGE DEFINER=`vo_app`@`%` SQL SECURITY INVOKER VIEW vo_v AS SELECT id FROM vo_t WHERE id > 0 WITH CASCADED CHECK OPTION');
    try {
      const v = { schema: 'bindb_test', name: 'vo_v' };
      const before = (await readView(s, 'mysql', v))!;
      const m = viewMigration('mysql', viewDdlText(before).replace('> 0', '> 1'), v);
      assert.ok(!('error' in m));
      for (const sql of m.statements) await queryAll(s, sql);
      assert.deepEqual(
        await queryAll(s, "SELECT definer, security_type, check_option FROM information_schema.views WHERE table_schema = 'bindb_test' AND table_name = 'vo_v'"),
        [['vo_app@%', 'INVOKER', 'CASCADED']],
      );
      const [[, create]] = await queryAll(s, 'SHOW CREATE VIEW vo_v');
      assert.match(String(create), /ALGORITHM=MERGE/);
      assert.match(String(create), /> 1/);
    } finally {
      await queryAll(s, "DROP USER IF EXISTS 'vo_app'@'%'");
    }
  });

  it('view DDL round trip: each ALGORITHM, DEFINER form, SQL SECURITY, column lists, LOCAL / CASCADED CHECK OPTION, names needing backticks', async () => {
    await queryAll(s, 'CREATE TABLE `rt t` (id int, `se``lect` varchar(20))');
    const users = ["'rt.app'@'%'", "'rt_app'@'10.0.0.%'", "'rt_app'@'localhost'"];
    for (const u of users) await queryAll(s, `CREATE USER IF NOT EXISTS ${u}`);
    const attrs = async (name: string) => {
      const [row] = await queryAll(s, 'SELECT definer, security_type, check_option FROM information_schema.views WHERE table_schema = ? AND table_name = ?', ['bindb_test', name]);
      const [[, create]] = await queryAll(s, `SHOW CREATE VIEW \`${name.split('`').join('``')}\``);
      return { row, algorithm: /ALGORITHM=(\w+)/.exec(String(create))?.[1], columns: (await queryAll(s, 'SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position', ['bindb_test', name])).map((r) => r[0]) };
    };
    const cases: { name: string; algorithm: string; definer: string; security: string; columns: string; check: string }[] = [
      { name: 'rt v1', algorithm: 'UNDEFINED', definer: 'CURRENT_USER', security: 'DEFINER', columns: '', check: '' },
      { name: 'rt`v2', algorithm: 'MERGE', definer: "'rt.app'@'%'", security: 'INVOKER', columns: '(`a b`, `c`)', check: ' WITH LOCAL CHECK OPTION' },
      { name: 'select', algorithm: 'TEMPTABLE', definer: '`rt_app`@`10.0.0.%`', security: 'DEFINER', columns: '(x, y)', check: '' },
      { name: 'Mixed.Case', algorithm: 'MERGE', definer: 'rt_app@localhost', security: 'INVOKER', columns: '', check: ' WITH CASCADED CHECK OPTION' },
      { name: 'rt;v5', algorithm: 'UNDEFINED', definer: 'CURRENT_USER()', security: 'INVOKER', columns: '(p, q)', check: ' WITH CHECK OPTION' },
    ];
    try {
      for (const c of cases) {
        const ident = `\`${c.name.split('`').join('``')}\``;
        await queryAll(
          s,
          `CREATE ALGORITHM=${c.algorithm} DEFINER=${c.definer} SQL SECURITY ${c.security} VIEW ${ident} ${c.columns} AS SELECT id, \`se\`\`lect\` FROM \`rt t\` WHERE id > 0 AND \`se\`\`lect\` <> 'a;b'${c.check}`,
        );
        // 탐색기는 서버가 알려 준 이름을 쓴다(lower_case_table_names = 1 · 2면 소문자로 저장된다)
        const [[stored]] = await queryAll(s, 'SELECT table_name FROM information_schema.views WHERE table_schema = ? AND lower(table_name) = lower(?)', ['bindb_test', c.name]);
        const v = { schema: 'bindb_test', name: String(stored) };
        for (const style of [undefined, LOWER]) {
          const fresh = () => readView(s, 'mysql', v, style);
          const before = (await fresh())!;
          const attrsBefore = await attrs(v.name);
          const m = withCodeStyle(style, () => viewMigration('mysql', viewDdlText(before), v));
          assert.ok(!('error' in m), `${c.name}: ${'error' in m ? m.error : ''}`);
          for (const sql of m.statements) await queryAll(s, sql);
          const after = (await fresh())!;
          assert.ok(sameSource(before, after, 'mysql'), `${c.name}: ${viewDdlText(before)} → ${viewDdlText(after)}`);
          assert.deepEqual(await attrs(v.name), attrsBefore, c.name);
        }
        const a = await attrs(v.name);
        assert.equal(a.algorithm, c.algorithm, c.name);
        assert.equal(a.row[1], c.security, c.name);
        assert.equal(a.row[2], c.check.includes('LOCAL') ? 'LOCAL' : c.check ? 'CASCADED' : 'NONE', c.name);
      }
      assert.deepEqual((await attrs('rt`v2')).row[0], 'rt.app@%');
      assert.deepEqual((await attrs('rt`v2')).columns, ['a b', 'c']);
    } finally {
      for (const u of users) await queryAll(s, `DROP USER IF EXISTS ${u}`);
    }
  });

  it('plain statements are unchanged', async () => {
    assert.equal((await run(s, "UPDATE e1 SET note = 'w' WHERE id = 2")).affected, 1);
    assert.deepEqual(await run(s, 'SELECT id, note FROM e1 WHERE 1 = 0'), { cols: ['id', 'note'], rows: [], affected: undefined });
  });
});
