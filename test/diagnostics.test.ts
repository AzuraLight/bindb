import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DriverId, MetaTable } from '../src/drivers/types';
import { localObjects, unresolvedReferences } from '../src/language/diagnostics';
import { splitStatements } from '../src/language/splitter';

const tbl = (schema: string, name: string, cols: string[]): MetaTable => ({ schema, name, kind: 'table', columns: cols.map((name) => ({ name })) });
const TABLES = [
  tbl('public', 'users', ['id', 'name', 'email']),
  tbl('public', 'orders', ['id', 'user_id', 'total']),
  tbl('sales', 'invoices', ['id', 'amount']),
  { schema: 'public', name: 'lazy', kind: 'table', columns: [] } as MetaTable,
];

/** 문서 전체에서 문제가 된 글자들 */
function problems(sql: string, driver: DriverId = 'postgres', schema = 'public'): string[] {
  const statements = splitStatements(sql, driver);
  const local = localObjects(statements);
  return statements.flatMap((s) => unresolvedReferences(s, { driver, tables: TABLES, schema, local }).map((p) => sql.slice(p.start, p.end)));
}

describe('unresolved tables', () => {
  it('flags unknown tables in FROM/JOIN/UPDATE/INSERT/DELETE', () => {
    assert.deepEqual(problems('SELECT * FROM userz u JOIN orders o ON o.user_id = u.id'), ['userz']);
    assert.deepEqual(problems('UPDATE nope SET a = 1'), ['nope']);
    assert.deepEqual(problems('INSERT INTO nope (a) VALUES (1)'), ['nope']);
    assert.deepEqual(problems('DELETE FROM nope WHERE id = 1'), ['nope']);
    assert.deepEqual(problems('SELECT 1 FROM users, nope n, orders'), ['nope']);
    assert.deepEqual(problems('SELECT * FROM sales.nope'), ['nope']);
  });

  it('resolves case-insensitively and with schema', () => {
    assert.deepEqual(problems('select * from USERS join sales.invoices i on true'), []);
    assert.deepEqual(problems('select * from "users"'), []);
  });

  it('does not judge schemas or catalogs that were not loaded', () => {
    assert.deepEqual(problems('SELECT * FROM other.t'), []);
    assert.deepEqual(problems('SELECT * FROM db.public.nope'), []);
    assert.deepEqual(problems('SELECT * FROM t', 'postgres', 'unloaded'), []);
  });

  it('skips CTEs, local CREATE TABLE, table functions, subqueries, dual, pg_*', () => {
    assert.deepEqual(problems('WITH x AS (SELECT 1), y(a) AS MATERIALIZED (SELECT 2) SELECT * FROM x, y'), []);
    assert.deepEqual(problems('WITH RECURSIVE r AS (SELECT 1 UNION ALL SELECT 1 FROM r) SELECT * FROM r'), []);
    assert.deepEqual(problems('CREATE TABLE tmp (a int); INSERT INTO tmp VALUES (1); SELECT * FROM public.tmp'), []);
    assert.deepEqual(problems('SELECT * FROM generate_series(1, 3) g, LATERAL unnest(ARRAY[1]) u'), []);
    assert.deepEqual(problems('SELECT * FROM (SELECT 1) AS s JOIN (SELECT 2) t ON true'), []);
    assert.deepEqual(problems('SELECT 1 FROM dual', 'mysql', 'public'), []);
    assert.deepEqual(problems('SELECT * FROM pg_stat_statements'), []);
    // 테이블 함수 · 서브쿼리 · LATERAL 뒤의 쉼표 목록도 이어서 읽는다
    assert.deepEqual(problems('SELECT * FROM generate_series(1, 3) g, nope'), ['nope']);
    assert.deepEqual(problems('SELECT * FROM (SELECT 1 FROM nope1) s, LATERAL (SELECT 2) l, nope2'), ['nope1', 'nope2']);
  });

  it('ignores FROM/UPDATE/INTO that are not table positions', () => {
    assert.deepEqual(problems('SELECT EXTRACT(YEAR FROM created) FROM users'), []);
    assert.deepEqual(problems("SELECT substring(name FROM 2 FOR 3), trim(BOTH ' ' FROM name) FROM users"), []);
    assert.deepEqual(problems('SELECT * FROM users WHERE id IS DISTINCT FROM name'), []);
    assert.deepEqual(problems('SELECT * FROM users FOR UPDATE SKIP LOCKED'), []);
    assert.deepEqual(problems('INSERT INTO users (id) VALUES (1) ON DUPLICATE KEY UPDATE name = 1', 'mysql'), []);
    assert.deepEqual(problems('INSERT INTO users (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET name = excluded.name'), []);
    assert.deepEqual(problems('SELECT id INTO v FROM users'), []);
  });

  it('only analyses DML', () => {
    assert.deepEqual(problems('DROP TABLE nope; GRANT SELECT ON nope TO bob; REVOKE ALL ON x FROM bob; ALTER TABLE nope ADD c int'), []);
    assert.deepEqual(problems('(SELECT * FROM nope)'), ['nope']);
    assert.deepEqual(problems('DELETE FROM users USING nope WHERE true'), ['nope']);
    assert.deepEqual(problems('SELECT * FROM ONLY nope'), ['nope']);
  });

  it('ignores strings and comments', () => {
    assert.deepEqual(problems("SELECT 'FROM nope' FROM users -- FROM nope\n/* JOIN nope */"), []);
    assert.deepEqual(problems('SELECT * FROM "unterminated'), []);
    assert.deepEqual(problems('SELECT u."nam FROM users u'), []);
    assert.deepEqual(problems(''), []);
    assert.deepEqual(problems('SELECT * FROM'), []);
  });
});

