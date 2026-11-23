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

/** problems와 같되 TABLES 대신 주어진 테이블로(로컬 CREATE는 보지 않는다) */
const problemsWith = (sql: string, driver: DriverId, tables: MetaTable[], schema: string) =>
  splitStatements(sql, driver).flatMap((s) => unresolvedReferences(s, { driver, tables, schema }).map((p) => sql.slice(p.start, p.end)));

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
      assert.deepEqual(problemsWith(sql, 'postgres', tables, 'public'), [], sql);
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

describe('unqualified columns: words that are not columns', () => {
  // 코드 리뷰에서 오탐으로 찾은 것들
  it('skips conflict clauses, index hints, named arguments, type and JSON words, full-text modes and column alias lists', () => {
    for (const [sql, driver] of [
      ["INSERT OR REPLACE INTO users (id, name) VALUES (1, 'a')", 'sqlite'],
      ["INSERT OR IGNORE INTO users (id) VALUES (1)", 'sqlite'],
      ["UPDATE OR ROLLBACK users SET name = 'a'", 'sqlite'],
      ['SELECT name FROM users INDEXED BY idx_users', 'sqlite'],
      ['SELECT name FROM users NOT INDEXED', 'sqlite'],
      ['SELECT name FROM users FORCE INDEX (idx_name)', 'mysql'],
      ['SELECT name FROM users USE INDEX (PRIMARY)', 'mysql'],
      ['SELECT name FROM users IGNORE INDEX FOR JOIN (ix_a, ix_b)', 'mysql'],
      ['SELECT name FROM users IGNORE KEY FOR ORDER BY (ix)', 'mysql'],
      ['SELECT make_interval(days => 3) FROM users', 'postgres'],
      ['SELECT f(a := 1) FROM users', 'postgres'],
      ["SELECT timestamp with time zone '2020-01-01', time without time zone '10:00' FROM users", 'postgres'],
      ['SELECT name FROM users WHERE name IS JSON', 'postgres'],
      ['SELECT name FROM users WHERE name IS NOT JSON', 'postgres'],
      ["SELECT name FROM users WHERE MATCH (name) AGAINST ('x' IN BOOLEAN MODE)", 'mysql'],
      ["SELECT name FROM users WHERE MATCH (name) AGAINST ('x' IN NATURAL LANGUAGE MODE)", 'mysql'],
      ['SELECT HIGH_PRIORITY name FROM users', 'mysql'],
      ['SELECT STRAIGHT_JOIN name FROM users', 'mysql'],
      ['SELECT a, b, c FROM users AS u(a, b, c)', 'postgres'],
      ['SELECT a FROM users u(a)', 'postgres'],
      ["INSERT INTO users (id, name) VALUES (1, 'a') AS n (i, m) ON DUPLICATE KEY UPDATE name = m", 'mysql'],
      ["SELECT jt.v FROM users, JSON_TABLE(users.name, '$[*]' COLUMNS (v INT PATH '$')) AS jt", 'mysql'],
      ['WITH c(a, b) AS (SELECT id, name FROM users) SELECT a, b FROM c', 'postgres'],
    ] as const) assert.deepEqual(problems(sql, driver), [], sql);
  });

  it('still reports real typos next to those words', () => {
    assert.deepEqual(problems("INSERT OR REPLACE INTO users (id, nmae) VALUES (1, 'a')", 'sqlite'), ['nmae']);
    assert.deepEqual(problems('SELECT nmae FROM users FORCE INDEX (idx_name)', 'mysql'), ['nmae']);
    assert.deepEqual(problems('SELECT make_interval(days => nope) FROM users'), ['nope']);
    // INSERT 열 목록은 별칭 목록이 아니다
    assert.deepEqual(problems("INSERT INTO users (nmae) SELECT nmae FROM users", 'postgres'), ['nmae', 'nmae']);
  });
});

