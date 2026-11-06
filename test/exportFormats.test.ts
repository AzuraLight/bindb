import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatRows, quoteIdent, sqlLiteral, uniqueNames, writerFor } from '../src/shared/exportFormats';

const cols = ['id', 'name', 'note'];

describe('CSV / TSV', () => {
  it('quotes only when needed and keeps NULL apart from the empty string', () => {
    const out = formatRows('csv', cols, [
      [1, 'plain', null],
      [2, 'a,b', ''],
      [3, 'say "hi"', 'line1\nline2'],
      [4, ' padded ', 'tab\there'],
    ]);
    assert.equal(
      out,
      'id,name,note\r\n1,plain,\r\n2,"a,b",""\r\n3,"say ""hi""","line1\nline2"\r\n4," padded ",tab\there\r\n',
    );
  });

  it('TSV quotes tabs, not commas', () => {
    assert.equal(formatRows('tsv', ['a'], [['x,y'], ['t\tb']]), 'a\r\nx,y\r\n"t\tb"\r\n');
  });

  it('writes binary as hex when loaded, otherwise a placeholder; booleans and big integers as text', () => {
    assert.equal(formatRows('csv', ['b', 'f', 'n'], [[{ $bin: 2, hex: 'cafe' }, true, '9007199254740993']]), 'b,f,n\r\n0xcafe,true,9007199254740993\r\n');
    assert.equal(formatRows('csv', ['b'], [[{ $bin: 9 }]]), 'b\r\n<binary 9 bytes>\r\n');
  });
});

describe('JSON', () => {
  it('is valid JSON, renames duplicate columns, keeps null', () => {
    const out = formatRows('json', ['id', 'id', 'x'], [[1, 2, null], [3, 4, 'é"\n']]);
    assert.deepEqual(JSON.parse(out), [
      { id: 1, id_2: 2, x: null },
      { id: 3, id_2: 4, x: 'é"\n' },
    ]);
    assert.deepEqual(JSON.parse(formatRows('json', ['a'], [])), []);
  });

  it('uniqueNames never collides with an existing column', () => {
    assert.deepEqual(uniqueNames(['a', 'a', 'a_2']), ['a', 'a_2_', 'a_2']);
  });

  it('streams row by row', () => {
    const w = writerFor('json');
    const text = w.header(['a']) + w.row([1]) + w.row([2]) + w.footer();
    assert.deepEqual(JSON.parse(text), [{ a: 1 }, { a: 2 }]);
  });
});

describe('Markdown', () => {
  it('escapes pipes and backslashes, turns newlines into <br>', () => {
    assert.equal(formatRows('markdown', ['a|b', 'c'], [['x|y', 'l1\r\nl2'], [null, 'back\\slash']]),
      '| a\\|b | c |\n| --- | --- |\n| x\\|y | l1<br>l2 |\n|  | back\\\\slash |\n');
  });
});

describe('SQL INSERT', () => {
  it('quotes identifiers and literals per dialect', () => {
    const rows = [[1, "O'Brien", null, true, { $bin: 2, hex: '00ff' }, 'a\\b']];
    const c = ['id', 'na"me', 'n', 'ok', 'blob', 'path'];
    assert.equal(
      formatRows('sql-insert', c, rows, { dialect: 'postgres', table: '"public"."t"' }),
      `INSERT INTO "public"."t" ("id", "na""me", "n", "ok", "blob", "path") VALUES (1, 'O''Brien', NULL, TRUE, '\\x00ff'::bytea, 'a\\b');\n`,
    );
    assert.equal(
      formatRows('sql-insert', c, rows, { dialect: 'mysql' }),
      "INSERT INTO MY_TABLE (`id`, `na\"me`, `n`, `ok`, `blob`, `path`) VALUES (1, 'O''Brien', NULL, TRUE, X'00ff', 'a\\\\b');\n",
    );
    assert.match(formatRows('sql-insert', ['ok'], [[false]], { dialect: 'sqlite' }), /VALUES \(0\);/);
  });

  it('never emits an unescaped literal', () => {
    assert.equal(sqlLiteral('postgres', "'); DROP TABLE x; --"), "'''); DROP TABLE x; --'");
    assert.equal(quoteIdent('mysql', 'a`b'), '`a``b`');
    assert.equal(sqlLiteral('postgres', { $bin: 3 }), 'NULL /* binary not loaded */');
  });
});
