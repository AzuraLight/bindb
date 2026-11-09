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

  // 괄호로 시작하는 문장이 empty로 판정되어 읽기 전용 검사(kind === 'write'일 때만 거부)를 건너뛰었다
  it('looks inside leading parentheses instead of calling the statement empty', () => {
    for (const [sql, d] of [
      ["(SELECT GET_LOCK('k', 1))", 'mysql'],
      ['(SELECT 1 FROM t FOR UPDATE)', 'mysql'],
      ['(  ( SELECT SLEEP(0) ) )', 'mysql'],
      ["(SELECT CSVWRITE('/tmp/y', 'SELECT 1'))", 'h2'],
      ['(SELECT "FILE_WRITE"(\'x\', \'/tmp/y\'))', 'h2'],
      ["(SELECT nextval('s'))", 'postgres'],
      ["((SELECT writefile('/tmp/y', 'x')))", 'sqlite'],
      ['(DELETE FROM t)', 'postgres'],
    ] as const) assert.equal(kind(sql, d), 'write', sql);
    assert.equal(kind('(SELECT 1) UNION (SELECT 2) ORDER BY 1'), 'read');
    assert.equal(kind('((VALUES (1)))'), 'read');
  });

  it('treats statements that do not start with a keyword as writes', () => {
    for (const sql of ['$1', ':x', '42', "'text'"]) assert.equal(kind(sql), 'write', sql);
    assert.equal(kind('-- only a comment'), 'empty');
    assert.equal(kind(''), 'empty');
  });

  // 열 이름이 키워드와 같으면(copy · load · handler · do …) 읽기 전용 연결에서 거부됐다
  it('columns named like write keywords are reads; real writes inside reads still are not', () => {
    for (const [sql, d] of [
      ['SELECT copy, load, handler FROM t', 'postgres'],
      ['SELECT t.copy FROM t ORDER BY create DESC', 'postgres'],
      ['SELECT a FROM t WHERE do = 1 AND merge IS NULL', 'mysql'],
      ['SELECT DISTINCT replace FROM t', 'mysql'],
    ] as const) assert.equal(kind(sql, d), 'read', sql);
    for (const [sql, d] of [
      ['WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'postgres'],
      ['WITH a AS (SELECT 1), b AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM b', 'postgres'],
      ['WITH x AS (SELECT 1) UPDATE t SET a = 1', 'postgres'],
      ['EXPLAIN ANALYZE DELETE FROM t', 'postgres'],
      ['EXPLAIN UPDATE t SET a = 1', 'mysql'],
      ['SELECT * FROM FINAL TABLE (INSERT INTO t VALUES (1))', 'h2'],
      ['SELECT * FROM t WHERE a = (DELETE FROM t RETURNING a)', 'postgres'],
    ] as const) assert.equal(kind(sql, d), 'write', sql);
  });

  it('PostgreSQL functions that lock, reset statistics or reach other servers are writes', () => {
    for (const fn of [
      'pg_try_advisory_lock(1)',
      'pg_advisory_lock_shared(1)',
      'pg_try_advisory_xact_lock(1)',
      'pg_stat_reset()',
      "dblink_connect('host=x')",
      "pg_create_logical_replication_slot('s', 'pgoutput')",
      "pg_drop_replication_slot('s')",
      "lo_from_bytea(0, 'x')",
    ]) assert.equal(kind(`SELECT ${fn}`), 'write', fn);
  });
});
