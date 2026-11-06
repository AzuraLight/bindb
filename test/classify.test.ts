import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifySql } from '../src/core/classify';

const kind = (sql: string, d: Parameters<typeof classifySql>[1] = 'postgres') => classifySql(sql, d).kind;

describe('statement classification (before running)', () => {
  it('reads', () => {
    for (const sql of [
      'select * from t',
      'SELECT replace(name, \'a\', \'b\'), "delete" FROM t WHERE note = \'DROP TABLE x\'',
      '/* c */ WITH x AS (SELECT 1) SELECT * FROM x;',
      'VALUES (1), (2)',
      'TABLE t',
      'SHOW search_path',
      'EXPLAIN SELECT 1',
      'EXPLAIN ANALYZE SELECT 1',
      'select t.update, t.create from t',
      'select count(*) from t -- delete later',
    ]) assert.equal(kind(sql), 'read', sql);
    assert.equal(kind('DESCRIBE t', 'mysql'), 'read');
    assert.equal(kind('PRAGMA table_info(t)', 'sqlite'), 'read');
  });

  it('writes, including the sneaky ones', () => {
    for (const [sql, d] of [
      ['DROP TABLE t', 'postgres'],
      ['TRUNCATE users', 'mysql'],
      ['SET default_transaction_read_only = off', 'postgres'],
      ['SET SESSION TRANSACTION READ WRITE', 'mysql'],
      ['BEGIN READ WRITE', 'postgres'],
      ['START TRANSACTION READ WRITE', 'mysql'],
      ['WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'postgres'],
      ['EXPLAIN ANALYZE DELETE FROM t', 'postgres'],
      ['SELECT * INTO backup FROM t', 'postgres'],
      ["SELECT * FROM t INTO OUTFILE '/tmp/x'", 'mysql'],
      ['SELECT * FROM t FOR UPDATE', 'postgres'],
      ["SELECT dblink_exec('x', 'drop table t')", 'postgres'],
      ["SELECT set_config('default_transaction_read_only', 'off', false)", 'postgres'],
      ["SELECT nextval('s')", 'postgres'],
      ["SELECT FILE_WRITE('x', '/tmp/y')", 'h2'],
      ["SELECT CSVWRITE('/Users/x/.zshrc', 'SELECT 1')", 'h2'],
      ['SELECT NEXT VALUE FOR s', 'h2'],
      ["SELECT LOAD_FILE('/etc/passwd')", 'mysql'],
      ['SELECT 1; DROP TABLE t', 'h2'],
      ['SELECT 1; SELECT 2', 'postgres'],
      ['PRAGMA journal_mode = WAL', 'sqlite'],
      ["SELECT writefile('x', 'y')", 'sqlite'],
      ['CALL p()', 'mysql'],
      ['some unknown statement', 'postgres'],
    ] as const) assert.equal(kind(sql, d), 'write', sql);
  });

  it('transaction control and empty input', () => {
    assert.equal(kind('COMMIT'), 'transaction');
    assert.equal(kind('BEGIN'), 'transaction');
    assert.equal(kind('  -- only a comment\n'), 'empty');
    assert.match(String(classifySql('SELECT 1; DROP TABLE t', 'h2').reason), /more than one statement/);
  });
});

describe('dialect-aware lexing closes the known bypasses', () => {
  it('backslash is not an escape in SQLite, H2 and standard PostgreSQL strings', () => {
    // 'a\' 는 문자열 하나이고, 뒤의 DELETE는 별도 문장이다
    assert.equal(kind("SELECT 'a\\'; DELETE FROM t; --'", 'sqlite'), 'write');
    assert.equal(kind("SELECT 'a\\'; DELETE FROM t; --'", 'h2'), 'write');
    assert.equal(kind("SELECT 'a\\'; DELETE FROM t; --'", 'postgres'), 'write');
    assert.equal(kind("SELECT 'C:\\temp\\'", 'sqlite'), 'read');
    // PostgreSQL E'…' 에서는 \' 가 따옴표다
    assert.equal(kind("SELECT E'it\\'s; DROP TABLE t'", 'postgres'), 'read');
    // MySQL은 \' 가 따옴표다
    assert.equal(kind("SELECT 'it\\'s; DROP TABLE t'", 'mysql'), 'read');
  });

  it('# is an operator in PostgreSQL, a comment only in MySQL', () => {
    assert.equal(kind('SELECT 1 # 0, pg_terminate_backend(pid) FROM pg_stat_activity', 'postgres'), 'write');
    assert.equal(kind('SELECT 1 # DROP TABLE t', 'mysql'), 'read');
  });

  it('MySQL executable comments are code', () => {
    assert.equal(kind("SELECT * FROM t /*!50000 INTO OUTFILE '/tmp/x' */", 'mysql'), 'write');
    assert.equal(kind('SELECT * FROM t /*! FOR UPDATE */', 'mysql'), 'write');
    assert.equal(kind('SELECT /*+ BKA(t) */ * FROM t', 'mysql'), 'read');
  });

  it('nested comments in PostgreSQL / H2 do not hide statements', () => {
    assert.equal(kind('SELECT 1 /* a /* b */ still comment; DROP TABLE t */', 'postgres'), 'read');
    assert.equal(kind('SELECT 1 /* a /* b */ x */; DROP TABLE t', 'postgres'), 'write');
    // SQLite는 중첩하지 않는다: 첫 */ 에서 주석이 끝난다
    assert.equal(kind('SELECT 1 /* a /* b */; DROP TABLE t', 'sqlite'), 'write');
  });

  it('quoted function names are still side-effect functions', () => {
    assert.equal(kind(`SELECT "FILE_WRITE"('x', '/tmp/p')`, 'h2'), 'write');
    assert.equal(kind(`SELECT "pg_terminate_backend"(1)`, 'postgres'), 'write');
  });

  it('SQLite PRAGMA x(value) sets a value; table_info(t) only reads', () => {
    assert.equal(kind('PRAGMA user_version(7)', 'sqlite'), 'write');
    assert.equal(kind('PRAGMA journal_mode(OFF)', 'sqlite'), 'write');
    assert.equal(kind("PRAGMA table_info('t')", 'sqlite'), 'read');
    assert.equal(kind("PRAGMA main.index_list('t')", 'sqlite'), 'read');
    assert.equal(kind('PRAGMA user_version', 'sqlite'), 'read');
  });

  it('row locks and EXPLAIN ANALYZE … INTO', () => {
    assert.equal(kind('SELECT * FROM t FOR NO KEY UPDATE', 'postgres'), 'write');
    assert.equal(kind('SELECT * FROM t FOR KEY SHARE', 'postgres'), 'write');
    assert.equal(kind('SELECT * FROM t LOCK IN SHARE MODE', 'mysql'), 'write');
    assert.equal(kind('EXPLAIN ANALYZE SELECT * INTO t2 FROM t', 'postgres'), 'write');
  });
});

describe('SQLite PRAGMA and BEGIN forms', () => {
  it('check pragmas with an argument only read; optimize / incremental_vacuum / wal_checkpoint write', () => {
    for (const sql of ['PRAGMA integrity_check(t)', 'PRAGMA quick_check(10)', 'PRAGMA foreign_key_check(t)', 'PRAGMA table_list(t)']) {
      assert.equal(kind(sql, 'sqlite'), 'read', sql);
    }
    for (const sql of ['PRAGMA optimize', 'PRAGMA incremental_vacuum', 'PRAGMA wal_checkpoint(TRUNCATE)']) assert.equal(kind(sql, 'sqlite'), 'write', sql);
  });
});