describe('unresolved columns', () => {
  it('flags qualified columns through aliases and table names', () => {
    assert.deepEqual(problems('SELECT u.nam, o.total FROM users u JOIN orders o ON o.user_idx = u.id'), ['nam', 'user_idx']);
    assert.deepEqual(problems('SELECT users.bad FROM public.users'), ['bad']);
    assert.deepEqual(problems('SELECT u.* , u.id FROM users AS u'), []);
  });

  it('skips unknown qualifiers, function calls, three-part names and unloaded columns', () => {
    assert.deepEqual(problems('SELECT s.x, x.y FROM (SELECT 1 x) s'), []);
    assert.deepEqual(problems('SELECT public.my_fn(1), public.users.id FROM users'), []);
    assert.deepEqual(problems('SELECT l.anything FROM lazy l'), []);
    assert.deepEqual(problems('WITH c AS (SELECT 1 z) SELECT c.z FROM c'), []);
  });

  it('flags a column only if every same-named alias lacks it', () => {
    assert.deepEqual(problems('SELECT t.name FROM users t WHERE EXISTS (SELECT 1 FROM orders t WHERE t.total > 0)'), []);
    assert.deepEqual(problems('SELECT t.zzz FROM users t WHERE EXISTS (SELECT 1 FROM orders t)'), ['zzz']);
  });

  it('checks INSERT column lists and single-table UPDATE SET targets', () => {
    assert.deepEqual(problems('INSERT INTO users (id, nmae) VALUES (1, 2)'), ['nmae']);
    assert.deepEqual(problems('UPDATE users SET nmae = 1, email = lower(email) WHERE id = 1'), ['nmae']);
    assert.deepEqual(problems('UPDATE users u SET name = (SELECT max(total) FROM orders) WHERE u.id = 1'), []);
    assert.deepEqual(problems('INSERT IGNORE INTO users (bad) VALUES (1)', 'mysql'), ['bad']);
    assert.deepEqual(problems('WITH a AS (DELETE FROM nope RETURNING *) SELECT * FROM a'), ['nope']);
    assert.deepEqual(problems('SELECT * FROM users u WHERE u.id = ANY(SELECT o.bad FROM orders o)'), ['bad']);
    assert.deepEqual(problems('UPDATE users u JOIN orders o ON o.user_id = u.id SET total = 1', 'mysql'), []);
  });
});