describe('unqualified columns: edge cases', () => {
  it('nested correlated subqueries see every enclosing FROM, and a typo at any depth is caught', () => {
    const deep = (c: string) =>
      `SELECT id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND EXISTS (SELECT 1 FROM sales.invoices i WHERE amount > total AND ${c} IS NOT NULL))`;
    assert.deepEqual(problems(deep('email')), []);
    assert.deepEqual(problems(deep('emial')), ['emial']);
    // 안쪽 서브쿼리의 테이블은 바깥에서 보이지 않는다
    assert.deepEqual(problems('SELECT total FROM users WHERE EXISTS (SELECT 1 FROM orders)'), ['total']);
    assert.deepEqual(problems('SELECT 1 FROM users WHERE EXISTS (SELECT 1 FROM orders) AND user_id = 1'), ['user_id']);
    // 형제 서브쿼리끼리도 보이지 않는다
    assert.deepEqual(
      problems('SELECT 1 FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE total > 0) AND EXISTS (SELECT 1 FROM sales.invoices WHERE total > 0)'),
      ['total'],
    );
  });

  it('the same alias at different depths is resolved per scope for unqualified columns', () => {
    assert.deepEqual(problems('SELECT t.name FROM users t WHERE t.id IN (SELECT t.user_id FROM orders t WHERE total > 0)'), []);
    assert.deepEqual(problems('SELECT name FROM users t WHERE t.id IN (SELECT user_id FROM orders t WHERE amount > 0)'), ['amount']);
  });

  it('a derived table hides its columns from the outside but its own body is checked', () => {
    assert.deepEqual(problems('SELECT anything FROM (SELECT * FROM orders) s'), []);
    assert.deepEqual(problems('SELECT * FROM (SELECT nmae FROM users) s'), ['nmae']);
    assert.deepEqual(problems('SELECT * FROM (SELECT 1 AS x) s WHERE EXISTS (SELECT 1 FROM users WHERE x = id)'), []);
  });

  it('CTEs mixed with subqueries', () => {
    assert.deepEqual(problems('WITH users AS (SELECT 1 AS x) SELECT x FROM users'), []);
    assert.deepEqual(problems('WITH c AS (SELECT name FROM users) SELECT name FROM c WHERE name IN (SELECT email FROM users)'), []);
    assert.deepEqual(problems('WITH c AS (SELECT 1 AS x) SELECT nope FROM users WHERE EXISTS (SELECT 1 FROM c)'), ['nope']);
  });

  it('a typo inside a CTE body is caught even when the main query reads the CTE', () => {
    assert.deepEqual(problems('WITH c AS (SELECT id FROM users WHERE nmae IS NULL) SELECT * FROM c'), ['nmae']);
  });

  it('quoted identifiers: typos are caught, case follows the dialect', () => {
    assert.deepEqual(problems('SELECT "nmae" FROM users'), ['"nmae"']);
    assert.deepEqual(problems('SELECT "name" FROM "users"'), []);
    // MySQL · SQLite는 열 이름의 대소문자를 가리지 않는다
    assert.deepEqual(problems('SELECT `NAME`, `Email` FROM users', 'mysql'), []);
    assert.deepEqual(problems('SELECT "NAME", [Email] FROM users', 'sqlite'), []);
    // H2: 인용하지 않은 이름은 대문자로 접힌다(H2는 따옴표 없이 만든 열을 대문자로 저장한다)
    assert.deepEqual(problemsWith('SELECT name, "NAME" FROM users', 'h2', [tbl('PUBLIC', 'USERS', ['ID', 'NAME'])], 'PUBLIC'), []);
  });

  it('quoted identifiers in another case are different columns in PostgreSQL and H2', () => {
    assert.deepEqual(problems('SELECT "Name" FROM users'), ['"Name"']);
    assert.deepEqual(problemsWith('SELECT "name" FROM USERS', 'h2', [tbl('PUBLIC', 'USERS', ['ID', 'NAME'])], 'PUBLIC'), ['"name"']);
  });

  it('words inside comments and strings are not columns', () => {
    assert.deepEqual(problems("SELECT name /* nmae */ FROM users WHERE email = 'nmae' -- nmae\n AND name <> 'it''s nmae'"), []);
    assert.deepEqual(problems('SELECT name FROM users WHERE email = $$nmae$$ OR email = $q$ nope $q$'), []);
    assert.deepEqual(problems("SELECT name FROM users WHERE email = E'nm\\'ae'"), []);
    assert.deepEqual(problems('SELECT name FROM users WHERE email = "nmae"', 'mysql'), []);
    assert.deepEqual(problems('SELECT name FROM users # nmae\nWHERE id = 1', 'mysql'), []);
  });

  it('window functions and CASE', () => {
    assert.deepEqual(problems('SELECT sum(total) OVER (PARTITION BY user_id ORDER BY nmae) FROM orders'), ['nmae']);
    assert.deepEqual(problems('SELECT rank() OVER w FROM orders WINDOW w AS (PARTITION BY nope ORDER BY total)'), ['nope']);
    assert.deepEqual(problems('SELECT lag(total, 1) OVER (ORDER BY id RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) FROM orders'), []);
    assert.deepEqual(problems("SELECT CASE nmae WHEN 1 THEN 'a' END FROM users"), ['nmae']);
    assert.deepEqual(problems('SELECT CASE WHEN id > 0 THEN nope ELSE email END FROM users'), ['nope']);
  });

  it('INSERT … SELECT, INSERT … VALUES and RETURNING', () => {
    assert.deepEqual(problems('INSERT INTO orders (user_id, total) SELECT id, nmae FROM users'), ['nmae']);
    assert.deepEqual(problems('INSERT INTO orders (user_idd) SELECT id FROM users'), ['user_idd']);
    assert.deepEqual(problems('INSERT INTO users (id) VALUES (nope)'), ['nope']);
    assert.deepEqual(problems('DELETE FROM users WHERE id = 1 RETURNING nmae'), ['nmae']);
    assert.deepEqual(problems('INSERT INTO orders (user_id) SELECT id FROM users RETURNING total, user_id'), []);
  });

  it('UPDATE … FROM with aliases', () => {
    assert.deepEqual(problems('UPDATE users u SET name = o.total FROM orders o WHERE o.user_id = u.id AND nmae IS NULL'), ['nmae']);
    assert.deepEqual(problems('UPDATE users u SET nmae = 1 FROM orders o WHERE o.user_id = u.id'), ['nmae']);
    // SET 대상은 갱신하는 테이블의 열이어야 한다(FROM의 테이블 열이 아니라)
    assert.deepEqual(problems('UPDATE users u SET total = 1 FROM orders o WHERE o.user_id = u.id'), ['total']);
    assert.deepEqual(problems("UPDATE users u SET name = 'x' FROM orders o WHERE o.user_id = u.id AND o.nope = 1"), ['nope']);
    assert.deepEqual(problems('UPDATE users u JOIN orders o ON o.user_id = u.id SET u.name = 1, total = 2', 'mysql'), []);
  });

  it('MySQL backticks', () => {
    assert.deepEqual(problems('SELECT `u`.`name`, `nmae` FROM `users` AS `u`', 'mysql'), ['`nmae`']);
    assert.deepEqual(problems('SELECT `name` AS `label` FROM `users` ORDER BY `label`', 'mysql'), []);
  });

  it('positional and named parameters and session variables are not columns', () => {
    assert.deepEqual(problems('SELECT name FROM users WHERE id = :nmae AND email = :"x"'), []);
    assert.deepEqual(problems('SELECT name FROM users WHERE id = @nmae OR id = @@session.sql_mode', 'mysql'), []);
    assert.deepEqual(problems('SELECT name FROM users WHERE id = ?1 OR id = :1', 'sqlite'), []);
    assert.deepEqual(problems('SELECT name FROM users WHERE id = $1 AND email = $2', 'postgres'), []);
  });

  it('unfinished SQL while typing does not throw and does not flag half-written parts (more)', () => {
    for (const sql of ['WITH c AS (SELECT', 'WITH c(a, b) AS NOT MATERIALIZED (', 'SELECT * FROM users INDEXED BY', 'SELECT name FROM users USE INDEX (', 'SELECT f(a =>']) {
      assert.deepEqual(problems(sql), [], sql);
    }
  });

  it('unfinished SQL while typing does not throw and does not flag half-written parts', () => {
    for (const sql of [
      'SELECT name, FROM users',
      'SELECT FROM users WHERE',
      'SELECT * FROM users u WHERE u.',
      'SELECT * FROM users WHERE id IN (SELECT user_id FROM orders',
      'SELECT * FROM users WHERE name = (SELECT',
      'SELECT name FROM users) WHERE id = 1',
      'SELECT name FROM users WHERE name = "unterminated',
      "SELECT name FROM users WHERE name = 'unterminated",
      'UPDATE users SET',
      'INSERT INTO users (',
      'WITH c AS (',
    ]) assert.deepEqual(problems(sql), [], sql);
  });
});

