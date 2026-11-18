import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MetaTable } from '../src/drivers/types';
import { splitStatements } from '../src/language/splitter';
import { dbObjectOf, documentSymbols, symbolAt } from '../src/language/symbols';

const TABLES: MetaTable[] = [
  { schema: 'public', name: 'users', kind: 'table', columns: [{ name: 'id' }, { name: 'name' }] },
  { schema: 'public', name: 'orders', kind: 'table', columns: [{ name: 'id' }, { name: 'user_id' }] },
  { schema: 'sales', name: 'users', kind: 'table', columns: [{ name: 'region' }] },
];
const scope = { tables: TABLES, schema: 'public' };

/** `|` 자리 이름의 key, 정의 위치의 글자, 같은 key의 위치 글자들 */
function at(sqlWithCursor: string) {
  const offset = sqlWithCursor.indexOf('|');
  const sql = sqlWithCursor.replace('|', '');
  const symbols = documentSymbols(splitStatements(sql, 'postgres'), scope);
  const occ = symbolAt(symbols, offset);
  if (!occ) return undefined;
  const same = symbols.filter((o) => o.key === occ.key);
  const decl = same.find((o) => o.decl);
  return {
    key: occ.key,
    decl: decl && `${sql.slice(decl.start, decl.end)}@${decl.start}`,
    uses: same.map((o) => `${sql.slice(o.start, o.end)}@${o.start}`),
  };
}

describe('go to declaration', () => {
  it('jumps from an alias use to its declaration, per statement', () => {
    const r = at('SELECT |u.id FROM users u; SELECT u.id FROM orders u');
    assert.equal(r?.decl, 'u@23');
    assert.deepEqual(r?.uses, ['u@7', 'u@23']);
  });

  it('jumps from a CTE use to its WITH name', () => {
    assert.equal(at('WITH x AS (SELECT 1) SELECT * FROM |x')?.decl, 'x@5');
    assert.equal(at('WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n FROM |r) SELECT * FROM r')?.decl, 'r@15');
  });

  it('jumps to CREATE TABLE / VIEW and column definitions in the same file', () => {
    const sql = 'CREATE TABLE tmp (a int, b text, PRIMARY KEY (a)); INSERT INTO tmp (|b) VALUES (1); SELECT t.a FROM tmp t';
    assert.equal(at(sql)?.decl, 'b@25');
    assert.equal(at(sql.replace('|', '').replace('t.a', 't.|a'))?.decl, 'a@18');
    assert.equal(at(sql.replace('|', '').replace('INTO tmp', 'INTO |tmp'))?.decl, 'tmp@13');
    assert.equal(at('CREATE VIEW v AS SELECT 1; SELECT * FROM |v')?.decl, 'v@12');
  });

  it('has no declaration for database-only tables, which are revealed in the explorer instead', () => {
    const r = at('SELECT * FROM |users');
    assert.equal(r?.decl, undefined);
    assert.deepEqual(dbObjectOf(r!.key, scope)?.table.schema, 'public');
    const c = at('SELECT u.na|me FROM sales.users s, users u');
    assert.deepEqual(dbObjectOf(c!.key, scope), { table: TABLES[0], column: 'name' });
  });
});

describe('find usages', () => {
  it('collects a table across statements, by bare name, schema and as qualifier', () => {
    const r = at('SELECT users.id FROM |users; UPDATE public.users SET name = 1; DELETE FROM sales.users');
    assert.deepEqual(r?.uses, ['users@7', 'users@21', 'users@42']);
  });

  it('collects a column through aliases, qualifiers and unqualified unique names', () => {
    const r = at('SELECT u.|name, name FROM users u WHERE users.name IS NULL; INSERT INTO users (name) VALUES (1)');
    assert.deepEqual(r?.uses, ['name@9', 'name@15', 'name@78']);
  });

  it('does not take ambiguous, output-alias, function or keyword words as columns', () => {
    assert.equal(at('SELECT |id FROM users, orders'), undefined);
    assert.equal(at('SELECT 1 AS |name FROM users'), undefined);
    assert.equal(at('SELECT |name(1) FROM users'), undefined);
    assert.equal(at('SELECT * FROM users WHERE id IS |NULL'), undefined);
  });

  it('collects DDL targets', () => {
    const r = at('ALTER TABLE |users ADD c int; TRUNCATE users; DROP TABLE IF EXISTS orders, users; CREATE INDEX i ON users (id)');
    assert.deepEqual(r?.uses.map((u) => u.split('@')[0]), ['users', 'users', 'users', 'users']);
  });

  it('ignores strings, comments and unclosed quotes', () => {
    assert.equal(at("SELECT '|users' FROM orders"), undefined);
    assert.equal(at('SELECT 1 -- |users'), undefined);
    assert.equal(at('SELECT * FROM "us|ers'), undefined);
  });
});

describe('scopes and statement shapes (review findings)', () => {
  it('keeps the same alias in a subquery separate from the outer one', () => {
    const outer = at('SELECT |u.id FROM users u WHERE EXISTS (SELECT 1 FROM orders u WHERE u.user_id = 1)');
    assert.equal(outer?.decl, 'u@23');
    assert.deepEqual(outer?.uses, ['u@7', 'u@23']);
    const inner = at('SELECT u.id FROM users u WHERE EXISTS (SELECT 1 FROM orders u WHERE |u.user_id = 1)');
    assert.equal(inner?.decl, 'u@60');
    assert.equal(at('SELECT u.i|d FROM users u WHERE EXISTS (SELECT 1 FROM orders u)')?.key, 'c:public.users.id');
  });

  it('a correlated subquery still sees the outer alias', () => {
    assert.equal(at('SELECT 1 FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = |u.id)')?.decl, 'u@20');
  });

  it('does not read db.schema.table names as schema.table.column', () => {
    assert.equal(at('SELECT db.pub|lic.users.id FROM db.public.users'), undefined);
    assert.equal(at('SELECT 1 FROM db.pub|lic.users'), undefined);
  });

  it('treats ORDER BY names that match an output alias as the alias', () => {
    assert.equal(at('SELECT id AS name FROM users ORDER BY |name'), undefined);
    assert.equal(at('SELECT id AS x FROM users WHERE |name IS NULL')?.key, 'c:public.users.name');
  });

  it('resolves the INSERT column list to the target table and the SELECT part to its own tables', () => {
    assert.equal(at('INSERT INTO orders (|id, user_id) SELECT id, id FROM users')?.key, 'c:public.orders.id');
    assert.equal(at('INSERT INTO orders (id, user_id) SELECT |id, id FROM users')?.key, 'c:public.users.id');
  });

  it('records MySQL DELETE targets before FROM', () => {
    assert.deepEqual(at('DELETE |u FROM users u JOIN orders o ON o.user_id = u.id')?.uses, ['u@7', 'u@20', 'u@51']);
  });

  it('does not guess a column owner when a CTE or unknown table is in the same FROM', () => {
    assert.equal(at('WITH x AS (SELECT 1) SELECT |id FROM x JOIN orders ON true'), undefined);
    assert.equal(at('SELECT |id FROM unknown_t JOIN orders ON true'), undefined);
  });
});