describe('unqualified columns', () => {
  it('flags a column that no visible table has', () => {
    assert.deepEqual(problems('SELECT nmae FROM users'), ['nmae']);
    assert.deepEqual(problems('UPDATE users SET name = nmae WHERE id = 1'), ['nmae']);
    assert.deepEqual(problems('DELETE FROM users WHERE nope = 1'), ['nope']);
    assert.deepEqual(problems('SELECT `nmae` FROM `users`', 'mysql'), ['`nmae`']);
    assert.deepEqual(problems('SELECT user_id FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE user_id = users.id)'), ['user_id']);
    assert.deepEqual(problems('SELECT id FROM users WHERE id IN (SELECT user_id FROM orders WHERE total > nope)'), ['nope']);
  });

  it('sees outer tables from a subquery and tables of every join', () => {
    assert.deepEqual(problems('SELECT 1 FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE user_id = id AND email IS NULL)'), []);
    assert.deepEqual(problems("SELECT * FROM users t1 JOIN orders t2 ON t1.id = t2.user_id WHERE total > 0 AND name <> ''"), []);
    assert.deepEqual(problems('UPDATE users SET name = 1 FROM orders WHERE user_id = users.id'), []);
    assert.deepEqual(problems('DELETE FROM users USING orders WHERE user_id = users.id AND total = 0'), []);
  });

  it('does not judge when a visible source has unknown columns', () => {
    assert.deepEqual(problems('SELECT x FROM (SELECT 1 AS x) s'), []);
    assert.deepEqual(problems('SELECT x, name FROM users, generate_series(1, 3) x'), []);
    assert.deepEqual(problems('WITH c AS (SELECT name FROM users) SELECT name, nope FROM c JOIN orders ON true'), []);
    assert.deepEqual(problems('SELECT anything FROM lazy'), []);
    assert.deepEqual(problems('SELECT anything FROM other.t'), []);
    assert.deepEqual(problems('SELECT * FROM users u, LATERAL (SELECT nope FROM orders WHERE user_id = u.id) o'), ['nope']);
  });

  it('skips aliases, output aliases, keywords, niladic functions, date parts, hidden columns and types', () => {
    for (const [sql, driver] of [
      ['SELECT name AS n FROM users ORDER BY n', 'postgres'],
      ['SELECT name n FROM users ORDER BY n', 'postgres'],
      ['SELECT count(*) AS c FROM users GROUP BY name HAVING c > 1', 'mysql'],
      ['SELECT CAST(id AS double precision), id::timestamp with time zone FROM users', 'postgres'],
      ["SELECT DATE '2020-01-01', INTERVAL '1 day', TIMESTAMP '2020-01-01' FROM users", 'postgres'],
      ['SELECT id + INTERVAL 1 DAY FROM users', 'mysql'],
      ['SELECT EXTRACT(YEAR FROM id) FROM users', 'postgres'],
      ['SELECT CURRENT_DATE, CURRENT_TIMESTAMP, CURRENT_USER, LOCALTIME FROM users', 'postgres'],
      ['SELECT rowid, oid, _rowid_ FROM users', 'sqlite'],
      ['SELECT ctid, xmin FROM users', 'postgres'],
      ['SELECT row_number() OVER (PARTITION BY name ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM users', 'postgres'],
      ['SELECT sum(total) OVER w FROM orders WINDOW w AS (PARTITION BY user_id)', 'postgres'],
      ['SELECT * FROM users ORDER BY name NULLS LAST FETCH FIRST 10 ROWS ONLY', 'postgres'],
      ["SELECT * FROM users WHERE name COLLATE \"C\" = 'a' AND email LIKE 'a%' ESCAPE '!'", 'postgres'],
      ['SELECT u FROM users u', 'postgres'],
      ['SELECT name FROM users u JOIN orders o USING (id)', 'postgres'],
      ['INSERT INTO users (id, name) VALUES (1, DEFAULT) ON CONFLICT (id) DO UPDATE SET name = excluded.name', 'postgres'],
      ['INSERT INTO users (id) VALUES (1) ON CONFLICT ON CONSTRAINT users_pkey DO NOTHING', 'postgres'],
      ['SELECT * FROM users FOR UPDATE OF users SKIP LOCKED', 'postgres'],
      ['SELECT SQL_CALC_FOUND_ROWS name FROM users LOCK IN SHARE MODE', 'mysql'],
      ['SELECT name FROM users WHERE id = :id OR id = ? OR id = $1', 'postgres'],
      ['SELECT CASE WHEN id > 1 THEN name ELSE email END AS label FROM users', 'postgres'],
      ['SELECT DISTINCT ON (name) name FROM users', 'postgres'],
      ['SELECT true, false, null FROM users', 'postgres'],
      ['SELECT name FROM users GROUP BY name WITH ROLLUP', 'mysql'],
      ['SELECT array_agg(name ORDER BY id) FILTER (WHERE id > 0) FROM users', 'postgres'],
      ["SELECT name FROM users WHERE id AT TIME ZONE 'UTC' > now()", 'postgres'],
      ['SELECT nam', 'postgres'],
      ['SELECT name FROM "unterminated', 'postgres'],
    ] as const) assert.deepEqual(problems(sql, driver), [], sql);
  });

  it('does not judge columns of pre-introspected system catalogs (only common columns are listed)', async () => {
    const { systemCatalog } = await import('../src/language/systemCatalog');
    const tables = systemCatalog('postgres', []);
    for (const sql of ['SELECT relhasindex FROM pg_class', 'SELECT c.relhasindex FROM pg_catalog.pg_class c']) {
      assert.deepEqual(unresolvedReferences(splitStatements(sql, 'postgres')[0], { driver: 'postgres', tables, schema: 'public' }), [], sql);
    }
  });

  it('reports a typo once even when the INSERT/SET check also sees it', () => {
    assert.deepEqual(problems('UPDATE users SET nmae = 1'), ['nmae']);
  });
});

