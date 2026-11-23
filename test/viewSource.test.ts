import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withCodeStyle } from '../src/core/ddl';
import { classifySql } from '../src/core/classify';
import { definitionFromRow, parseViewDdl, sameDefinition, viewDdlText, viewDefinitionQuery, viewMigration } from '../src/core/viewSource';
import type { DriverId } from '../src/drivers/types';

const V = { schema: 'public', name: 'active_users' };
const migrate = (driver: DriverId, ddl: string, v = V) => {
  const r = viewMigration(driver, ddl, v);
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
    assert.equal(viewDdlText('postgres', V, ' SELECT id FROM users;  '), 'CREATE VIEW "public"."active_users" AS\nSELECT id FROM users;\n');
    assert.equal(
      withCodeStyle({ keywordCase: 'lower', quoteIdentifiers: 'needed' }, () => viewDdlText('mysql', { schema: 'shop', name: 'v' }, 'select 1')),
      'create view shop.v as\nselect 1;\n',
    );
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
    assert.deepEqual(migrate('sqlite', 'CREATE VIEW v AS SELECT 1', v), ['DROP VIEW "v"', 'CREATE VIEW "v" AS SELECT 1']);
    assert.deepEqual(migrate('sqlite', 'CREATE OR REPLACE VIEW main.v AS SELECT 1', v), ['DROP VIEW "v"', 'CREATE VIEW "v" AS SELECT 1']);
    assert.deepEqual(migrate('sqlite', 'CREATE TEMP VIEW IF NOT EXISTS "v" AS SELECT 1', v), ['DROP VIEW "v"', 'CREATE TEMP VIEW IF NOT EXISTS "v" AS SELECT 1']);
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
  it('reads the body out of the SQLite CREATE VIEW text', () => {
    assert.deepEqual(definitionFromRow('sqlite', ['CREATE VIEW v(a) AS SELECT 1 AS a']), { definition: 'SELECT 1 AS a', materialized: false });
    assert.deepEqual(definitionFromRow('postgres', [' SELECT 1;', 'm']), { definition: ' SELECT 1;', materialized: true });
    assert.equal(definitionFromRow('mysql', [null]), undefined);
    assert.equal(definitionFromRow('h2', undefined), undefined);
  });

  it('compares definitions ignoring whitespace and a trailing semicolon', () => {
    assert.equal(sameDefinition(' SELECT id\n   FROM users;', 'SELECT id FROM users'), true);
    assert.equal(sameDefinition('SELECT id FROM users', 'SELECT name FROM users'), false);
  });

  it('the definition queries are read-only for the classifier', () => {
    for (const d of ['postgres', 'mysql', 'sqlite', 'h2'] as const) {
      const q = viewDefinitionQuery(d, V);
      assert.equal(classifySql(q.sql, d).kind, 'read', d);
      assert.ok(q.params.length >= 1, d);
    }
  });

  it('parses a statement surrounded by comments', () => {
    const p = parseViewDdl('/* a */ CREATE VIEW v AS SELECT 1 -- b', 'postgres');
    assert.ok(!('error' in p));
    assert.equal(p.body, 'SELECT 1');
  });
});
