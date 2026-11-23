import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withCodeStyle } from '../src/core/ddl';
import { classifySql } from '../src/core/classify';
import { parseViewDdl, readViewSource, sameDefinition, sameSource, splitViewText, viewDdlText, viewMigration, viewSourceFromRows, viewSourceQueries } from '../src/core/viewSource';
import type { DriverId } from '../src/drivers/types';

const V = { schema: 'public', name: 'active_users' };
/** 소문자 키워드 · 필요할 때만 인용하는 코드 스타일 */
const LOWER = { keywordCase: 'lower', quoteIdentifiers: 'needed' } as const;
const migrate = (driver: DriverId, ddl: string, v = V, triggers: readonly string[] = []) => {
  const r = viewMigration(driver, ddl, v, triggers);
  if ('error' in r) throw new Error(r.error);
  return r.statements;
};
const refused = (driver: DriverId, ddl: string, v = V) => {
  const r = viewMigration(driver, ddl, v);
  assert.ok('error' in r, `expected a refusal: ${ddl}`);
  return r.error;
};

describe('view DDL text', () => {
  it('opens as CREATE VIEW with a qualified name, in the code style', () => {
    assert.equal(viewDdlText(viewSourceFromRows('postgres', V, [' SELECT id FROM users;  ', 'v', null])), 'CREATE VIEW "public"."active_users" AS\nSELECT id FROM users;\n');
    assert.equal(
      withCodeStyle(LOWER, () => viewDdlText(viewSourceFromRows('mysql', { schema: 'shop', name: 'v' }, ['select 1', 'NONE']))),
      'create view shop.v as\nselect 1;\n',
    );
  });

  // 본문만 다시 만들면 Submit이 속성을 지운다(코드 리뷰에서 찾은 것)
  it('keeps PostgreSQL view options (security_barrier, security_invoker, check_option)', () => {
    const s = viewSourceFromRows('postgres', V, [' SELECT id FROM users WHERE id > 0;', 'v', 'security_barrier=true, security_invoker=true, check_option=local']);
    assert.equal(viewDdlText(s), 'CREATE VIEW "public"."active_users" WITH (security_barrier=true, security_invoker=true, check_option=local) AS\nSELECT id FROM users WHERE id > 0;\n');
    assert.match(migrate('postgres', viewDdlText(s))[0], /^CREATE OR REPLACE VIEW "public"\."active_users" WITH \(security_barrier=true, security_invoker=true, check_option=local\) AS/);
  });

  it('keeps MySQL ALGORITHM, DEFINER, SQL SECURITY, column list and CHECK OPTION', () => {
    const v = { schema: 'shop', name: 'v' };
    const create = 'CREATE ALGORITHM=MERGE DEFINER=`app`@`%` SQL SECURITY INVOKER VIEW `v` (`a`,`b`) AS select `shop`.`t`.`id` AS `a`,1 AS `b` from `shop`.`t` WITH LOCAL CHECK OPTION';
    const s = viewSourceFromRows('mysql', v, ['select `shop`.`t`.`id` AS `a`,1 AS `b` from `shop`.`t`', 'LOCAL'], [[['v', create, 'utf8mb4', 'utf8mb4_0900_ai_ci']]]);
    assert.equal(
      viewDdlText(s),
      'CREATE ALGORITHM=MERGE DEFINER=`app`@`%` SQL SECURITY INVOKER VIEW `v` (`a`,`b`) AS\nselect `shop`.`t`.`id` AS `a`,1 AS `b` from `shop`.`t` WITH LOCAL CHECK OPTION;\n',
    );
    assert.equal(migrate('mysql', viewDdlText(s), v)[0], 'CREATE OR REPLACE ALGORITHM=MERGE DEFINER=`app`@`%` SQL SECURITY INVOKER VIEW `shop`.`v` (`a`,`b`) AS\nselect `shop`.`t`.`id` AS `a`,1 AS `b` from `shop`.`t` WITH LOCAL CHECK OPTION');
  });

  it('keeps the SQLite column list and recreates the triggers that DROP VIEW removes', () => {
    const v = { schema: 'main', name: 'v' };
    const trigger = 'CREATE TRIGGER tr INSTEAD OF INSERT ON v BEGIN INSERT INTO t VALUES (new.a); END';
    const s = viewSourceFromRows('sqlite', v, ['CREATE VIEW v(a, b) AS SELECT 1, 2'], [[[trigger]]]);
    assert.equal(viewDdlText(s), 'CREATE VIEW v(a, b) AS\nSELECT 1, 2;\n');
    assert.deepEqual(s.triggers, [trigger]);
    assert.deepEqual(migrate('sqlite', viewDdlText(s).replace('2', '3'), v).length, 2);
    assert.deepEqual(migrate('sqlite', viewDdlText(s).replace('2', '3'), v, s.triggers), ['DROP VIEW IF EXISTS "v"', 'CREATE VIEW "v"(a, b) AS\nSELECT 1, 3', trigger]);
  });

  it('splitViewText: a cached definition that is a whole CREATE statement gives its body (bodies are left alone)', () => {
    assert.deepEqual(splitViewText('h2', 'CREATE FORCE VIEW "PUBLIC"."V"("A") AS\nSELECT 1 AS "A"'), { header: 'CREATE FORCE VIEW "PUBLIC"."V"("A") AS', body: 'SELECT 1 AS "A"' });
    assert.equal(splitViewText('h2', 'SELECT 1 AS "A"'), undefined);
    assert.equal(splitViewText('postgres', ' SELECT users.id FROM users;'), undefined);
    // 캐시를 나눈 본문은 DB에서 새로 읽은 본문과 같다(열 때 outdated 경고가 뜨지 않는다)
    const cached = 'CREATE FORCE VIEW "PUBLIC"."V"("A") AS\nSELECT 1 AS "A"';
    const fresh = viewSourceFromRows('h2', { schema: 'PUBLIC', name: 'V' }, [cached]);
    assert.ok(sameDefinition(splitViewText('h2', cached)!.body, fresh.definition, 'h2'));
  });

  it('splits an H2 definition that is a whole CREATE statement', () => {
    const s = viewSourceFromRows('h2', { schema: 'PUBLIC', name: 'V' }, ['CREATE FORCE VIEW "PUBLIC"."V"("A") AS\nSELECT 1 AS "A"']);
    assert.equal(s.definition, 'SELECT 1 AS "A"');
    assert.equal(s.header, 'CREATE FORCE VIEW "PUBLIC"."V"("A") AS');
  });
});