describe('localObjects', () => {
  it('collects CREATE TABLE / VIEW names', () => {
    const s = localObjects(splitStatements('CREATE TEMP TABLE IF NOT EXISTS a.b (x int); CREATE OR REPLACE VIEW v AS SELECT 1; CREATE INDEX i ON t(x)'));
    assert.deepEqual([...s].sort(), ['a.b', 'b', 'v']);
  });
});

describe('dialects', () => {
  it('reads MySQL backticks, H2 upper case and SQLite main', () => {
    assert.deepEqual(problems('SELECT `u`.`nam` FROM `users` `u` JOIN `nope` ON 1', 'mysql'), ['`nam`', '`nope`']);
    assert.deepEqual(problems('SELECT U.NAME FROM USERS U JOIN NOPE N ON 1=1', 'h2', 'PUBLIC'), ['NOPE']);
    assert.deepEqual(problems('INSERT INTO users (id) SELECT id FROM nope', 'sqlite'), ['nope']);
  });
});

describe('foreign keys for JOIN completion', () => {
  it('turns metadata foreign keys into join conditions, one per key, either direction', async () => {
    const { joinConditions, realForeignKeys, emptyVirtual } = await import('../src/core/virtual');
    const tables: MetaTable[] = [
      { schema: 'public', name: 'users', kind: 'table', columns: [] },
      {
        schema: 'public', name: 'orders', kind: 'table', columns: [],
        foreignKeys: [
          { columns: ['created_by'], refSchema: 'public', refTable: 'users', refColumns: ['id'] },
          { columns: ['updated_by'], refSchema: 'public', refTable: 'users', refColumns: ['id'] },
        ],
      },
    ];
    const v = { ...emptyVirtual(), foreignKeys: realForeignKeys(tables) };
    assert.deepEqual(joinConditions(v, { table: 'public.users', alias: 'u' }, { table: 'public.orders', alias: 'o' }), ['o.created_by = u.id', 'o.updated_by = u.id']);
    assert.deepEqual(joinConditions(v, { table: 'public.orders', alias: 'o' }, { table: 'PUBLIC.USERS', alias: 'u' }), ['o.created_by = u.id', 'o.updated_by = u.id']);
    assert.deepEqual(joinConditions(v, { table: 'public.users', alias: 'a' }, { table: 'public.users', alias: 'b' }), []);
  });
});
