import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DriverId, MetaTable } from '../src/drivers/types';
import { hoverAt } from '../src/language/hover';
import { splitStatements, statementAt } from '../src/language/splitter';

const TABLES: MetaTable[] = [
  { schema: 'public', name: 'users', kind: 'table', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'text' }], primaryKey: ['id'] },
  {
    schema: 'public',
    name: 'orders',
    kind: 'table',
    columns: [{ name: 'id', type: 'integer' }, { name: 'user_id', type: 'integer' }],
    primaryKey: ['id'],
    foreignKeys: [{ name: 'fk', columns: ['user_id'], refSchema: 'public', refTable: 'users', refColumns: ['id'] }],
  },
  { schema: 'sales', name: 'users', kind: 'view', columns: [{ name: 'region' }], level: 1 },
  {
    schema: 'doc',
    name: 'notes',
    kind: 'table',
    comment: 'Customer *notes* <b>x</b>\nline2',
    columns: [{ name: 'body', type: 'text', comment: 'Free text [link](http://e)' }, { name: 'plain', type: 'int' }],
  },
  { schema: 'wide', name: 'w', kind: 'table', columns: Array.from({ length: 35 }, (_, i) => ({ name: `c${i}` })) },
];

/** `|` 바로 뒤 글자에 마우스를 올린 결과(제목 줄과 표시 범위) */
function hover(sqlWithCursor: string, driver: DriverId = 'postgres', schema = 'public') {
  const offset = sqlWithCursor.indexOf('|');
  const sql = sqlWithCursor.replace('|', '');
  const h = hoverAt(statementAt(splitStatements(sql, driver), offset), offset, { tables: TABLES, schema });
  return h && { word: sql.slice(h.start, h.end), title: h.markdown.split('\n')[0], md: h.markdown };
}

describe('hover', () => {
  it('shows a table with columns, primary key, foreign keys and referencing tables', () => {
    const h = hover('SELECT * FROM us|ers');
    assert.equal(h?.word, 'users');
    assert.equal(h?.title, '**table** `public.users`');
    assert.match(h!.md, /- `id` integer · primary key/);
    assert.match(h!.md, /Referenced by: `public.orders`\(`user_id`\)/);
    assert.match(hover('SELECT * FROM or|ders')!.md, /Foreign keys: `user_id` → `public.users`\(`id`\)/);
  });

  it('prefers the bound schema, and follows explicit schemas', () => {
    assert.equal(hover('SELECT * FROM us|ers', 'postgres', 'sales')?.title, '**view** `sales.users`');
    assert.equal(hover('SELECT * FROM sales.us|ers')?.title, '**view** `sales.users`');
    assert.match(hover('SELECT * FROM sales.us|ers')!.md, /level 1: names only/);
    assert.equal(hover('SELECT * FROM sal|es.users')?.title, '**schema** `sales`');
  });

  it('resolves aliases and qualified columns', () => {
    assert.equal(hover('SELECT o.id FROM orders o JOIN users u ON |u.id = o.user_id')?.title, '**table** `public.users` — alias `u`');
    const col = hover('SELECT o.us|er_id FROM orders o');
    assert.equal(col?.title, '**column** `orders.user_id` integer');
    assert.match(col!.md, /Foreign key: `user_id` → `public.users`\(`id`\)/);
    assert.match(hover('SELECT u.i|d FROM users u')!.md, /Primary key[\s\S]*Referenced by: `public.orders`\(`user_id`\)/);
    assert.equal(hover('SELECT users.na|me FROM users')?.title, '**column** `users.name` text');
    assert.equal(hover('SELECT public.users.na|me FROM users')?.title, '**column** `users.name` text');
  });

  it('finds unqualified columns in the statement tables, listing every owner when ambiguous', () => {
    assert.equal(hover('SELECT na|me FROM users')?.title, '**column** `users.name` text');
    const both = hover('SELECT i|d FROM users, orders')!.md;
    assert.match(both, /`users.id`[\s\S]*---[\s\S]*`orders.id`/);
    assert.equal(hover('INSERT INTO users (na|me) VALUES (1)')?.title, '**column** `users.name` text');
    assert.equal(hover('INSERT INTO us|ers (name) VALUES (1)')?.title, '**table** `public.users`');
  });

  it('returns nothing for functions, keywords, strings, comments, unknown names and unclosed quotes', () => {
    for (const sql of [
      'SELECT co|unt(*) FROM users',
      'SELECT public.us|ers(1)',
      'SEL|ECT 1',
      "SELECT 'us|ers' FROM orders",
      'SELECT 1 -- us|ers',
      'SELECT no|pe FROM users',
      'SELECT x.i|d FROM (SELECT 1 id) x',
      'SELECT * FROM "us|ers',
      '|',
    ]) assert.equal(hover(sql), undefined, sql);
  });

  it('caps long column lists and handles quoted names', () => {
    assert.match(hover('SELECT * FROM w|ide.w')?.md ?? '', /schema/);
    assert.match(hover('SELECT * FROM wide.|w')!.md, /- … 5 more/);
    assert.equal(hover('SELECT "u"."na|me" FROM "users" "u"')?.title, '**column** `users.name` text');
    assert.equal(hover('SELECT `na|me` FROM `users`', 'mysql')?.title, '**column** `users.name` text');
  });

  it('shows table and column comments as plain text', () => {
    const t = hover('SELECT * FROM doc.no|tes')!.md;
    assert.match(t, /Customer \\\*notes\\\* \\<b\\>x\\<\/b\\> line2/);
    assert.match(t, /- `body` text — Free text \\\[link\\\]\\\(http:\/\/e\\\)/);
    assert.match(t, /- `plain` int$/m);
    const c = hover('SELECT n.bo|dy FROM doc.notes n')!.md.split('\n');
    assert.deepEqual(c.slice(0, 4), ['**column** `notes.body` text', '', 'Free text \\[link\\]\\(http://e\\)', '']);
  });
});