describe('nonColumnPositions: each rule, and near-misses that still report typos', () => {
  it('conflict clauses only right after INSERT / UPDATE OR', () => {
    assert.deepEqual(problems('INSERT OR ABORT INTO users (id) VALUES (1)', 'sqlite'), []);
    assert.deepEqual(problems('INSERT OR IGNORE INTO users (id, nmae) VALUES (1, 2)', 'sqlite'), ['nmae']);
    // OR 뒤의 같은 단어라도 INSERT · UPDATE 바로 뒤가 아니면 열 자리다
    assert.deepEqual(problems('SELECT name FROM users WHERE id = 1 OR fail = 2', 'sqlite'), ['fail']);
    assert.deepEqual(problems('SELECT name FROM users WHERE id = 1 OR abort = 2', 'sqlite'), ['abort']);
  });

  it('UPDATE OR … and INSERT OR ABORT / FAIL / ROLLBACK still read the table, so typos and unknown tables are reported', () => {
    assert.deepEqual(problems('INSERT OR FAIL INTO users (id, nmae) VALUES (1, 2)', 'sqlite'), ['nmae']);
    assert.deepEqual(problems('INSERT OR ROLLBACK INTO nope (a) VALUES (1)', 'sqlite'), ['nope']);
    assert.deepEqual(problems('UPDATE OR ROLLBACK users SET nmae = 1', 'sqlite'), ['nmae']);
    assert.deepEqual(problems("UPDATE OR FAIL users SET name = 'a' WHERE nope = 1", 'sqlite'), ['nope']);
    assert.deepEqual(problems('UPDATE OR IGNORE nope SET a = 1', 'sqlite'), ['nope']);
  });

  it('MySQL REPLACE INTO does not report the REPLACE keyword as a column', () => {
    assert.deepEqual(problems('REPLACE INTO users (id) VALUES (1)', 'mysql'), []);
    assert.deepEqual(problems('REPLACE INTO users (nmae) VALUES (1)', 'mysql'), ['nmae']);
    assert.deepEqual(problems('REPLACE INTO users SET name = 1', 'mysql'), []);
  });

  it('INDEXED BY / NOT INDEXED only in that form', () => {
    assert.deepEqual(problems('SELECT name FROM users INDEXED BY idx WHERE nmae = 1', 'sqlite'), ['nmae']);
    assert.deepEqual(problems('SELECT name FROM users NOT INDEXED WHERE nope = 1', 'sqlite'), ['nope']);
    // INDEXED만 있으면 열 이름 자리다
    assert.deepEqual(problems('SELECT indexed FROM users', 'sqlite'), ['indexed']);
  });

  it('MySQL index hints: every FOR form, the names are skipped but the rest is checked', () => {
    for (const hint of ['USE INDEX (ix)', 'USE KEY (ix)', 'IGNORE INDEX FOR ORDER BY (ix, iy)', 'USE INDEX FOR GROUP BY (ix)', 'USE INDEX ()']) {
      assert.deepEqual(problems(`SELECT name FROM users ${hint} WHERE id = 1`, 'mysql'), [], hint);
      assert.deepEqual(problems(`SELECT name FROM users ${hint} WHERE nmae = 1`, 'mysql'), ['nmae'], hint);
    }
    assert.deepEqual(problems('SELECT name FROM users FORCE INDEX FOR JOIN (ix) WHERE id = 1', 'mysql'), []);
  });

  it('an index hint FOR JOIN (…) does not hide typos in the rest of the query', () => {
    assert.deepEqual(problems('SELECT name FROM users FORCE INDEX FOR JOIN (ix) WHERE nmae = 1', 'mysql'), ['nmae']);
    assert.deepEqual(problems('SELECT name FROM users IGNORE INDEX FOR JOIN (ix) WHERE nmae = 1', 'mysql'), ['nmae']);
  });

  it('named arguments: => and := (also split into two adjacent tokens), not = > with a space', () => {
    assert.deepEqual(problems('SELECT make_interval(days => 3, hours => id) FROM users'), []);
    assert.deepEqual(problems('SELECT f(a := nope) FROM users'), ['nope']);
    assert.deepEqual(problems('SELECT f(days => 3) FROM users', 'mysql'), []);
    // = 와 > 가 떨어져 있으면 비교식이다(이름 붙인 인자가 아니다)
    assert.deepEqual(problems('SELECT name FROM users WHERE nmae = > 1', 'mysql'), ['nmae']);
  });

  it('TIMESTAMP / TIME WITH[OUT] TIME ZONE, IS [NOT] JSON — the bare words are still column positions', () => {
    assert.deepEqual(problems("SELECT CAST(name AS timestamp without time zone), time with time zone '10:00' FROM users"), []);
    assert.deepEqual(problems('SELECT json FROM users'), ['json']);
    assert.deepEqual(problems('SELECT name FROM users WHERE nmae IS JSON'), ['nmae']);
    assert.deepEqual(problems('SELECT name FROM users WHERE name IS NOT JSON AND nope = 1'), ['nope']);
  });

  it('full-text MODE words are skipped, a typo just before AGAINST is not', () => {
    assert.deepEqual(problems("SELECT name FROM users WHERE MATCH (nmae) AGAINST ('x' IN BOOLEAN MODE)", 'mysql'), ['nmae']);
    assert.deepEqual(problems("SELECT name FROM users WHERE MATCH (name) AGAINST ('x' WITH QUERY EXPANSION) AND nope = 1", 'mysql'), ['nope']);
  });

  it('a column aliased "mode" without AS is still checked', () => {
    assert.deepEqual(problems('SELECT nmae mode FROM users'), ['nmae']);
    assert.deepEqual(problems("SELECT name FROM users WHERE MATCH (name) AGAINST ('x' IN NATURAL LANGUAGE MODE)", 'mysql'), []);
  });

  it('types and character sets are not columns: CONVERT(x, type), CHARACTER SET, RETURNING type in a function; PARTITION (…); U&', () => {
    for (const type of ['SIGNED', 'UNSIGNED', 'CHAR', 'DATE', 'DATETIME', 'INT', 'DECIMAL(10, 2)', 'CHAR(10) CHARACTER SET utf8mb4']) {
      assert.deepEqual(problems(`SELECT CONVERT(name, ${type}) FROM users`, 'mysql'), [], type);
      assert.deepEqual(problems(`SELECT CONVERT(nmae, ${type}) FROM users`, 'mysql'), ['nmae'], type);
    }
    assert.deepEqual(problems('SELECT CONVERT(name, INT) FROM users', 'h2'), []);
    // PostgreSQL convert(bytes, 원본, 대상)는 모두 식이다
    assert.deepEqual(problems('SELECT convert(name, nope, id) FROM users'), ['nope']);
    assert.deepEqual(problems('SELECT CAST(name AS CHAR CHARACTER SET utf8mb4) FROM users', 'mysql'), []);
    assert.deepEqual(problems('SELECT name FROM users PARTITION (p0, p1) WHERE nmae = 1', 'mysql'), ['nmae']);
    assert.deepEqual(problems("SELECT json_value(name, '$.a' RETURNING int) FROM users"), []);
    // DML의 RETURNING 뒤는 열이다
    assert.deepEqual(problems('UPDATE users SET name = 1 RETURNING nmae'), ['nmae']);
    assert.deepEqual(problems("SELECT name FROM users WHERE name = U&'d\\0061t'"), []);
    assert.deepEqual(problems('SELECT u FROM users'), ['u']);
  });

  it('JSON_TABLE COLUMNS skips the column definitions (nested too)', () => {
    assert.deepEqual(
      problems("SELECT jt.v FROM users, JSON_TABLE(users.name, '$' COLUMNS (v INT PATH '$.v', NESTED PATH '$.n[*]' COLUMNS (w INT PATH '$'))) AS jt", 'mysql'),
      [],
    );
  });

  it('column alias lists: AS t(a, b), WITH c(a), VALUES … AS n(i) — but an INSERT column list is checked', () => {
    assert.deepEqual(problems('SELECT a, nmae FROM users AS u(a, b, c)'), ['nmae']);
    assert.deepEqual(problems('WITH c(a) AS (SELECT nmae FROM users) SELECT a FROM c'), ['nmae']);
    assert.deepEqual(problems('INSERT INTO public.users (id, nmae) VALUES (1, 2)'), ['nmae']);
    assert.deepEqual(problems('INSERT INTO users(nmae) VALUES (1)'), ['nmae']);
  });
});