describe('view migration', () => {
  it('turns CREATE VIEW into CREATE OR REPLACE VIEW on PostgreSQL, MySQL and H2', () => {
    assert.deepEqual(migrate('postgres', 'CREATE VIEW "public"."active_users" AS\nSELECT id FROM users WHERE active;\n'), [
      'CREATE OR REPLACE VIEW "public"."active_users" AS\nSELECT id FROM users WHERE active',
    ]);
    assert.deepEqual(migrate('h2', 'create view active_users as select 1', { schema: 'PUBLIC', name: 'ACTIVE_USERS' }), [
      'create or replace view "PUBLIC"."ACTIVE_USERS" as select 1',
    ]);
    assert.deepEqual(migrate('mysql', 'CREATE OR REPLACE VIEW `active_users` AS SELECT 1', { schema: 'shop', name: 'active_users' }), [
      'CREATE OR REPLACE VIEW `shop`.`active_users` AS SELECT 1',
    ]);
  });

  it('keeps attributes, column lists, options and the body as written', () => {
    assert.deepEqual(
      migrate('mysql', "CREATE ALGORITHM=MERGE DEFINER=`root`@`localhost` SQL SECURITY INVOKER VIEW shop.v (a, b) AS SELECT 1, '  x  ' WITH CHECK OPTION", { schema: 'shop', name: 'v' }),
      ["CREATE OR REPLACE ALGORITHM=MERGE DEFINER=`root`@`localhost` SQL SECURITY INVOKER VIEW `shop`.`v` (a, b) AS SELECT 1, '  x  ' WITH CHECK OPTION"],
    );
    assert.deepEqual(migrate('postgres', '-- note\nCREATE VIEW active_users WITH (security_barrier) AS SELECT (1) AS one; -- end'), [
      'CREATE OR REPLACE VIEW "public"."active_users" WITH (security_barrier) AS SELECT (1) AS one',
    ]);
  });

  it('drops IF NOT EXISTS where OR REPLACE is used', () => {
    assert.deepEqual(migrate('postgres', 'CREATE VIEW IF NOT EXISTS active_users AS SELECT 1'), ['CREATE OR REPLACE VIEW "public"."active_users" AS SELECT 1']);
  });

  it('SQLite drops and recreates the view (it has no OR REPLACE)', () => {
    const v = { schema: 'main', name: 'v' };
    assert.deepEqual(migrate('sqlite', 'CREATE VIEW v AS SELECT 1', v), ['DROP VIEW IF EXISTS "v"', 'CREATE VIEW "v" AS SELECT 1']);
    assert.deepEqual(migrate('sqlite', 'CREATE OR REPLACE VIEW main.v AS SELECT 1', v), ['DROP VIEW IF EXISTS "v"', 'CREATE VIEW "v" AS SELECT 1']);
    assert.deepEqual(migrate('sqlite', 'CREATE TEMP VIEW IF NOT EXISTS "v" AS SELECT 1', v), ['DROP VIEW IF EXISTS "v"', 'CREATE TEMP VIEW IF NOT EXISTS "v" AS SELECT 1']);
  });

  it('refuses renames, other statements, several statements and materialized views', () => {
    assert.match(refused('postgres', 'CREATE VIEW other AS SELECT 1'), /Renaming is not supported/);
    assert.match(refused('postgres', 'CREATE VIEW sales.active_users AS SELECT 1'), /Renaming is not supported/);
    assert.match(refused('postgres', 'CREATE VIEW "Active_Users" AS SELECT 1'), /Renaming is not supported/);
    assert.match(refused('postgres', 'CREATE VIEW a.b.active_users AS SELECT 1'), /Renaming is not supported/);
    assert.match(refused('postgres', 'CREATE VIEW active_users AS SELECT 1; DROP TABLE users'), /exactly one/);
    assert.match(refused('postgres', 'DROP VIEW active_users'), /start with CREATE/);
    assert.match(refused('postgres', 'CREATE TABLE active_users (id int)'), /CREATE VIEW/);
    assert.match(refused('postgres', 'CREATE MATERIALIZED VIEW active_users AS SELECT 1'), /Materialized/);
    assert.match(refused('postgres', 'CREATE VIEW active_users'), /AS and the query/);
    assert.match(refused('postgres', 'CREATE VIEW active_users AS'), /empty/);
    assert.match(refused('postgres', ''), /exactly one/);
  });

  it('accepts the name in another case when it is not quoted', () => {
    assert.deepEqual(migrate('postgres', 'CREATE VIEW PUBLIC.ACTIVE_USERS AS SELECT 1'), ['CREATE OR REPLACE VIEW "public"."active_users" AS SELECT 1']);
  });
});

