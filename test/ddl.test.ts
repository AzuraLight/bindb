import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ddlFor, ddlPath, diffSchemas, migrationSql, parseDdl } from '../src/core/ddl';

describe('DDL data source', () => {
  it('parses CREATE TABLE and CREATE VIEW', () => {
    const t = parseDdl(
      `CREATE TABLE IF NOT EXISTS sales."order items" (
         id bigint PRIMARY KEY,
         price numeric(10, 2) NOT NULL DEFAULT 0,
         "note, text" varchar(20),
         CONSTRAINT fk FOREIGN KEY (id) REFERENCES x(id)
       );
       create view v as select 1;
       insert into t values (1);`,
      'public',
    );
    assert.equal(t.length, 2);
    assert.deepEqual([t[0].schema, t[0].name, t[0].kind], ['sales', 'order items', 'table']);
    assert.deepEqual(t[0].columns, [
      { name: 'id', type: 'bigint' },
      { name: 'price', type: 'numeric(10, 2)' },
      { name: 'note, text', type: 'varchar(20)' },
    ]);
    assert.deepEqual([t[1].schema, t[1].name, t[1].kind, t[1].definition], ['public', 'v', 'view', 'select 1']);
  });

  it('round-trips generated DDL', () => {
    const table = { schema: 'app', name: 'users', kind: 'table' as const, columns: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }] };
    assert.deepEqual(parseDdl(ddlFor('postgres', table), 'public'), [table]);
    assert.equal(ddlPath('postgres', table), 'app/users.sql');
    assert.equal(ddlPath('sqlite', table), 'users.sql');
  });

  it('diffs and builds a migration (drops stay commented)', () => {
    const db = parseDdl('create table a (id int, old text); create table gone (x int);', 'public');
    const ddl = parseDdl('create table a (id bigint, fresh text); create table b (y int);', 'public');
    const d = diffSchemas(db, ddl);
    assert.deepEqual(d.onlyInDdl.map((t) => t.name), ['b']);
    assert.deepEqual(d.onlyInSource.map((t) => t.name), ['gone']);
    assert.deepEqual([d.changed[0].added, d.changed[0].removed, d.changed[0].retyped], [['fresh'], ['old'], ['id']]);
    const sql = migrationSql('postgres', d);
    assert.match(sql, /CREATE TABLE "public"\."b"/);
    assert.match(sql, /ADD COLUMN "fresh" text;/);
    assert.match(sql, /ALTER COLUMN "id" TYPE bigint;/);
    assert.match(sql, /^-- ALTER TABLE "public"\."a" DROP COLUMN "old";$/m);
    assert.match(sql, /^-- DROP TABLE "public"\."gone";$/m);
    assert.deepEqual(diffSchemas(db, ddl, ['other']), { onlyInSource: [], onlyInDdl: [], changed: [] });
  });
});

describe('Code style', () => {
  it('controls keyword case and identifier quoting in generated SQL', async () => {
    const { withCodeStyle } = await import('../src/core/ddl');
    const t = { schema: 'app', name: 'users', kind: 'table' as const, columns: [{ name: 'id', type: 'integer' }, { name: 'order', type: 'text' }] };
    const out = withCodeStyle({ keywordCase: 'lower', quoteIdentifiers: 'needed' }, () => ddlFor('postgres', t));
    assert.equal(out, 'create table app.users\n(\n    id integer,\n    "order" text\n);\n', 'reserved word "order" stays quoted');
    assert.match(ddlFor('postgres', t), /^CREATE TABLE "app"\."users"/, 'default style is restored afterwards');
  });
});

describe('Pre-introspected system catalogs', () => {
  it('adds system objects that are not in the metadata', async () => {
    const { systemCatalog } = await import('../src/language/systemCatalog');
    const pg = systemCatalog('postgres', []);
    assert.ok(pg.some((t) => t.schema === 'pg_catalog' && t.name === 'pg_stat_activity' && t.columns.some((c) => c.name === 'query')));
    assert.ok(pg.some((t) => t.schema === 'information_schema' && t.name === 'columns'));
    const already = systemCatalog('postgres', [{ schema: 'pg_catalog', name: 'pg_class', kind: 'table', columns: [] }]);
    assert.ok(!already.some((t) => t.name === 'pg_class'), 'introspected objects win');
    assert.ok(systemCatalog('sqlite', []).some((t) => t.name === 'sqlite_schema'));
  });
});

describe('Virtual objects', () => {
  it('round-trips the file and builds JOIN conditions and select lists', async () => {
    const v = await import('../src/core/virtual');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'bindb-virt-'));
    try {
      const file = path.join(dir, 'x', 'external-data.json');
      assert.deepEqual(await v.loadVirtual(file), v.emptyVirtual(), 'missing file = empty');
      const data = {
        foreignKeys: [{ table: 'app.orders', columns: ['user_id'], refTable: 'app.users', refColumns: ['id'] }],
        views: [{ schema: 'app', name: 'big_orders', sql: 'select * from orders where total > 100' }],
        columns: [{ table: 'app.orders', name: 'total_tax', expression: 'total * 1.1' }],
      };
      await v.saveVirtual(file, data);
      assert.deepEqual(await v.loadVirtual(file), data);
      assert.equal(v.joinCondition(data, { table: 'app.users', alias: 'u' }, { table: 'app.orders', alias: 'o' }), 'o.user_id = u.id');
      assert.equal(v.joinCondition(data, { table: 'app.users', alias: 'u' }, { table: 'app.other', alias: 'x' }), undefined);
      assert.equal(v.selectList(data, 'APP.ORDERS', (s) => `"${s}"`), '*, (total * 1.1) AS "total_tax"');
      assert.equal(v.foreignKeysOf(data, 'app.users').length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