describe('CTE body isolation', () => {
  it('a CTE body does not see the main query FROM', () => {
    assert.deepEqual(problems('WITH a AS (SELECT total FROM users) SELECT * FROM orders, a'), ['total']);
    assert.deepEqual(problems('WITH c(x) AS (SELECT total FROM users) SELECT * FROM orders, c'), ['total']);
  });

  it('a CTE inside a subquery still sees the outer query (only the query that owns the WITH is hidden)', () => {
    assert.deepEqual(problems('SELECT name FROM users WHERE EXISTS (WITH c AS (SELECT 1 FROM orders WHERE total = length(name)) SELECT 1 FROM c)'), []);
    assert.deepEqual(problems('SELECT name FROM users WHERE EXISTS (WITH c AS (SELECT 1 FROM orders WHERE total = length(nmae)) SELECT 1 FROM c)'), ['nmae']);
    // WITH가 붙은 서브쿼리 자신의 FROM(orders)은 본문에서 보이지 않는다
    assert.deepEqual(problems('SELECT name FROM users WHERE EXISTS (WITH c AS (SELECT total FROM users) SELECT 1 FROM orders, c)'), ['total']);
  });

  it('AS [NOT] MATERIALIZED bodies are read like plain CTE bodies', () => {
    assert.deepEqual(problems('WITH c(x) AS NOT MATERIALIZED (SELECT name FROM users) SELECT * FROM orders, c'), []);
    assert.deepEqual(problems('WITH c AS NOT MATERIALIZED (SELECT name FROM users) SELECT * FROM c'), []);
    assert.deepEqual(problems('WITH c AS MATERIALIZED (SELECT total FROM users) SELECT * FROM orders, c'), ['total']);
    assert.deepEqual(problems('WITH c AS MATERIALIZED (SELECT 1 FROM nope) SELECT * FROM c'), ['nope']);
  });

  it('nested CTEs: the inner body sees neither the outer CTE query nor the main query', () => {
    assert.deepEqual(problems('WITH a AS (WITH b AS (SELECT nmae FROM users) SELECT 1 AS x FROM b) SELECT * FROM a'), ['nmae']);
    assert.deepEqual(problems('WITH a AS (WITH b AS (SELECT total FROM users) SELECT id FROM orders) SELECT total FROM orders, a'), ['total']);
    assert.deepEqual(problems('WITH a AS (WITH b AS (SELECT id FROM users) SELECT id, total FROM orders) SELECT * FROM a'), []);
  });

  it('recursive CTEs: the self reference has unknown columns, the main query is still checked', () => {
    assert.deepEqual(problems('WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 10) SELECT n FROM r'), []);
    assert.deepEqual(problems('WITH RECURSIVE r AS (SELECT id FROM users UNION ALL SELECT anything FROM r) SELECT * FROM r'), []);
    assert.deepEqual(problems('WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t) SELECT nmae FROM users WHERE id IN (SELECT n FROM t)'), ['nmae']);
    assert.deepEqual(problems('WITH RECURSIVE r AS (SELECT id FROM users UNION ALL SELECT r.id FROM r JOIN orders o ON o.user_idx = r.id) SELECT * FROM r'), ['user_idx']);
  });

  it('CTEs that read earlier CTEs', () => {
    assert.deepEqual(problems('WITH a AS (SELECT id FROM users), b AS (SELECT anything FROM a) SELECT * FROM b'), []);
    assert.deepEqual(problems('WITH a AS (SELECT id FROM users), b AS (SELECT id FROM a) SELECT nmae FROM users'), ['nmae']);
    // b의 본문은 a를 보지만 본 쿼리의 orders는 보지 못한다
    assert.deepEqual(problems('WITH a AS (SELECT id FROM users), b AS (SELECT total FROM users) SELECT * FROM orders, a, b'), ['total']);
    assert.deepEqual(problems('WITH a AS (SELECT 1 AS x), b AS (SELECT total, x FROM a, users) SELECT * FROM b'), []);
    assert.deepEqual(problems('WITH a AS (SELECT id FROM users), b AS (SELECT a.id FROM a), c AS (SELECT b.id FROM b JOIN orders o ON o.nope = b.id) SELECT * FROM c'), ['nope']);
  });
});

