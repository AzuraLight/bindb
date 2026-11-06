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
});
