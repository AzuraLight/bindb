import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectTableRefs, completionContext } from '../src/language/context';
import { splitStatements, statementAt } from '../src/language/splitter';
import { tokenize } from '../src/language/tokenizer';

/** `|` 자리를 커서로 보고 컨텍스트를 구한다 */
function ctx(sqlWithCursor: string) {
  const offset = sqlWithCursor.indexOf('|');
  const sql = sqlWithCursor.replace('|', '');
  return completionContext(statementAt(splitStatements(sql), offset), offset);
}

describe('splitStatements', () => {
  it('splits on semicolons outside strings and comments', () => {
    const s = splitStatements("select ';' from a; -- x;y\nselect 2 /* ; */;\n\n  select 3");
    // 문장 끝에 붙은 주석은 실행 텍스트에서 뺀다.
    assert.deepEqual(s.map((x) => x.text), ["select ';' from a", 'select 2', 'select 3']);
  });

  it('keeps dollar-quoted bodies together', () => {
    const s = splitStatements('create function f() returns int as $$ begin; return 1; end $$ language plpgsql; select 1');
    assert.equal(s.length, 2);
    assert.match(s[0].text, /language plpgsql$/);
  });

  it('keeps trigger BEGIN … END blocks together but not BEGIN transactions', () => {
    const s = splitStatements('begin; create trigger t after insert on a begin update b set x = 1; end; commit');
    assert.deepEqual(s.map((x) => x.text.split(' ')[0]), ['begin', 'create', 'commit']);
  });

  it('handles MySQL END IF inside procedures', () => {
    const s = splitStatements('create procedure p() begin if 1 then select 1; end if; select 2; end; select 3');
    assert.equal(s.length, 2);
  });

  // begin은 PostgreSQL · MySQL에서 예약어가 아니라 열 이름이 될 수 있다. 블록으로 세면 다음 문장과 합쳐졌다
  it('a column named begin does not open a block', () => {
    const texts = (s: string) => splitStatements(s, 'postgres').map((x) => x.text);
    assert.deepEqual(texts('SELECT begin FROM t; SELECT 2'), ['SELECT begin FROM t', 'SELECT 2']);
    assert.deepEqual(texts('SELECT a, begin, t.begin FROM t ORDER BY begin; SELECT 2').length, 2);
    assert.deepEqual(texts('UPDATE t SET begin = now() WHERE begin IS NULL; SELECT 2').length, 2);
    assert.deepEqual(texts('SELECT count(begin) AS n FROM t; SELECT 2').length, 2);
    // 블록 BEGIN은 그대로
    assert.equal(splitStatements('CREATE TRIGGER x AFTER INSERT ON a FOR EACH ROW BEGIN UPDATE b SET y = 1; END; SELECT 1', 'sqlite').length, 2);
    assert.equal(splitStatements('CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END; SELECT 3', 'mysql').length, 2);
    assert.equal(splitStatements('CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END; SELECT 2', 'postgres').length, 2);
  });

  it('MySQL DELIMITER scripts split on the current delimiter, outside strings and comments', () => {
    const texts = (s: string) => splitStatements(s, 'mysql').map((x) => x.text);
    assert.deepEqual(texts('DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; END//\nDELIMITER ;\nCALL p();'), ['CREATE PROCEDURE p() BEGIN SELECT 1; END', 'CALL p()']);
    // $$ 가 낱말에 붙어 있어도(END$$), 문자열 · 주석 안의 구분자는 넘긴다
    assert.deepEqual(texts("delimiter $$\nSELECT '$$' AS a /* $$ */$$\nSELECT 2 END$$\n"), ["SELECT '$$' AS a", 'SELECT 2 END']);
    // 문자열 · 주석 안의 DELIMITER 낱말은 지시어가 아니다
    assert.deepEqual(texts("SELECT '\nDELIMITER //' AS x; -- DELIMITER //\nSELECT 2"), ["SELECT '\nDELIMITER //' AS x", 'SELECT 2']);
    // 오프셋은 원문 기준(커서 위치 문장 찾기)
    const doc = 'DELIMITER //\nSELECT 1//\nSELECT 2//';
    const s = splitStatements(doc, 'mysql');
    assert.equal(statementAt(s, doc.indexOf('2'))?.text, 'SELECT 2');
    assert.equal(doc.slice(s[0].start, s[0].end), 'SELECT 1');
    // 다른 DB에서 DELIMITER는 그냥 낱말
    assert.equal(splitStatements('DELIMITER //\nSELECT 1', 'postgres').length, 1);
  });

  it('picks the statement at or just before the cursor', () => {
    const text = 'select 1;\n\nselect 2;';
    const s = splitStatements(text);
    assert.equal(statementAt(s, text.indexOf('2'))?.text, 'select 2');
    assert.equal(statementAt(s, text.indexOf(';') + 1)?.text, 'select 1');
  });
});

