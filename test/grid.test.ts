import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildEditStatements, emptyChanges, hasChanges, setCell, type TableTarget } from '../src/core/editing';
import { buildFilteredSql, checkFragment, isWrappable, orderByOf, toggleSort } from '../src/core/gridQuery';

describe('grid filter and sort', () => {
  it('wraps SELECT queries, keeps a trailing comment from eating the parenthesis', () => {
    const r = buildFilteredSql({ query: 'select * from t -- note\n;' }, { where: 'a > 1', orderBy: '2 DESC' });
    assert.deepEqual(r, { ok: true, sql: 'SELECT * FROM (\nselect * from t\n) bindb_q\nWHERE a > 1\nORDER BY 2 DESC' });
    assert.deepEqual(buildFilteredSql({ query: 'select 1;' }, {}), { ok: true, sql: 'select 1' });
  });

  it('builds table data queries directly', () => {
    assert.deepEqual(buildFilteredSql({ table: '"s"."t"' }, { where: "name = 'x'" }), { ok: true, sql: `SELECT * FROM "s"."t"\nWHERE name = 'x'` });
  });

  it('refuses statements that cannot be wrapped and unsafe fragments', () => {
    assert.ok(isWrappable('  /* c */ WITH x AS (select 1) select * from x'));
    assert.ok(!isWrappable('PRAGMA table_info(t)'));
    assert.ok(!isWrappable('select 1; select 2'));
    assert.match(String((buildFilteredSql({ query: 'SHOW TABLES' }, { where: 'x' }) as { error: string }).error), /SELECT queries only/);
    assert.match(String(checkFragment('a = 1; DROP TABLE t', 'WHERE')), /";"/);
    assert.match(String(checkFragment("name = 'unclosed", 'WHERE')), /unclosed quote/);
    assert.match(String(checkFragment('a = 1 -- rest', 'WHERE')), /line comments/);
    assert.match(String(checkFragment('(a = 1', 'WHERE')), /parentheses/);
    assert.match(String(checkFragment('a = 1)', 'WHERE')), /parentheses/);
    assert.equal(checkFragment("note = 'a;b' AND x IN (1, 2)", 'WHERE'), undefined, 'a ; inside a string is fine');
  });

  it('header sort cycles none → asc → desc → none, shift keeps other keys; order by position', () => {
    let k = toggleSort([], 1, false);
    assert.deepEqual(k, [{ column: 1, desc: false }]);
    k = toggleSort(k, 1, false);
    assert.deepEqual(k, [{ column: 1, desc: true }]);
    k = toggleSort(k, 3, true);
    assert.equal(orderByOf(k), '2 DESC, 4');
    assert.deepEqual(toggleSort(toggleSort(k, 1, true), 3, false), [{ column: 3, desc: true }]);
    assert.deepEqual(toggleSort([{ column: 0, desc: true }], 0, false), []);
  });
});

describe('grid editing', () => {
  const target: TableTarget = { dialect: 'postgres', table: '"public"."people"', columns: ['id', 'name', 'n?ote'], key: ['id'] };
  const rows = [
    [1, "O'Brien", null],
    [2, 'Bo', 'x'],
    [null, 'nokey', null],
  ];

  it('makes parameterised DELETE → UPDATE → INSERT; deleted rows drop their edits', () => {
    const c = emptyChanges();
    setCell(c, 0, 1, 'New', "O'Brien");
    setCell(c, 0, 2, null, null); // 원래도 NULL → 편집 아님
    setCell(c, 1, 1, 'gone', 'Bo');
    c.deletes.add(1);
    c.inserts.push(new Map([[1, "it's"]]), new Map());
    const r = buildEditStatements(target, rows, c);
    assert.ok(r.ok);
    const s = r.ok ? r.statements : [];
    assert.deepEqual(
      s.map((x) => [x.sql, x.params, x.expectOne]),
      [
        ['DELETE FROM "public"."people" WHERE "id" = $1', [2], true],
        ['UPDATE "public"."people" SET "name" = $1 WHERE "id" = $2', ['New', 1], true],
        ['INSERT INTO "public"."people" ("name") VALUES ($1)', ["it's"], false],
        ['INSERT INTO "public"."people" DEFAULT VALUES', [], false],
      ],
    );
    assert.equal(s[2].preview, `INSERT INTO "public"."people" ("name") VALUES ('it''s')`);
  });

  it('a "?" in a column name does not shift the preview; mysql uses ? placeholders and () VALUES ()', () => {
    const c = emptyChanges();
    setCell(c, 1, 2, 'v', 'x');
    const pg = buildEditStatements(target, rows, c);
    assert.equal(pg.ok && pg.statements[0].preview, `UPDATE "public"."people" SET "n?ote" = 'v' WHERE "id" = 2`);
    const my = buildEditStatements({ ...target, dialect: 'mysql', table: '`people`' }, rows, { ...emptyChanges(), inserts: [new Map()] , updates: c.updates });
    assert.deepEqual(my.ok && my.statements.map((x) => x.sql), ['UPDATE `people` SET `n?ote` = ? WHERE `id` = ?', 'INSERT INTO `people` () VALUES ()']);
  });

  it('refuses rows whose key is NULL, and editing back to the original value clears the edit', () => {
    const c = emptyChanges();
    setCell(c, 2, 1, 'x', 'nokey');
    const r = buildEditStatements(target, rows, c);
    assert.ok(!r.ok && /Row 3: .*NULL/.test(r.error));
    const d = emptyChanges();
    setCell(d, 0, 1, 'tmp', "O'Brien");
    setCell(d, 0, 1, "O'Brien", "O'Brien");
    assert.ok(!hasChanges(d));
    setCell(d, 0, 0, '1', 1);
    assert.ok(!hasChanges(d), 'number 1 typed back as "1" is unchanged');
  });

  it('composite keys and SET to NULL', () => {
    const t: TableTarget = { dialect: 'sqlite', table: '"m"', columns: ['a', 'b', 'v'], key: ['a', 'b'] };
    const c = emptyChanges();
    setCell(c, 0, 2, null, 'x');
    const r = buildEditStatements(t, [['k1', 7, 'x']], c);
    assert.deepEqual(r.ok && [r.statements[0].sql, r.statements[0].params, r.statements[0].preview], [
      'UPDATE "m" SET "v" = ? WHERE "a" = ? AND "b" = ?',
      [null, 'k1', 7],
      `UPDATE "m" SET "v" = NULL WHERE "a" = 'k1' AND "b" = 7`,
    ]);
  });
});