describe('view definition', () => {
  it('reads the body and header out of the SQLite CREATE VIEW text, and the materialized flag', () => {
    const s = viewSourceFromRows('sqlite', { schema: 'main', name: 'v' }, ['CREATE VIEW v(a) AS SELECT 1 AS a']);
    assert.deepEqual([s.definition, s.header, s.materialized], ['SELECT 1 AS a', 'CREATE VIEW v(a) AS', false]);
    assert.equal(viewSourceFromRows('postgres', V, [' SELECT 1;', 'm', null]).materialized, true);
  });

  it('readViewSource stops when the first query finds no view', async () => {
    const asked: string[] = [];
    const run = async (q: { sql: string }) => (asked.push(q.sql), [] as unknown[][]);
    assert.equal(await readViewSource('mysql', { schema: 'shop', name: 'v' }, run), undefined);
    assert.equal(asked.length, 1);
    const nullDef = async () => [[null, 'NONE']];
    assert.equal(await readViewSource('mysql', { schema: 'shop', name: 'v' }, nullDef), undefined);
  });

  it('readViewSource applies the code style to the header it builds (after the awaits)', async () => {
    const run = async () => [[' SELECT 1;', 'v', null]];
    const s = await readViewSource('postgres', V, run, LOWER);
    assert.equal(s?.header, 'create view public.active_users as');
  });

  it('compares definitions ignoring whitespace and a trailing semicolon', () => {
    assert.equal(sameDefinition(' SELECT id\n   FROM users;', 'SELECT id FROM users', 'postgres'), true);
    assert.equal(sameDefinition('SELECT id FROM users', 'SELECT name FROM users', 'postgres'), false);
  });

  it('sameSource also compares the header and trailer (attributes changed in the database)', () => {
    const a = viewSourceFromRows('postgres', V, [' SELECT 1;', 'v', null]);
    const b = viewSourceFromRows('postgres', V, [' SELECT 1;', 'v', 'security_barrier=true']);
    assert.equal(sameSource(a, a, 'postgres'), true);
    assert.equal(sameSource(a, b, 'postgres'), false);
  });

  it('the definition queries are read-only for the classifier', () => {
    for (const d of ['postgres', 'mysql', 'sqlite', 'h2'] as const) {
      const qs = viewSourceQueries(d, V);
      // SHOW CREATE VIEW는 분류기가 쓰기로 본다 — SessionManager.introspectionQuery가 이 모양만 따로 허용한다
      for (const q of qs) if (!q.sql.startsWith('SHOW CREATE VIEW')) assert.equal(classifySql(q.sql, d).kind, 'read', `${d}: ${q.sql}`);
      assert.ok(qs[0].params.length >= 1, d);
    }
    // SHOW CREATE VIEW는 자리 표시자를 받지 않아 이름을 인용해 넣는다
    assert.equal(viewSourceQueries('mysql', { schema: 'sh`op', name: 'v' })[1].sql, 'SHOW CREATE VIEW `sh``op`.`v`');
  });

  it('parses a statement surrounded by comments', () => {
    const p = parseViewDdl('/* a */ CREATE VIEW v AS SELECT 1 -- b', 'postgres');
    assert.ok(!('error' in p));
    assert.equal(p.body, 'SELECT 1');
  });
});