describe('tokenize', () => {
  it('marks unterminated strings as open', () => {
    const t = tokenize("select 'abc");
    assert.equal(t.at(-1)?.type, 'string');
    assert.equal(t.at(-1)?.open, true);
  });

  it('recognizes parameters but not pg casts', () => {
    assert.deepEqual(tokenize('a = :id and b = $1 and c::int = ?').filter((x) => x.type === 'param').map((x) => x.text), [':id', '$1', '?']);
  });
});

describe('collectTableRefs', () => {
  it('reads schema, name and alias across FROM lists and joins', () => {
    const refs = collectTableRefs(tokenize('select * from public.users u, orders as o left join "Items" i on i.id = o.item_id where 1'));
    assert.deepEqual(refs, [
      { schema: 'public', name: 'users', alias: 'u' },
      { schema: undefined, name: 'orders', alias: 'o' },
      { schema: undefined, name: 'Items', alias: 'i' },
    ]);
  });

  it('does not treat keywords as aliases', () => {
    assert.deepEqual(collectTableRefs(tokenize('select * from users where id = 1')), [{ schema: undefined, name: 'users', alias: undefined }]);
  });
});

describe('completionContext', () => {
  it('suggests tables after FROM / JOIN', () => {
    assert.equal(ctx('select * from |').kind, 'table');
    assert.equal(ctx('select * from users u join |').kind, 'table');
    assert.equal(ctx('select * from us|').kind, 'table');
  });

  it('suggests schema tables after schema.', () => {
    const c = ctx('select * from public.|');
    assert.equal(c.kind, 'table');
    assert.equal(c.qualifier, 'public');
  });

  it('suggests columns with refs from the whole statement, even after the cursor', () => {
    const c = ctx('select u.| from users u');
    assert.equal(c.kind, 'column');
    assert.equal(c.qualifier, 'u');
    assert.deepEqual(c.refs, [{ schema: undefined, name: 'users', alias: 'u' }]);
    assert.equal(ctx('select * from users where |').kind, 'column');
    assert.equal(ctx('select * from a join b on a.id = |').kind, 'column');
  });

  it('suggests the insert target columns inside the column list', () => {
    const c = ctx('insert into users (id, |');
    assert.equal(c.kind, 'column');
    assert.deepEqual(c.refs, [{ name: 'users' }]);
    assert.equal(ctx('insert into users (id) values (|').kind, 'column');
  });

  it('sees through closed sub-expressions', () => {
    assert.equal(ctx('select count(*), | from t').kind, 'column');
    assert.equal(ctx('select * from t where id in (select id from x) and |').kind, 'column');
  });

  it('returns keyword at statement start and none inside strings or comments', () => {
    assert.equal(ctx('|').kind, 'keyword');
    assert.equal(ctx('sel|').kind, 'keyword');
    assert.equal(ctx("select 'ab|c' from t").kind, 'none');
    assert.equal(ctx('select 1 -- note |').kind, 'none');
  });

  it('BEGIN with a mode at the start of a statement is a transaction, not a block', () => {
    assert.equal(splitStatements('BEGIN IMMEDIATE; INSERT INTO t VALUES (1); COMMIT;', 'sqlite').length, 3);
    assert.equal(splitStatements('BEGIN ISOLATION LEVEL SERIALIZABLE; SELECT 1; COMMIT', 'postgres').length, 3);
    // 트리거 본문 BEGIN … END 는 여전히 한 문장
    assert.equal(splitStatements('CREATE TRIGGER x AFTER INSERT ON a BEGIN UPDATE b SET y = 1; DELETE FROM c; END; SELECT 1', 'sqlite').length, 2);
  });
});