describe('quoted identifier case per driver (qualified, unqualified, INSERT list, UPDATE SET)', () => {
  it('PostgreSQL: a quoted name must match exactly, an unquoted one is compared without case', () => {
    const t = [tbl('public', 'people', ['id', 'Name'])];
    const pg = (sql: string) => problemsWith(sql, 'postgres', t, 'public');
    assert.deepEqual(pg('SELECT p."Name", "Name" FROM people p'), []);
    assert.deepEqual(pg('SELECT p."name" FROM people p'), ['"name"']);
    assert.deepEqual(pg('SELECT p."NAME" FROM people p'), ['"NAME"']);
    assert.deepEqual(pg('SELECT "name" FROM people'), ['"name"']);
    assert.deepEqual(pg('SELECT p.name, name, NAME FROM people p'), []);
    assert.deepEqual(pg('INSERT INTO people ("Name", "ID") VALUES (1, 2)'), ['"ID"']);
    assert.deepEqual(pg('INSERT INTO people (id, name) VALUES (1, 2)'), []);
    assert.deepEqual(pg('UPDATE people SET "name" = 1, "Name" = 2'), ['"name"']);
    assert.deepEqual(pg('UPDATE people p SET "Name" = 1 WHERE p."Id" = 1'), ['"Id"']);
  });

  it('H2: unquoted names fold, quoted ones are exact (upper case and mixed case columns)', () => {
    const t = [tbl('PUBLIC', 'PEOPLE', ['ID', 'NAME', 'MixedCase'])];
    const h2 = (sql: string) => problemsWith(sql, 'h2', t, 'PUBLIC');
    assert.deepEqual(h2('SELECT p.name, p."NAME", "MixedCase", name FROM people p'), []);
    assert.deepEqual(h2('SELECT p."name", "MIXEDCASE" FROM people p'), ['"name"', '"MIXEDCASE"']);
    assert.deepEqual(h2('INSERT INTO people ("ID", "mixedcase") VALUES (1, 2)'), ['"mixedcase"']);
    assert.deepEqual(h2('UPDATE people SET "Name" = 1, mixedcase = 2'), ['"Name"']);
  });

  it('MySQL: backticked names in any case are the same column; typos are still caught', () => {
    const t = [tbl('shop', 'people', ['id', 'Name'])];
    const my = (sql: string) => problemsWith(sql, 'mysql', t, 'shop');
    assert.deepEqual(my('SELECT p.`NAME`, `name`, p.name FROM people p'), []);
    assert.deepEqual(my('SELECT p.`nmae` FROM people p'), ['`nmae`']);
    assert.deepEqual(my('INSERT INTO people (`ID`, `NAME`) VALUES (1, 2)'), []);
    assert.deepEqual(my('INSERT INTO people (`ID`, `nmae`) VALUES (1, 2)'), ['`nmae`']);
    assert.deepEqual(my('UPDATE people SET `NAME` = 1, `nmae` = 2'), ['`nmae`']);
  });

  it('SQLite: "x", [x] and `x` in any case are the same column; typos are still caught', () => {
    const t = [tbl('main', 'people', ['id', 'Name'])];
    const lite = (sql: string) => problemsWith(sql, 'sqlite', t, 'main');
    assert.deepEqual(lite('SELECT p."NAME", p.[name], p.`NaMe`, "name" FROM people p'), []);
    assert.deepEqual(lite('SELECT p."nmae" FROM people p'), ['"nmae"']);
    assert.deepEqual(lite('INSERT INTO people ("ID", [NAME]) VALUES (1, 2)'), []);
    assert.deepEqual(lite('INSERT INTO people ([nmae]) VALUES (1)'), ['[nmae]']);
    assert.deepEqual(lite('UPDATE people SET "NAME" = 1, `nmae` = 2'), ['`nmae`']);
  });
});