describe('view DDL edge cases', () => {
  it('comments between CREATE, OR REPLACE, VIEW and the name', () => {
    assert.deepEqual(migrate('postgres', 'CREATE /* a */ OR /* b */ REPLACE VIEW /* c */ active_users AS SELECT 1'), [
      'CREATE /* a */ OR /* b */ REPLACE VIEW /* c */ "public"."active_users" AS SELECT 1',
    ]);
    assert.deepEqual(migrate('postgres', 'CREATE -- why\nVIEW active_users AS SELECT 1'), ['CREATE OR REPLACE -- why\nVIEW "public"."active_users" AS SELECT 1']);
    // 이름 조각 사이의 주석은 한정한 이름으로 바뀐다
    assert.deepEqual(migrate('postgres', 'CREATE VIEW public /* s */ . /* n */ active_users AS SELECT 1'), ['CREATE OR REPLACE VIEW "public"."active_users" AS SELECT 1']);
  });

  it('quoted names containing dots and quotes round-trip through the opened DDL', () => {
    const weird = { schema: 'my.schema', name: 'a"b`c.d' };
    for (const driver of ['postgres', 'mysql', 'h2', 'sqlite'] as const) {
      const v = driver === 'sqlite' ? { ...weird, schema: 'main' } : weird;
      for (const style of [undefined, LOWER]) {
        const r = withCodeStyle(style, () => viewMigration(driver, viewDdlText(viewSourceFromRows(driver, v, ['SELECT 1'])), v));
        assert.ok(!('error' in r), `${driver}: ${'error' in r ? r.error : ''}`);
      }
    }
    assert.deepEqual(migrate('postgres', 'CREATE VIEW "my.schema"."a""b" AS SELECT 1', { schema: 'my.schema', name: 'a"b' }), [
      'CREATE OR REPLACE VIEW "my.schema"."a""b" AS SELECT 1',
    ]);
    assert.deepEqual(migrate('mysql', 'CREATE VIEW `we``ird`.`v.1` AS SELECT 1', { schema: 'we`ird', name: 'v.1' }), ['CREATE OR REPLACE VIEW `we``ird`.`v.1` AS SELECT 1']);
    // 인용한 "my.schema" 하나는 schema.name 두 조각이 아니다
    assert.match(refused('postgres', 'CREATE VIEW "public.active_users" AS SELECT 1'), /Renaming/);
  });

  it('schema-qualified names per driver', () => {
    assert.deepEqual(migrate('mysql', 'CREATE VIEW shop.v AS SELECT 1', { schema: 'shop', name: 'v' }), ['CREATE OR REPLACE VIEW `shop`.`v` AS SELECT 1']);
    assert.match(refused('mysql', 'CREATE VIEW other.v AS SELECT 1', { schema: 'shop', name: 'v' }), /Renaming/);
    assert.deepEqual(migrate('h2', 'CREATE VIEW PUBLIC.V AS SELECT 1', { schema: 'PUBLIC', name: 'V' }), ['CREATE OR REPLACE VIEW "PUBLIC"."V" AS SELECT 1']);
    // H2 · PostgreSQL: 인용한 이름은 대소문자까지 같아야 한다
    assert.match(refused('h2', 'CREATE VIEW "public"."v" AS SELECT 1', { schema: 'PUBLIC', name: 'V' }), /Renaming/);
    const sv = { schema: 'main', name: 'v' };
    assert.deepEqual(migrate('sqlite', 'CREATE VIEW "main"."v" AS SELECT 1', sv), ['DROP VIEW IF EXISTS "v"', 'CREATE VIEW "v" AS SELECT 1']);
    assert.match(refused('sqlite', 'CREATE VIEW other.v AS SELECT 1', sv), /Renaming/);
  });

  it('column lists, WITH (options) and AS inside them', () => {
    assert.deepEqual(migrate('postgres', 'CREATE VIEW active_users ("as", b) WITH (check_option = local, security_barrier = (true)) AS SELECT 1, 2'), [
      'CREATE OR REPLACE VIEW "public"."active_users" ("as", b) WITH (check_option = local, security_barrier = (true)) AS SELECT 1, 2',
    ]);
    const p = parseViewDdl('CREATE VIEW v (a, b) AS SELECT id AS a, (SELECT 1 AS x) AS b FROM users AS u', 'postgres');
    assert.ok(!('error' in p));
    assert.equal(p.body, 'SELECT id AS a, (SELECT 1 AS x) AS b FROM users AS u');
  });

  it('semicolons inside strings, quoted names and dollar quotes stay in the body', () => {
    const body = (ddl: string, driver: DriverId) => {
      const p = parseViewDdl(ddl, driver);
      assert.ok(!('error' in p), `${driver}: ${'error' in p ? p.error : ''}`);
      return p.body;
    };
    assert.equal(body("CREATE VIEW v AS SELECT 'a;b' AS x;", 'postgres'), "SELECT 'a;b' AS x");
    assert.equal(body('CREATE VIEW v AS SELECT $$a; b$$ AS x, $t$;$t$ AS y;', 'postgres'), 'SELECT $$a; b$$ AS x, $t$;$t$ AS y');
    assert.equal(body('CREATE VIEW v AS SELECT "a;b" FROM t', 'postgres'), 'SELECT "a;b" FROM t');
    assert.equal(body("CREATE VIEW v AS SELECT 'a;b', `c;d` FROM t", 'mysql'), "SELECT 'a;b', `c;d` FROM t");
    assert.equal(body('CREATE VIEW v AS SELECT $$a;b$$ AS x', 'h2'), 'SELECT $$a;b$$ AS x');
    assert.equal(body("CREATE VIEW v AS SELECT 'a;b' /* ; */ AS x -- ;\n", 'sqlite').startsWith("SELECT 'a;b' /* ; */ AS x"), true);
  });

  it('trailing comments are dropped, comments inside the body are kept', () => {
    const p = parseViewDdl('CREATE VIEW v AS SELECT 1 /* keep */ + 2; -- after', 'postgres');
    assert.ok(!('error' in p));
    assert.equal(p.body, 'SELECT 1 /* keep */ + 2');
  });

  it('the inserted OR REPLACE follows the case of CREATE', () => {
    assert.deepEqual(migrate('postgres', 'create view active_users as select 1'), ['create or replace view "public"."active_users" as select 1']);
    assert.deepEqual(migrate('postgres', 'Create View active_users As Select 1'), ['Create OR REPLACE View "public"."active_users" As Select 1']);
  });

  it('IF NOT EXISTS together with OR REPLACE', () => {
    assert.deepEqual(migrate('postgres', 'CREATE OR REPLACE VIEW IF NOT EXISTS active_users AS SELECT 1'), ['CREATE OR REPLACE VIEW "public"."active_users" AS SELECT 1']);
    assert.deepEqual(migrate('h2', 'create view if not exists v as select 1', { schema: 'PUBLIC', name: 'V' }), ['create or replace view "PUBLIC"."V" as select 1']);
    assert.deepEqual(migrate('sqlite', 'CREATE OR REPLACE VIEW IF NOT EXISTS v AS SELECT 1', { schema: 'main', name: 'v' }), [
      'DROP VIEW IF EXISTS "v"',
      'CREATE VIEW IF NOT EXISTS "v" AS SELECT 1',
    ]);
  });

  it('MySQL DEFINER with quoted user@host forms', () => {
    const v = { schema: 'shop', name: 'v' };
    for (const definer of ["'root'@'%'", '`app`@`10.0.%`', 'CURRENT_USER', "'a@b'@'localhost'", '`view`@localhost', 'root@localhost']) {
      assert.deepEqual(migrate('mysql', `CREATE DEFINER=${definer} SQL SECURITY DEFINER VIEW v AS SELECT 1`, v), [
        `CREATE OR REPLACE DEFINER=${definer} SQL SECURITY DEFINER VIEW \`shop\`.\`v\` AS SELECT 1`,
      ], definer);
    }
  });

  it('code style: the view name is always quoted (even "needed"), keyword case for DROP VIEW', () => {
    assert.deepEqual(withCodeStyle(LOWER, () => migrate('postgres', 'CREATE VIEW active_users AS SELECT 1')), ['CREATE OR REPLACE VIEW "public"."active_users" AS SELECT 1']);
    assert.deepEqual(withCodeStyle(LOWER, () => migrate('postgres', 'CREATE VIEW "Active Users" AS SELECT 1', { schema: 'public', name: 'Active Users' })), [
      'CREATE OR REPLACE VIEW "public"."Active Users" AS SELECT 1',
    ]);
    assert.deepEqual(withCodeStyle(LOWER, () => migrate('sqlite', 'CREATE VIEW v AS SELECT 1', { schema: 'main', name: 'v' })), ['drop view if exists "v"', 'CREATE VIEW "v" AS SELECT 1']);
    // H2는 인용하지 않은 이름을 대문자로 접는다 — 소문자 뷰 "myview"를 바꿔야지 새 뷰 MYVIEW를 만들면 안 된다
    assert.deepEqual(withCodeStyle(LOWER, () => migrate('h2', 'CREATE VIEW "PUBLIC"."myview" AS SELECT 1', { schema: 'PUBLIC', name: 'myview' })), [
      'CREATE OR REPLACE VIEW "PUBLIC"."myview" AS SELECT 1',
    ]);
    // SQLite 예약어 이름
    for (const name of ['union', 'having', 'into', 'exists', 'distinct', 'transaction']) {
      assert.deepEqual(withCodeStyle(LOWER, () => migrate('sqlite', `CREATE VIEW "${name}" AS SELECT 1`, { schema: 'main', name })), [
        `drop view if exists "${name}"`,
        `CREATE VIEW "${name}" AS SELECT 1`,
      ]);
    }
    assert.deepEqual(withCodeStyle({ keywordCase: 'upper', quoteIdentifiers: 'always' }, () => migrate('mysql', 'CREATE VIEW v AS SELECT 1', { schema: 'shop', name: 'v' })), [
      'CREATE OR REPLACE VIEW `shop`.`v` AS SELECT 1',
    ]);
  });

  it('sameDefinition ignores whitespace between tokens', () => {
    assert.equal(sameDefinition('SELECT\tid,\r\n name FROM users ;  ', 'SELECT id, name FROM users', 'postgres'), true);
    assert.equal(sameDefinition('', '  ;', 'postgres'), true);
  });

  it('sameDefinition keeps whitespace inside string literals', () => {
    assert.equal(sameDefinition("SELECT 'a  b'", "SELECT 'a b'", 'postgres'), false);
    assert.equal(sameDefinition('SELECT "a  b" FROM t', 'SELECT "a b" FROM t', 'postgres'), false);
  });

  it('viewSourceFromRows for SQLite text that does not parse, or names with spaces', () => {
    const sv = { schema: 'main', name: 'v' };
    const body = (text: string) => viewSourceFromRows('sqlite', sv, [text]).definition;
    assert.equal(body('CREATE VIEW v'), 'CREATE VIEW v');
    assert.equal(body('garbage'), 'garbage');
    assert.equal(body('CREATE TEMP VIEW "a b"(x) AS SELECT 1 AS x'), 'SELECT 1 AS x');
    assert.equal(body("CREATE VIEW v AS SELECT 'x; y' -- c"), "SELECT 'x; y'");
    assert.equal(viewSourceFromRows('postgres', V, [' SELECT 1;', 'v', null]).definition, ' SELECT 1;');
  });
});

describe('view source: more edge cases', () => {
  it('PostgreSQL header for every reloption combination, and with a materialized view', () => {
    const opts = ['security_barrier=true', 'security_invoker=true', 'check_option=local'];
    for (let mask = 0; mask < 8; mask++) {
      const on = opts.filter((_, i) => mask & (1 << i)).join(', ');
      const s = viewSourceFromRows('postgres', V, [' SELECT 1;', 'v', on || null]);
      assert.equal(s.header, `CREATE VIEW "public"."active_users"${on ? ` WITH (${on})` : ''} AS`, on);
      const m = viewMigration('postgres', viewDdlText(s), V);
      assert.ok(!('error' in m), on);
      assert.equal(m.statements[0], `CREATE OR REPLACE VIEW "public"."active_users"${on ? ` WITH (${on})` : ''} AS\nSELECT 1`, on);
    }
    // check_option=cascaded · 빈 글자 reloptions(옵션 없음과 같다)
    assert.equal(viewSourceFromRows('postgres', V, [' SELECT 1;', 'v', 'check_option=cascaded']).header, 'CREATE VIEW "public"."active_users" WITH (check_option=cascaded) AS');
    assert.equal(viewSourceFromRows('postgres', V, [' SELECT 1;', 'v', '']).header, 'CREATE VIEW "public"."active_users" AS');
  });

  it('PostgreSQL mixed-case and special-character names round-trip in both code styles', () => {
    for (const v of [
      { schema: 'My Schema', name: 'MixedCase' },
      { schema: 'public', name: 'select' },
      { schema: 'a"b', name: 'x;y' },
      { schema: 'ünï', name: '1st view' },
    ]) {
      for (const style of [undefined, LOWER]) {
        const r = withCodeStyle(style, () => viewMigration('postgres', viewDdlText(viewSourceFromRows('postgres', v, [' SELECT 1;', 'v', 'security_barrier=true'])), v));
        assert.ok(!('error' in r), `${v.schema}.${v.name}: ${'error' in r ? r.error : ''}`);
      }
    }
    // needed 스타일이라도 대소문자가 섞인 이름은 인용한다(인용하지 않으면 접혀서 다른 뷰가 된다)
    assert.equal(withCodeStyle(LOWER, () => viewSourceFromRows('postgres', { schema: 'public', name: 'MixedCase' }, [' SELECT 1;', 'v', null]).header), 'create view public."MixedCase" as');
    // 대소문자가 다른 인용 이름은 다른 뷰다
    assert.match(refused('postgres', 'CREATE VIEW public."mixedcase" AS SELECT 1', { schema: 'public', name: 'MixedCase' }), /Renaming/);
  });

  it('MySQL: SHOW CREATE VIEW missing or unparsable falls back to a plain header; CHECK_OPTION values', () => {
    const v = { schema: 'shop', name: 'v' };
    assert.equal(viewSourceFromRows('mysql', v, ['select 1', 'NONE'], []).header, 'CREATE VIEW `shop`.`v` AS');
    assert.equal(viewSourceFromRows('mysql', v, ['select 1', 'NONE'], [[['v', 'garbage']]]).header, 'CREATE VIEW `shop`.`v` AS');
    assert.equal(viewSourceFromRows('mysql', v, ['select 1', 'NONE'], [[['v', null]]]).header, 'CREATE VIEW `shop`.`v` AS');
    assert.equal(viewSourceFromRows('mysql', v, ['select 1', null]).trailer, '');
    assert.equal(viewSourceFromRows('mysql', v, ['select 1', 'local']).trailer, ' WITH LOCAL CHECK OPTION');
    assert.equal(viewSourceFromRows('mysql', v, ['select 1', 'CASCADED']).trailer, ' WITH CASCADED CHECK OPTION');
    assert.equal(viewSourceFromRows('mysql', v, ['select 1', 'YES']).trailer, '');
    assert.equal(withCodeStyle(LOWER, () => viewSourceFromRows('mysql', v, ['select 1', 'LOCAL']).trailer), ' with local check option');
  });

  it('MySQL: each ALGORITHM, DEFINER form and SQL SECURITY from SHOW CREATE VIEW survives open → Submit', () => {
    const v = { schema: 'we`ird', name: 'my view' };
    for (const algorithm of ['UNDEFINED', 'MERGE', 'TEMPTABLE']) {
      for (const definer of ['`root`@`localhost`', '`app`@`%`', '`a.b`@`10.0.0.%`', '`x@y`@`::1`', 'CURRENT_USER']) {
        for (const security of ['DEFINER', 'INVOKER']) {
          const create = `CREATE ALGORITHM=${algorithm} DEFINER=${definer} SQL SECURITY ${security} VIEW \`my view\` (\`a\`) AS select 1 AS \`a\` WITH CASCADED CHECK OPTION`;
          const s = viewSourceFromRows('mysql', v, ['select 1 AS `a`', 'CASCADED'], [[['my view', create]]]);
          const m = viewMigration('mysql', viewDdlText(s), v);
          assert.ok(!('error' in m), create);
          assert.equal(
            m.statements[0],
            `CREATE OR REPLACE ALGORITHM=${algorithm} DEFINER=${definer} SQL SECURITY ${security} VIEW \`we\`\`ird\`.\`my view\` (\`a\`) AS\nselect 1 AS \`a\` WITH CASCADED CHECK OPTION`,
          );
        }
      }
    }
  });

  it('SQLite: column list, TEMP and several triggers are kept in order; no triggers row means none', () => {
    const v = { schema: 'main', name: 'v' };
    const triggers = ['CREATE TRIGGER a INSTEAD OF INSERT ON v BEGIN SELECT 1; END', 'CREATE TRIGGER "b c" INSTEAD OF UPDATE OF x ON "V" BEGIN SELECT 2; END', 'CREATE TRIGGER d INSTEAD OF DELETE ON v BEGIN SELECT 3; END'];
    const s = viewSourceFromRows('sqlite', v, ['CREATE TEMP VIEW v (x, "y z") AS SELECT 1, 2'], [triggers.map((t) => [t])]);
    assert.deepEqual([s.header, s.definition, s.triggers], ['CREATE TEMP VIEW v (x, "y z") AS', 'SELECT 1, 2', triggers]);
    assert.deepEqual(migrate('sqlite', viewDdlText(s), v, s.triggers), ['DROP VIEW IF EXISTS "v"', 'CREATE TEMP VIEW "v" (x, "y z") AS\nSELECT 1, 2', ...triggers]);
    assert.deepEqual(viewSourceFromRows('sqlite', v, ['CREATE VIEW v AS SELECT 1']).triggers, []);
    // 트리거는 SQLite에서만 모은다
    assert.deepEqual(viewSourceFromRows('h2', { schema: 'PUBLIC', name: 'V' }, ['SELECT 1'], [[['CREATE TRIGGER x']]]).triggers, []);
  });

  it('readViewSource runs every query in order and hands the rest to viewSourceFromRows', async () => {
    const asked: string[] = [];
    const trigger = 'CREATE TRIGGER t INSTEAD OF INSERT ON v BEGIN SELECT 1; END';
    const run = async (q: { sql: string; params: string[] }) => {
      asked.push(q.params.join(','));
      return /type = 'view'/.test(q.sql) ? [['CREATE VIEW v(a) AS SELECT 1']] : [[trigger]];
    };
    const s = await readViewSource('sqlite', { schema: 'main', name: 'v' }, run, LOWER);
    assert.deepEqual(asked, ['v', 'v']);
    assert.deepEqual(s?.triggers, [trigger]);
    // SQLite 머리는 저장된 원문 그대로라 코드 스타일과 상관없다
    assert.equal(s?.header, 'CREATE VIEW v(a) AS');
    // MySQL: SHOW CREATE VIEW가 실패하면(권한) 그 오류가 그대로 올라간다
    const failing = async (q: { sql: string }) => {
      if (q.sql.startsWith('SHOW')) throw new Error('SHOW VIEW command denied');
      return [['select 1', 'NONE']];
    };
    await assert.rejects(readViewSource('mysql', { schema: 'shop', name: 'v' }, failing), /denied/);
  });

  it('sameDefinition per dialect: strings, quoted identifiers and dollar quotes keep their insides', () => {
    const same = (a: string, b: string, d: DriverId) => sameDefinition(a, b, d);
    assert.equal(same("SELECT 'a''  b'", "SELECT 'a'' b'", 'postgres'), false);
    assert.equal(same("SELECT E'a\\'  b'", "SELECT E'a\\' b'", 'postgres'), false);
    assert.equal(same("SELECT 'a\\'  b'", "SELECT 'a\\' b'", 'mysql'), false);
    assert.equal(same('SELECT $$a  b$$', 'SELECT $$a b$$', 'postgres'), false);
    assert.equal(same('SELECT $x$a$x$', 'SELECT $$a$$', 'postgres'), false);
    assert.equal(same('SELECT $$a  b$$', 'SELECT $$a b$$', 'h2'), false);
    assert.equal(same('SELECT "A"', 'SELECT "a"', 'postgres'), false);
    assert.equal(same('SELECT `a  b` FROM t', 'SELECT `a b` FROM t', 'mysql'), false);
    assert.equal(same('SELECT [a  b] FROM t', 'SELECT [a b] FROM t', 'sqlite'), false);
    assert.equal(same("SELECT ';'", "SELECT ''", 'postgres'), false);
    // 키워드 대소문자 · 숫자 표기는 DB가 정한 글자 그대로 비교한다
    assert.equal(same('select 1', 'SELECT 1', 'postgres'), false);
    assert.equal(same('SELECT 1.0', 'SELECT 1.00', 'postgres'), false);
  });

  it('sameDefinition per dialect: comments (block, nested, line, MySQL #) and any number of trailing semicolons', () => {
    assert.equal(sameDefinition('SELECT 1 /* a /* b */ c */', 'SELECT 1', 'postgres'), true);
    assert.equal(sameDefinition('SELECT 1 -- x\n+ 2', 'SELECT 1 + 2', 'postgres'), true);
    assert.equal(sameDefinition('SELECT 1 /* x */+ 2', 'SELECT 1 + 2', 'sqlite'), true);
    assert.equal(sameDefinition('SELECT 1 # c', 'SELECT 1', 'mysql'), true);
    // PostgreSQL에서 # 는 연산자다
    assert.equal(sameDefinition('SELECT 1 # c', 'SELECT 1', 'postgres'), false);
    assert.equal(sameDefinition('SELECT 1;;  ; -- x', 'SELECT 1', 'postgres'), true);
    // 가운데의 ; 는 지우지 않는다
    assert.equal(sameDefinition('SELECT 1; SELECT 2', 'SELECT 1 SELECT 2', 'postgres'), false);
  });

  it('sameSource compares header and trailer token by token, not the triggers', () => {
    const v = { schema: 'shop', name: 'v' };
    const a = viewSourceFromRows('mysql', v, ['select 1', 'LOCAL']);
    const b = viewSourceFromRows('mysql', v, ['select 1', 'CASCADED']);
    assert.equal(sameSource(a, b, 'mysql'), false);
    assert.equal(sameSource(a, { ...a, header: a.header.replace(' ', '\n  ') }, 'mysql'), true);
    assert.equal(sameSource(a, { ...a, definition: 'select 2' }, 'mysql'), false);
    // 트리거 목록은 Submit 때 새로 읽은 것을 쓰므로 비교하지 않는다
    assert.equal(sameSource({ ...a, triggers: ['x'] }, { ...a, triggers: [] }, 'mysql'), true);
  });

  it('viewDdlText trims the body and one trailing semicolon, and keeps a body-internal semicolon in a string', () => {
    assert.equal(viewDdlText({ header: 'CREATE VIEW v AS', definition: '\n  SELECT 1;  \n', trailer: '' }), 'CREATE VIEW v AS\nSELECT 1;\n');
    assert.equal(viewDdlText({ header: 'CREATE VIEW v AS', definition: "SELECT ';'", trailer: '' }), "CREATE VIEW v AS\nSELECT ';';\n");
    assert.equal(viewDdlText({ header: 'H', definition: 'SELECT 1;', trailer: ' WITH LOCAL CHECK OPTION' }), 'H\nSELECT 1 WITH LOCAL CHECK OPTION;\n');
  });

  it('SQLite migration: DROP VIEW IF EXISTS first, triggers last, OR REPLACE dropped, IF NOT EXISTS kept', () => {
    const v = { schema: 'main', name: 'v' };
    const trig = ['CREATE TRIGGER a INSTEAD OF INSERT ON v BEGIN SELECT 1; END', 'CREATE TRIGGER b INSTEAD OF DELETE ON v BEGIN SELECT 2; END'];
    assert.deepEqual(migrate('sqlite', 'create or replace view if not exists main.v as select 1', v, trig), ['DROP VIEW IF EXISTS "v"', 'create view if not exists "v" as select 1', ...trig]);
    // 거부되면 트리거도 돌려주지 않는다
    assert.ok('error' in viewMigration('sqlite', 'CREATE VIEW other AS SELECT 1', v, trig));
  });
});