describe('unqualified columns: more edge cases of the recent fixes', () => {
  const MAIN = [tbl('main', 'users', ['id', 'name', 'email']), tbl('main', 'orders', ['id', 'user_id', 'total'])];
  const lite = (sql: string) => problemsWith(sql, 'sqlite', MAIN, 'main');

  it('CONVERT(x, type): only the part after the first top-level comma is a type, and only in MySQL / H2', () => {
    assert.deepEqual(problems('SELECT CONVERT(CONCAT(name, email), CHAR) FROM users', 'mysql'), []);
    // 안쪽 괄호의 쉼표는 타입의 시작이 아니다
    assert.deepEqual(problems('SELECT CONVERT(CONCAT(name, nmae), CHAR) FROM users', 'mysql'), ['nmae']);
    // CONVERT 괄호 밖은 다시 열 자리다
    assert.deepEqual(problems('SELECT name FROM users WHERE CONVERT(name, CHAR) = nmae', 'mysql'), ['nmae']);
    assert.deepEqual(problems('SELECT CONVERT(name, CHAR(10)), nmae FROM users', 'mysql'), ['nmae']);
    assert.deepEqual(problems('SELECT convert(name, char), CONVERT(name, SIGNED INTEGER), CONVERT(name, BINARY(4)) FROM users', 'mysql'), []);
    assert.deepEqual(problems('SELECT CONVERT(name USING utf8mb4) FROM users', 'mysql'), []);
    assert.deepEqual(problems('SELECT CONVERT(nmae, INT), CONVERT(name, VARCHAR(10)) FROM users', 'h2'), ['nmae']);
    // SQLite · PostgreSQL에서는 두 번째 인자도 식이다
    assert.deepEqual(lite('SELECT CONVERT(name, nope) FROM users'), ['nope']);
    assert.deepEqual(problems('SELECT CONVERT(name, CHAR) FROM users'), ['CHAR']);
  });

  it('CHARACTER SET / CHARSET names are skipped, the rest of the expression is checked', () => {
    assert.deepEqual(problems('SELECT CAST(name AS CHAR CHARSET utf8mb4) FROM users', 'mysql'), []);
    assert.deepEqual(problems('SELECT CAST(name AS CHAR(5) CHARACTER SET latin1) = nmae FROM users', 'mysql'), ['nmae']);
    assert.deepEqual(problems('SELECT CAST(name AS CHAR CHARACTER SET utf8mb4), nope FROM users', 'mysql'), ['nope']);
    assert.deepEqual(problems("SELECT name FROM users WHERE name = _utf8mb4'x' COLLATE utf8mb4_bin", 'mysql'), []);
    assert.deepEqual(problems('SELECT CHAR(65 USING utf8mb4) FROM users', 'mysql'), []);
    // CHARACTER로 시작하는 열 이름은 열이다
    assert.deepEqual(problems('SELECT name FROM users WHERE character_set_name = 1', 'mysql'), ['character_set_name']);
  });

  it('PARTITION (…) after a table: aliases and JOINs after it still work', () => {
    assert.deepEqual(problems('SELECT * FROM users PARTITION (p0, p1) u JOIN orders PARTITION (p2) o ON o.user_id = u.id WHERE total > 0', 'mysql'), []);
    assert.deepEqual(problems('SELECT * FROM users PARTITION (p0) AS u WHERE nmae = 1', 'mysql'), ['nmae']);
    assert.deepEqual(problems('SELECT * FROM users PARTITION (p0) JOIN nope ON 1', 'mysql'), ['nope']);
  });

  it('a comma-joined table after an index hint, PARTITION or INDEXED BY is a table, not a column', () => {
    assert.deepEqual(problems('SELECT name FROM users USE INDEX (ix), orders WHERE total > 0', 'mysql'), []);
    assert.deepEqual(problems('SELECT name FROM users FORCE INDEX FOR JOIN (ix), orders o WHERE total > 0', 'mysql'), []);
    assert.deepEqual(problems('SELECT name FROM users PARTITION (p0), orders WHERE total > 0', 'mysql'), []);
    assert.deepEqual(lite('SELECT name FROM users INDEXED BY ix, orders WHERE total > 0'), []);
    assert.deepEqual(lite('SELECT name FROM users NOT INDEXED, orders WHERE total > 0'), []);
  });

  it('index hints FOR JOIN: a JOIN after the hint is still a table position, several hints in a row', () => {
    assert.deepEqual(problems('SELECT name FROM users USE INDEX FOR JOIN (ix) JOIN orders ON orders.user_id = users.id WHERE total > 0', 'mysql'), []);
    assert.deepEqual(problems('SELECT name FROM users USE INDEX FOR JOIN (ix) JOIN nope ON 1', 'mysql'), ['nope']);
    assert.deepEqual(problems('SELECT name FROM users FORCE KEY FOR JOIN (ix) WHERE nmae = 1', 'mysql'), ['nmae']);
    assert.deepEqual(problems('SELECT name FROM users USE INDEX (a) IGNORE INDEX FOR ORDER BY (b) WHERE nmae = 1', 'mysql'), ['nmae']);
    assert.deepEqual(problems('SELECT name FROM users u USE INDEX FOR JOIN (ix) JOIN orders o FORCE INDEX FOR JOIN (iy) ON o.user_id = u.id WHERE totl > 0', 'mysql'), ['totl']);
  });

  it('RETURNING: a type inside a function call, columns after DML RETURNING (also inside CTE bodies)', () => {
    assert.deepEqual(problems("SELECT json_value(name, '$.a' RETURNING double precision), json_value(name, '$.b' RETURNING varchar(10)) FROM users"), []);
    assert.deepEqual(problems("SELECT json_query(name, '$' RETURNING jsonb WITH WRAPPER) FROM users"), []);
    assert.deepEqual(problems("SELECT json_value(nmae, '$.a' RETURNING int) FROM users"), ['nmae']);
    assert.deepEqual(problems("SELECT json_value(name, '$.a' RETURNING int), nmae FROM users"), ['nmae']);
    assert.deepEqual(problems('INSERT INTO users (id) VALUES (1) RETURNING nmae'), ['nmae']);
    // CTE 본문의 ( 앞은 AS · MATERIALIZED라 함수 괄호가 아니다
    assert.deepEqual(problems('WITH x AS (INSERT INTO users (id) VALUES (1) RETURNING nmae) SELECT * FROM x'), ['nmae']);
    assert.deepEqual(problems('WITH x AS NOT MATERIALIZED (DELETE FROM users RETURNING nmae) SELECT * FROM x'), ['nmae']);
    assert.deepEqual(problems('WITH x AS MATERIALIZED (DELETE FROM users RETURNING nmae) SELECT * FROM x'), ['nmae']);
    assert.deepEqual(problems('WITH x(a) AS (DELETE FROM users RETURNING nmae) SELECT a FROM x'), ['nmae']);
    assert.deepEqual(lite('INSERT OR ROLLBACK INTO users (id) VALUES (1) RETURNING nmae'), ['nmae']);
  });

  it('JSON_VALUE / JSON_EXISTS … ON EMPTY / ON ERROR words are not columns', () => {
    assert.deepEqual(problems("SELECT json_value(name, '$.a' RETURNING int NULL ON EMPTY) FROM users"), []);
    assert.deepEqual(problems("SELECT json_value(name, '$.a' RETURNING int DEFAULT 0 ON ERROR) FROM users"), []);
    assert.deepEqual(problems("SELECT json_value(name, '$.a' NULL ON EMPTY) FROM users"), []);
    assert.deepEqual(problems("SELECT json_exists(name, '$.a' FALSE ON ERROR) FROM users"), []);
    assert.deepEqual(problems("SELECT JSON_VALUE(name, '$.a' RETURNING DECIMAL(4,2) NULL ON EMPTY DEFAULT 0 ON ERROR) FROM users", 'mysql'), []);
  });

  it("U&'…': only the U right before an adjacent &' is skipped", () => {
    assert.deepEqual(problems("SELECT name FROM users WHERE name = U&'d!0061t' UESCAPE '!'"), []);
    assert.deepEqual(problems("SELECT name FROM users WHERE name = u&'x'"), []);
    assert.deepEqual(problems("SELECT name FROM users WHERE name = U&'x' AND nmae = 1"), ['nmae']);
    // 띄어 쓰면 열 u와 & 연산이다
    assert.deepEqual(problems("SELECT name FROM users WHERE name = U & 'x'"), ['U']);
  });

  it('writable CTEs: (UPDATE t SET …) reads the table, so SET targets are checked against it', () => {
    assert.deepEqual(problems('WITH x AS (UPDATE users SET name = 1 RETURNING id) SELECT * FROM x'), []);
    assert.deepEqual(problems('WITH x AS (UPDATE users SET name = 1 RETURNING nmae) SELECT * FROM x'), ['nmae']);
    assert.deepEqual(problems('WITH x AS (UPDATE users SET nmae = 1 WHERE id = 2) SELECT * FROM x'), ['nmae']);
    assert.deepEqual(problems('WITH x AS (UPDATE nope SET a = 1) SELECT * FROM x'), ['nope']);
    assert.deepEqual(problems('WITH x AS MATERIALIZED (UPDATE users SET name = 1 RETURNING id) SELECT * FROM x'), []);
    // FOR UPDATE · ON CONFLICT DO UPDATE 는 테이블 자리가 아니다
    assert.deepEqual(problems('SELECT name FROM users FOR UPDATE'), []);
    assert.deepEqual(problems('INSERT INTO users (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET name = 1'), []);
  });

  it('U&"…" quoted identifiers with escapes are not reported as unknown columns', () => {
    assert.deepEqual(problems('SELECT U&"n\\0061me" FROM users'), []);
  });

  it('more words that are not columns: STRAIGHT_JOIN tables, SQL/JSON ON clauses, DISTINCTROW, EXTRACT / GET_FORMAT / XMLELEMENT, NORMALIZED, COLLATION FOR, TOP, SQLite $name', () => {
    assert.deepEqual(problems('SELECT total FROM users STRAIGHT_JOIN orders ON orders.user_id = users.id', 'mysql'), []);
    assert.deepEqual(problems('SELECT totl FROM users STRAIGHT_JOIN orders ON orders.user_id = users.id', 'mysql'), ['totl']);
    assert.deepEqual(problems('SELECT STRAIGHT_JOIN name FROM users WHERE nmae = 1', 'mysql'), ['nmae']);
    assert.deepEqual(problems("SELECT JSON_VALUE(name, '$.a' DEFAULT 0 ON EMPTY) FROM users", 'mysql'), []);
    assert.deepEqual(problems("SELECT json_query(name, '$' OMIT QUOTES ON SCALAR STRING) FROM users"), []);
    // 함수 밖의 ON 뒤는 열이다
    assert.deepEqual(problems('SELECT name FROM users JOIN orders ON error = 1'), ['error']);
    assert.deepEqual(problems('SELECT DISTINCTROW name FROM users', 'mysql'), []);
    assert.deepEqual(problems('SELECT DISTINCTROW nmae FROM users', 'mysql'), ['nmae']);
    assert.deepEqual(problems('SELECT EXTRACT(julian FROM id) FROM users'), []);
    assert.deepEqual(problems("SELECT GET_FORMAT(DATE, 'USA') FROM users", 'mysql'), []);
    assert.deepEqual(problems('SELECT XMLELEMENT(NAME foo, id) FROM users'), []);
    assert.deepEqual(problems('SELECT XMLELEMENT(NAME foo, nmae) FROM users'), ['nmae']);
    assert.deepEqual(problems('SELECT name FROM users WHERE name IS NFC NORMALIZED AND name IS NOT NORMALIZED'), []);
    assert.deepEqual(problems('SELECT normalize(name, NFKC) FROM users'), []);
    assert.deepEqual(problems('SELECT COLLATION FOR (name) FROM users'), []);
    assert.deepEqual(problems('SELECT TOP 10 id FROM users', 'h2'), []);
    assert.deepEqual(problems('SELECT top FROM users', 'h2'), ['top']);
    assert.deepEqual(lite('SELECT id FROM users WHERE name = $q AND nmae = 1'), ['nmae']);
  });

  it('full-text: IN NATURAL LANGUAGE MODE WITH QUERY EXPANSION; BOOLEAN / LANGUAGE elsewhere are column positions', () => {
    assert.deepEqual(problems("SELECT name FROM users WHERE MATCH (name) AGAINST ('x' IN NATURAL LANGUAGE MODE WITH QUERY EXPANSION)", 'mysql'), []);
    assert.deepEqual(problems("SELECT name FROM users WHERE MATCH (name) AGAINST (nmae IN BOOLEAN MODE)", 'mysql'), ['nmae']);
    assert.deepEqual(problems('SELECT language FROM users', 'mysql'), ['language']);
    assert.deepEqual(problems('SELECT boolean FROM users', 'mysql'), ['boolean']);
    assert.deepEqual(problems('SELECT name FROM users WHERE name IN (boolean)', 'mysql'), ['boolean']);
  });

  it('CTE visibility with INSERT / UPDATE / DELETE: the body never sees the DML target or its FROM / USING', () => {
    assert.deepEqual(problems('WITH c AS (SELECT total FROM users) INSERT INTO orders (user_id) SELECT 1 FROM c'), ['total']);
    assert.deepEqual(problems('WITH c AS (SELECT user_id FROM users) INSERT INTO orders (user_id) SELECT 1 FROM c'), ['user_id']);
    assert.deepEqual(problems('INSERT INTO orders (user_id) WITH c AS (SELECT total FROM users) SELECT 1 FROM c'), ['total']);
    assert.deepEqual(problems('WITH c AS (SELECT total FROM users) UPDATE orders SET total = 1 FROM c'), ['total']);
    assert.deepEqual(problems('WITH c AS (SELECT total FROM users) DELETE FROM orders USING c'), ['total']);
  });

  it('CTE visibility: a WITH in a scalar subquery, a LATERAL or an IN (…) sees the outer query', () => {
    assert.deepEqual(problems('SELECT (WITH c AS (SELECT total) SELECT 1 FROM c) FROM orders'), []);
    assert.deepEqual(problems('SELECT (WITH c AS (SELECT nmae) SELECT 1 FROM c) FROM users'), ['nmae']);
    assert.deepEqual(problems('SELECT * FROM users, LATERAL (WITH c AS (SELECT email) SELECT * FROM c) x'), []);
    assert.deepEqual(problems('SELECT * FROM users u WHERE id IN (WITH c AS (SELECT user_id FROM orders WHERE email > 0) SELECT user_id FROM c)'), []);
    // 바깥 CTE 쿼리의 FROM(c)은 열을 모르는 원본이라 판정하지 않는다
    assert.deepEqual(problems('WITH c AS (SELECT name FROM users) SELECT name FROM c WHERE EXISTS (WITH d AS (SELECT total FROM orders WHERE email = 1) SELECT 1 FROM d)'), []);
    // 서브쿼리의 WITH 본문은 그 서브쿼리 자신의 FROM(invoices)을 보지 못한다
    assert.deepEqual(problems('SELECT name FROM users WHERE EXISTS (WITH d AS (SELECT amount FROM orders) SELECT 1 FROM d, sales.invoices)'), ['amount']);
    // CTE 본문 안의 서브쿼리는 본문의 FROM을 보지만 본 쿼리의 FROM은 보지 못한다
    assert.deepEqual(problems('WITH c AS (SELECT * FROM users WHERE id IN (SELECT user_id FROM orders WHERE total > 0 AND email IS NULL)) SELECT * FROM c'), []);
    assert.deepEqual(problems('WITH c AS (SELECT * FROM users WHERE id IN (SELECT user_id FROM orders WHERE amount > 0)) SELECT * FROM sales.invoices, c'), ['amount']);
  });

  it('[NOT] MATERIALIZED: mixed with plain CTEs, lower case, and with a column alias list', () => {
    assert.deepEqual(problems('WITH a AS (SELECT id FROM users), b AS MATERIALIZED (SELECT total FROM users) SELECT * FROM orders, a, b'), ['total']);
    assert.deepEqual(problems('WITH a AS MATERIALIZED (SELECT id FROM users), b AS NOT MATERIALIZED (SELECT nope FROM a, orders) SELECT * FROM b'), []);
    assert.deepEqual(problems('WITH c AS materialized (SELECT name FROM users) SELECT * FROM c'), []);
    assert.deepEqual(problems('WITH c(x, y) AS MATERIALIZED (SELECT id, name FROM users) SELECT x, y FROM c'), []);
    assert.deepEqual(problems('WITH c(x) AS MATERIALIZED (SELECT nmae FROM users) SELECT x FROM c'), ['nmae']);
  });

  it('UPDATE OR <conflict> / INSERT OR <conflict> INTO with a schema, an alias, FROM and subqueries', () => {
    assert.deepEqual(lite('UPDATE OR ABORT main.users SET nmae = 1'), ['nmae']);
    assert.deepEqual(lite('INSERT OR REPLACE INTO main.users (nmae) VALUES (1)'), ['nmae']);
    assert.deepEqual(lite('UPDATE OR REPLACE main.users AS u SET name = 1 WHERE nope = 1'), ['nope']);
    assert.deepEqual(lite('UPDATE OR REPLACE users AS u SET name = 1 WHERE u.nmae = 1'), ['nmae']);
    assert.deepEqual(lite('UPDATE OR FAIL users SET name = total FROM orders WHERE user_id = users.id'), []);
    assert.deepEqual(lite('UPDATE OR REPLACE users SET nmae = 1 WHERE id IN (SELECT user_id FROM orders WHERE totl > 0)'), ['nmae', 'totl']);
    assert.deepEqual(lite('update or ignore users set nmae = 1'), ['nmae']);
    assert.deepEqual(lite('insert or fail into nope (a) values (1)'), ['nope']);
    assert.deepEqual(lite('INSERT OR ABORT INTO users (id) SELECT nmae FROM users'), ['nmae']);
    // 충돌 처리 단어가 아닌 OR_X 같은 열은 열이다
    assert.deepEqual(lite('UPDATE OR IGNORE users SET name = 1 WHERE or_x = 1'), ['or_x']);
    assert.deepEqual(problems('INSERT IGNORE INTO users (nmae) VALUES (1)', 'mysql'), ['nmae']);
  });

  it('half-written conflict clauses do not throw or report', () => {
    for (const sql of ['UPDATE OR users SET name = 1', 'INSERT OR INTO users (id) VALUES (1)', 'UPDATE OR', 'INSERT OR ABORT']) assert.deepEqual(lite(sql), [], sql);
  });

  it('the first token is never a column, but a typo right after it is', () => {
    assert.deepEqual(problems('REPLACE INTO users (id) SELECT nmae FROM users', 'mysql'), ['nmae']);
    assert.deepEqual(problems('REPLACE users SET name = 1', 'mysql'), []);
    assert.deepEqual(problems('(SELECT nmae FROM users)'), ['nmae']);
    assert.deepEqual(problems('((SELECT name FROM users) UNION (SELECT nmae FROM users))'), ['nmae']);
    assert.deepEqual(problems('SELECT nmae FROM users'), ['nmae']);
  });
});