describe('view migration: name quoting, OR REPLACE and SQLite recreate', () => {
  const sv = (name: string) => ({ schema: 'main', name });

  it('SQLite reserved names written with [ ], ` ` or without quotes become "name" in both statements', () => {
    assert.deepEqual(withCodeStyle(LOWER, () => migrate('sqlite', 'CREATE VIEW [order] AS SELECT 1', sv('order'))), ['drop view if exists "order"', 'CREATE VIEW "order" AS SELECT 1']);
    assert.deepEqual(withCodeStyle(LOWER, () => migrate('sqlite', 'CREATE VIEW `select` AS SELECT 1', sv('select'))), ['drop view if exists "select"', 'CREATE VIEW "select" AS SELECT 1']);
    assert.deepEqual(withCodeStyle(LOWER, () => migrate('sqlite', 'CREATE VIEW Union AS SELECT 1', sv('union'))), ['drop view if exists "union"', 'CREATE VIEW "union" AS SELECT 1']);
  });

  it('SQLite: an unquoted name in another case is the same view; quoted names must match exactly', () => {
    assert.deepEqual(migrate('sqlite', 'CREATE VIEW V AS SELECT 1', sv('v')), ['DROP VIEW IF EXISTS "v"', 'CREATE VIEW "v" AS SELECT 1']);
    // 인용한 이름의 대소문자를 바꾸면 sqlite_master의 이름이 바뀐다 — 이름 바꾸기로 본다
    assert.match(refused('sqlite', 'CREATE VIEW "V" AS SELECT 1', sv('v')), /Renaming/);
  });

  it('SQLite: the triggers come back verbatim after DROP + CREATE, also with IF NOT EXISTS and a column list in lower case', () => {
    const trig = ['create trigger "t 1" instead of update on "v" begin select 1; end'];
    assert.deepEqual(withCodeStyle(LOWER, () => migrate('sqlite', 'create view if not exists v (a) as select 1', sv('v'), trig)), [
      'drop view if exists "v"',
      'create view if not exists "v" (a) as select 1',
      ...trig,
    ]);
    // 트리거가 없으면 두 문장만
    assert.deepEqual(migrate('sqlite', 'CREATE OR REPLACE VIEW v AS SELECT 1', sv('v'), []), ['DROP VIEW IF EXISTS "v"', 'CREATE VIEW "v" AS SELECT 1']);
  });

  it('H2: unquoted names in the DDL target the stored name exactly (upper case, mixed case, a schema with a space)', () => {
    assert.deepEqual(withCodeStyle(LOWER, () => migrate('h2', 'CREATE FORCE VIEW myview AS SELECT 1', { schema: 'PUBLIC', name: 'MYVIEW' })), [
      'CREATE OR REPLACE FORCE VIEW "PUBLIC"."MYVIEW" AS SELECT 1',
    ]);
    // 따옴표로 만든 MyView를 따옴표 없이 써도 MYVIEW라는 새 뷰를 만들지 않는다
    assert.deepEqual(withCodeStyle(LOWER, () => migrate('h2', 'create view MyView as select 1', { schema: 'PUBLIC', name: 'MyView' })), ['create or replace view "PUBLIC"."MyView" as select 1']);
    assert.deepEqual(withCodeStyle(LOWER, () => migrate('h2', 'CREATE VIEW v AS SELECT 1', { schema: 'my schema', name: 'v' })), ['CREATE OR REPLACE VIEW "my schema"."v" AS SELECT 1']);
    assert.deepEqual(withCodeStyle(LOWER, () => migrate('h2', 'CREATE OR REPLACE FORCE VIEW IF NOT EXISTS PUBLIC.v AS SELECT 1', { schema: 'PUBLIC', name: 'V' })), [
      'CREATE OR REPLACE FORCE VIEW "PUBLIC"."V" AS SELECT 1',
    ]);
  });

  it('PostgreSQL and MySQL reserved and mixed-case names are quoted with the "needed" code style too', () => {
    assert.deepEqual(withCodeStyle(LOWER, () => migrate('postgres', 'CREATE VIEW "order" AS SELECT 1', { schema: 'public', name: 'order' })), ['CREATE OR REPLACE VIEW "public"."order" AS SELECT 1']);
    assert.deepEqual(withCodeStyle(LOWER, () => migrate('postgres', 'CREATE VIEW MyView AS SELECT 1', { schema: 'public', name: 'MyView' })), ['CREATE OR REPLACE VIEW "public"."MyView" AS SELECT 1']);
    assert.deepEqual(withCodeStyle(LOWER, () => migrate('mysql', 'CREATE VIEW v AS SELECT 1', { schema: 'shop', name: 'v' })), ['CREATE OR REPLACE VIEW `shop`.`v` AS SELECT 1']);
    assert.deepEqual(withCodeStyle(LOWER, () => migrate('mysql', 'CREATE VIEW `order` AS SELECT 1', { schema: 'shop', name: 'order' })), ['CREATE OR REPLACE VIEW `shop`.`order` AS SELECT 1']);
    // MySQL: 백틱 안 대소문자가 다르면 이름 바꾸기로 본다
    assert.match(refused('mysql', 'CREATE VIEW `V` AS SELECT 1', { schema: 'shop', name: 'v' }), /Renaming/);
  });

  it('OR REPLACE goes right after CREATE, before TEMP / RECURSIVE / FORCE, and an existing one is not doubled', () => {
    assert.deepEqual(migrate('postgres', 'CREATE TEMP VIEW active_users AS SELECT 1'), ['CREATE OR REPLACE TEMP VIEW "public"."active_users" AS SELECT 1']);
    assert.deepEqual(migrate('postgres', 'CREATE RECURSIVE VIEW active_users (n) AS SELECT 1'), ['CREATE OR REPLACE RECURSIVE VIEW "public"."active_users" (n) AS SELECT 1']);
    assert.deepEqual(migrate('postgres', 'CREATE OR REPLACE TEMPORARY RECURSIVE VIEW active_users (n) AS SELECT 1'), [
      'CREATE OR REPLACE TEMPORARY RECURSIVE VIEW "public"."active_users" (n) AS SELECT 1',
    ]);
    assert.deepEqual(migrate('h2', 'CREATE FORCE VIEW V AS SELECT 1', { schema: 'PUBLIC', name: 'V' }), ['CREATE OR REPLACE FORCE VIEW "PUBLIC"."V" AS SELECT 1']);
    assert.deepEqual(migrate('postgres', 'cReAtE VIEW active_users AS SELECT 1'), ['cReAtE OR REPLACE VIEW "public"."active_users" AS SELECT 1']);
  });

  it('the name is replaced in place: no space added before a column list, a comment or AS', () => {
    assert.deepEqual(migrate('postgres', 'CREATE VIEW active_users(a)AS SELECT 1'), ['CREATE OR REPLACE VIEW "public"."active_users"(a)AS SELECT 1']);
    assert.deepEqual(migrate('postgres', 'CREATE VIEW active_users/*c*/AS SELECT 1'), ['CREATE OR REPLACE VIEW "public"."active_users"/*c*/AS SELECT 1']);
    // IF NOT EXISTS 뒤의 탭은 함께 지우고, 줄바꿈은 남긴다
    assert.deepEqual(migrate('postgres', 'CREATE VIEW IF NOT EXISTS\tactive_users AS SELECT 1'), ['CREATE OR REPLACE VIEW "public"."active_users" AS SELECT 1']);
    assert.deepEqual(migrate('postgres', 'CREATE VIEW IF NOT EXISTS\nactive_users AS SELECT 1'), ['CREATE OR REPLACE VIEW \n"public"."active_users" AS SELECT 1']);
  });

  it('the editor view name is used even when the DDL writes the schema in another case', () => {
    assert.deepEqual(migrate('postgres', 'CREATE VIEW public.v AS SELECT 1', { schema: 'Public', name: 'v' }), ['CREATE OR REPLACE VIEW "Public"."v" AS SELECT 1']);
  });
});
