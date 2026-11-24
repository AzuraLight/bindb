// 뷰 DDL 편집기(Go to DDL → Submit): 실제 VS Code에서 문서를 열고 고쳐 보낸 뒤 DB를 확인한다(SQLite).
// 대화상자에 답해야 하는 경로(충돌 · Synchronize · 미리보기)는 다루지 않는다
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(50);
  }
}
/** p가 ms 안에 끝나지 않으면 실패(모달 대화상자가 떠서 기다리는 경우) */
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => assert.fail(`${what} did not finish within ${ms} ms (a dialog is probably waiting)`))]);
/**
 * vscode.window의 메시지 함수를 바꿔 끼워 대화상자에 답한다(테스트 파일은 확장 폴더 안이라 확장과 같은 vscode 객체를 쓴다).
 * @param answers 메시지 글자를 받아 고를 버튼 이름을 돌려준다(undefined = 닫음)
 * @returns 보인 메시지들과 되돌리는 함수
 */
function answerDialogs(method, answers) {
  const original = vscode.window[method];
  const shown = [];
  vscode.window[method] = async (message) => {
    shown.push(message);
    return answers(message);
  };
  return { shown, restore: () => (vscode.window[method] = original) };
}

describe('view DDL editor', function () {
  let api;
  let cfg;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindb-viewddl-'));

  const rows = async (sql) => {
    const c = await api.sessions.execute(cfg, sql);
    const r = (await c.fetch(1000)).rows;
    await c.close();
    return r;
  };
  const viewNode = async (name) => {
    const table = (await api.sessions.metadata(cfg, true)).find((t) => t.name === name);
    assert.ok(table, `view ${name} in metadata`);
    return { kind: 'table', cfg: api.store.get(cfg.id), table };
  };
  /** Go to DDL로 열고 그 편집기를 돌려준다 */
  const goToDdl = async (name) => {
    await vscode.commands.executeCommand('bindb.ddl.goToDdl', await viewNode(name));
    return until(() => {
      const e = vscode.window.activeTextEditor;
      return e?.document.uri.scheme === 'bindb-ddl' && e.document.uri.path.endsWith(`/${name}.sql`) && e;
    });
  };
  const replaceAll = (editor, text) =>
    editor.edit((b) => b.replace(new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)), text));

  before(async () => {
    api = await vscode.extensions.getExtension('AzuraLight.bindb').activate();
    cfg = await api.store.add({ name: 'viewddltest', driver: 'sqlite', file: path.join(dir, 'v.db') });
    for (const sql of [
      'CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT)',
      "INSERT INTO people VALUES (1, 'Ann'), (2, 'Bo')",
      'CREATE TABLE log (msg TEXT)',
      'CREATE VIEW names AS SELECT id, name FROM people',
      "CREATE TRIGGER names_ins INSTEAD OF INSERT ON names BEGIN INSERT INTO log VALUES ('ins ' || NEW.name); END",
      'CREATE VIEW plain AS SELECT id FROM people',
    ]) {
      await (await api.sessions.execute(cfg, sql)).close();
    }
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.sessions.disconnect(cfg.id);
    await api.store.remove(cfg.id);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('Go to DDL opens the view definition; Submit replaces the view and keeps its trigger', async () => {
    const editor = await goToDdl('names');
    const text = editor.document.getText();
    assert.match(text, /^CREATE VIEW names AS\nSELECT id, name FROM people;\n$/);

    assert.ok(await replaceAll(editor, "CREATE VIEW names AS\nSELECT id, upper(name) AS name FROM people;\n"));
    await within(vscode.commands.executeCommand('bindb.ddl.submit', editor.document.uri), 15000, 'Submit');

    assert.deepEqual(await rows('SELECT name FROM names ORDER BY id'), [['ANN'], ['BO']]);
    // DROP VIEW가 지운 트리거를 다시 만들었다
    await (await api.sessions.execute(cfg, "INSERT INTO names (id, name) VALUES (3, 'Cy')")).close();
    assert.deepEqual(await rows('SELECT msg FROM log'), [['ins Cy']]);
    // 저장한 편집이 Submit 뒤 비워지고, 문서는 DB의 새 정의를 보여 준다
    await until(() => /upper\(name\)/.test(editor.document.getText()) && !editor.document.isDirty);
  });

  it('Run Statement does nothing in a DDL editor (no binding line, nothing executed)', async () => {
    const editor = await goToDdl('plain');
    const before = editor.document.getText();
    assert.ok(await replaceAll(editor, 'CREATE VIEW plain AS\nSELECT id, name FROM people;\n'));
    await within(vscode.commands.executeCommand('bindb.runStatement'), 5000, 'Run Statement');
    // 문서에 -- @conn 줄이 끼지 않았고, DB의 뷰는 그대로다
    assert.doesNotMatch(editor.document.getText(), /@conn/);
    assert.deepEqual(await rows('SELECT * FROM plain ORDER BY id'), [[1], [2]]);
    await replaceAll(editor, before);
    await editor.document.save();
  });

  describe('Submit when the view changed in the database after editing started', () => {
    let n = 0;
    /** 편집기를 열고, DB에서 뷰를 바꾼 뒤, 편집기에서 다른 정의로 고친다 */
    const conflict = async () => {
      n++;
      await run('DROP VIEW IF EXISTS conflicted');
      await run('CREATE VIEW conflicted AS SELECT 1 AS v');
      const editor = await goToDdl('conflicted');
      await run('DROP VIEW conflicted');
      await run(`CREATE VIEW conflicted AS SELECT ${100 + n} AS v`);
      assert.ok(await replaceAll(editor, 'CREATE VIEW conflicted AS\nSELECT 2 AS v;\n'));
      return editor;
    };
    const run = async (sql) => (await api.sessions.execute(cfg, sql)).close();
    let warn;
    afterEach(async () => {
      warn?.restore();
      warn = undefined;
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    it('Force Refactoring replaces the database version with the edited DDL', async () => {
      const editor = await conflict();
      warn = answerDialogs('showWarningMessage', (m) => (/changed in the database/.test(m) ? 'Force Refactoring' : undefined));
      await within(vscode.commands.executeCommand('bindb.ddl.submit', editor.document.uri), 15000, 'Submit');
      assert.deepEqual(warn.shown.filter((m) => /changed in the database/.test(m)).length, 1);
      assert.deepEqual(await rows('SELECT v FROM conflicted'), [[2]]);
    });

    it('closing the conflict dialog submits nothing and keeps the local edit', async () => {
      const editor = await conflict();
      warn = answerDialogs('showWarningMessage', () => undefined);
      await within(vscode.commands.executeCommand('bindb.ddl.submit', editor.document.uri), 15000, 'Submit');
      assert.deepEqual(await rows('SELECT v FROM conflicted'), [[100 + n]]);
      assert.match(editor.document.getText(), /SELECT 2 AS v/);
    });

    it('Abort Refactoring and Synchronize → Revert local changes shows the database version', async () => {
      const editor = await conflict();
      warn = answerDialogs('showWarningMessage', (m) =>
        /changed in the database/.test(m) ? 'Abort Refactoring and Synchronize' : /you have local changes/.test(m) ? 'Revert local changes' : undefined,
      );
      await within(vscode.commands.executeCommand('bindb.ddl.submit', editor.document.uri), 15000, 'Submit');
      assert.deepEqual(await rows('SELECT v FROM conflicted'), [[100 + n]]);
      await until(() => new RegExp(`SELECT ${100 + n} AS v`).test(editor.document.getText()) && !editor.document.isDirty);
      // 저장한 편집이 사라졌으니 다시 Submit할 것이 없다
      const info = answerDialogs('showInformationMessage', () => undefined);
      try {
        await vscode.commands.executeCommand('bindb.ddl.submit', editor.document.uri);
        assert.deepEqual(info.shown, ['No changes to submit.']);
      } finally {
        info.restore();
      }
    });

    it('Abort … → Keep local changes keeps the edit, and the next Submit runs it without asking again', async () => {
      const editor = await conflict();
      warn = answerDialogs('showWarningMessage', (m) =>
        /changed in the database/.test(m) ? 'Abort Refactoring and Synchronize' : /you have local changes/.test(m) ? 'Keep local changes' : undefined,
      );
      await within(vscode.commands.executeCommand('bindb.ddl.submit', editor.document.uri), 15000, 'Submit');
      assert.match(editor.document.getText(), /SELECT 2 AS v/);
      assert.deepEqual(await rows('SELECT v FROM conflicted'), [[100 + n]]);
      // 편집을 시작한 정의가 DB와 같아졌으므로 이번에는 묻지 않고 보낸다
      warn.shown.length = 0;
      await within(vscode.commands.executeCommand('bindb.ddl.submit', editor.document.uri), 15000, 'Submit');
      assert.deepEqual(warn.shown, []);
      assert.deepEqual(await rows('SELECT v FROM conflicted'), [[2]]);
    });

    it('Abort … → Merge opens a diff of the database and local versions', async () => {
      const editor = await conflict();
      warn = answerDialogs('showWarningMessage', (m) =>
        /changed in the database/.test(m) ? 'Abort Refactoring and Synchronize' : /you have local changes/.test(m) ? 'Merge' : undefined,
      );
      await within(vscode.commands.executeCommand('bindb.ddl.submit', editor.document.uri), 15000, 'Submit');
      const tab = await until(() => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab;
        return t?.input instanceof vscode.TabInputTextDiff && t;
      });
      assert.equal(tab.input.original.query, 'db');
      assert.equal(tab.input.modified.toString(), editor.document.uri.toString());
      const db = await vscode.workspace.openTextDocument(tab.input.original);
      assert.match(db.getText(), new RegExp(`SELECT ${100 + n} AS v`));
      assert.deepEqual(await rows('SELECT v FROM conflicted'), [[100 + n]]);
    });
  });
});

// PostgreSQL은 편집기 머리(CREATE VIEW 이름 [WITH (…)] AS)를 코드 스타일로 만든다 — 스타일만 바뀐 것을 충돌로 보지 않는지 본다.
// 실제 서버가 있을 때만: BINDB_TEST_PG=host:port (사용자 postgres, 비밀번호 없음)
describe('view DDL editor (PostgreSQL)', function () {
  let api;
  let cfg;
  const at = process.env.BINDB_TEST_PG;
  const view = 'bindb_viewddl_style';

  const run = async (sql) => (await api.sessions.execute(cfg, sql)).close();
  const rows = async (sql) => {
    const c = await api.sessions.execute(cfg, sql);
    const r = (await c.fetch(1000)).rows;
    await c.close();
    return r;
  };

  before(async function () {
    if (!at) this.skip();
    const [host, port] = at.split(':');
    api = await vscode.extensions.getExtension('AzuraLight.bindb').activate();
    cfg = await api.store.add({ name: 'viewddl-pg', driver: 'postgres', host, port: Number(port), database: 'postgres', user: 'postgres' });
    await run(`DROP VIEW IF EXISTS public.${view}`);
    await run(`CREATE VIEW public.${view} WITH (security_barrier = true) AS SELECT 1 AS id`);
  });

  after(async () => {
    if (!cfg) return;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await run(`DROP VIEW IF EXISTS public.${view}`).catch(() => {});
    await api.sessions.disconnect(cfg.id);
    await api.store.remove(cfg.id);
  });

  it('changing the code style after opening is not taken as a change in the database (no conflict dialog)', async () => {
    const table = (await api.sessions.metadata(cfg, true)).find((t) => t.schema === 'public' && t.name === view);
    assert.ok(table, 'view in metadata');
    await vscode.commands.executeCommand('bindb.ddl.goToDdl', { kind: 'table', cfg: api.store.get(cfg.id), table });
    const editor = await until(() => {
      const e = vscode.window.activeTextEditor;
      return e?.document.uri.scheme === 'bindb-ddl' && e.document.uri.path.endsWith(`/${view}.sql`) && e;
    });
    // 기본 스타일(대문자 · 늘 인용)로 만든 머리
    assert.match(editor.document.getText(), new RegExp(`^CREATE VIEW "public"\\."${view}" WITH \\(security_barrier=true\\) AS\\n`));

    const { id, ...rest } = api.store.get(cfg.id);
    await api.store.update(id, { ...rest, codeStyle: { keywordCase: 'lower', quoteIdentifiers: 'needed' } });
    const edited = `CREATE VIEW "public"."${view}" WITH (security_barrier=true) AS\nSELECT 2 AS id;\n`;
    await editor.edit((b) => b.replace(new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)), edited));
    // 고치기 전에는 DB에서 다시 읽은 머리가 소문자라 "changed in the database" 모달이 떠서 여기서 멈췄다
    await within(vscode.commands.executeCommand('bindb.ddl.submit', editor.document.uri), 15000, 'Submit');
    assert.deepEqual(await rows(`SELECT id FROM public.${view}`), [[2]]);
    // 속성(security_barrier)도 남았다
    assert.deepEqual(await rows(`SELECT array_to_string(reloptions, ',') FROM pg_class WHERE relname = '${view}'`), [['security_barrier=true']]);
  });

  describe('Warn when editing outdated DDL (the cached definition differs from the database)', () => {
    let warn;
    afterEach(async () => {
      warn?.restore();
      warn = undefined;
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
    /** 캐시(구조 정보)를 읽은 뒤 DB에서 뷰를 바꾸고, 캐시의 테이블로 Go to DDL을 연다 */
    const openOutdated = async (name) => {
      await run(`CREATE OR REPLACE VIEW public.${name} AS SELECT 1 AS id`);
      const table = (await api.sessions.metadata(cfg, true)).find((t) => t.schema === 'public' && t.name === name);
      assert.match(table.definition ?? '', /SELECT 1 AS id/);
      await run(`CREATE OR REPLACE VIEW public.${name} AS SELECT 5 AS id`);
      await vscode.commands.executeCommand('bindb.ddl.goToDdl', { kind: 'table', cfg: api.store.get(cfg.id), table });
      return until(() => {
        const e = vscode.window.activeTextEditor;
        return e?.document.uri.path.endsWith(`/${name}.sql`) && e;
      });
    };
    after(async () => {
      if (!cfg) return;
      for (const v of ['bindb_outdated_sync', 'bindb_outdated_off']) await run(`DROP VIEW IF EXISTS public.${v}`).catch(() => {});
    });

    it('opens the cached definition and Synchronize loads the database version', async () => {
      warn = answerDialogs('showWarningMessage', (m) => (/differs from the database/.test(m) ? 'Synchronize' : undefined));
      const editor = await openOutdated('bindb_outdated_sync');
      await until(() => warn.shown.some((m) => /cached DDL of public\.bindb_outdated_sync differs/.test(m)));
      await until(() => /SELECT 5 AS id/.test(editor.document.getText()));
    });

    it('Disable check turns the warning off for this data source', async () => {
      warn = answerDialogs('showWarningMessage', (m) => (/differs from the database/.test(m) ? 'Disable check' : undefined));
      const info = answerDialogs('showInformationMessage', () => undefined);
      try {
        const editor = await openOutdated('bindb_outdated_off');
        await until(() => api.store.get(cfg.id).warnOutdatedDdl === false);
        assert.match(info.shown.join('\n'), /Outdated DDL warnings are off/);
        // 끈 뒤에는 캐시 그대로(옛 정의) 남는다
        assert.match(editor.document.getText(), /SELECT 1 AS id/);
      } finally {
        info.restore();
        const { id, ...rest } = api.store.get(cfg.id);
        await api.store.update(id, { ...rest, warnOutdatedDdl: undefined });
      }
    });
  });
});

// MySQL · Manual 트랜잭션: DDL은 열린 트랜잭션을 바로 커밋한다 — Submit 뒤 안내가 그렇게 말하고, 실제로도 커밋됐는지 본다.
// 실제 서버가 있을 때만: BINDB_TEST_MYSQL=host:port (사용자 root, 비밀번호 없음 · 데이터베이스 bindb_viewddl을 만든다)
describe('view DDL editor (MySQL, manual transaction control)', function () {
  let api;
  let admin;
  let cfg;
  const at = process.env.BINDB_TEST_MYSQL;
  const run = async (c, sql) => (await api.sessions.execute(c, sql)).close();
  const rows = async (c, sql) => {
    const cur = await api.sessions.execute(c, sql);
    const r = (await cur.fetch(1000)).rows;
    await cur.close();
    return r;
  };

  before(async function () {
    if (!at) this.skip();
    const [host, port] = at.split(':');
    api = await vscode.extensions.getExtension('AzuraLight.bindb').activate();
    admin = await api.store.add({ name: 'viewddl-my-admin', driver: 'mysql', host, port: Number(port), user: 'root' });
    await run(admin, 'DROP DATABASE IF EXISTS bindb_viewddl');
    await run(admin, 'CREATE DATABASE bindb_viewddl');
    await run(admin, 'CREATE TABLE bindb_viewddl.t (id INT PRIMARY KEY)');
    await run(admin, 'CREATE VIEW bindb_viewddl.v AS SELECT 1 AS id');
    cfg = await api.store.add({ name: 'viewddl-my', driver: 'mysql', host, port: Number(port), user: 'root', database: 'bindb_viewddl', transactionControl: 'manual' });
  });

  after(async () => {
    if (!admin) return;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (cfg) {
      await api.sessions.disconnect(cfg.id);
      await api.store.remove(cfg.id);
    }
    await run(admin, 'DROP DATABASE IF EXISTS bindb_viewddl').catch(() => {});
    await api.sessions.disconnect(admin.id);
    await api.store.remove(admin.id);
  });

  it('Submit says the open transaction was committed too, and it was', async () => {
    const table = (await api.sessions.metadata(cfg, true)).find((t) => t.name === 'v');
    await vscode.commands.executeCommand('bindb.ddl.goToDdl', { kind: 'table', cfg: api.store.get(cfg.id), table });
    const editor = await until(() => {
      const e = vscode.window.activeTextEditor;
      return e?.document.uri.path.endsWith('/v.sql') && e;
    });
    // 열린 트랜잭션 안의 변경(아직 커밋 안 함)
    await run(cfg, 'INSERT INTO t VALUES (7)');
    // COUNT(*)는 BIGINT라 글자로 온다
    const count = async () => Number((await rows(admin, 'SELECT COUNT(*) FROM bindb_viewddl.t'))[0][0]);
    assert.equal(await count(), 0);

    const text = editor.document.getText().replace(/select\s+1\s+AS\s+`?id`?/i, 'SELECT 2 AS id');
    assert.notEqual(text, editor.document.getText());
    await editor.edit((b) => b.replace(new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)), text));
    const info = answerDialogs('showInformationMessage', () => undefined);
    try {
      await within(vscode.commands.executeCommand('bindb.ddl.submit', editor.document.uri), 15000, 'Submit');
      assert.deepEqual(info.shown, ['Submitted bindb_viewddl.v to viewddl-my. MySQL commits DDL at once, so the open transaction was committed too.']);
    } finally {
      info.restore();
    }
    // 되돌려도 INSERT는 남는다(DDL이 이미 커밋했다)
    await run(cfg, 'ROLLBACK');
    assert.equal(await count(), 1);
    assert.equal(Number((await rows(admin, 'SELECT id FROM bindb_viewddl.v'))[0][0]), 2);
  });
});

// H2 · Manual 트랜잭션: MySQL처럼 DDL이 열린 트랜잭션을 커밋한다.
// Java와 H2 jar가 있을 때만: JAVA_HOME=…, BINDB_TEST_H2_JAR=/…/h2-2.x.jar
describe('view DDL editor (H2, manual transaction control)', function () {
  let api;
  let cfg;
  const jar = process.env.BINDB_TEST_H2_JAR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindb-viewddl-h2-'));
  const run = async (sql) => (await api.sessions.execute(cfg, sql)).close();
  const rows = async (sql) => {
    const cur = await api.sessions.execute(cfg, sql);
    const r = (await cur.fetch(1000)).rows;
    await cur.close();
    return r;
  };

  before(async function () {
    if (!jar) this.skip();
    api = await vscode.extensions.getExtension('AzuraLight.bindb').activate();
    cfg = await api.store.add({ name: 'viewddl-h2', driver: 'h2', file: path.join(dir, 'v'), createDatabase: true, driverFile: jar, transactionControl: 'manual' });
    for (const sql of ['CREATE TABLE T (ID INT PRIMARY KEY)', 'CREATE VIEW V AS SELECT 1 AS ID', 'COMMIT']) await run(sql);
  });

  after(async () => {
    if (!cfg) return;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.sessions.disconnect(cfg.id);
    await api.store.remove(cfg.id);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('Submit says the open transaction was committed too, and it was', async () => {
    const table = (await api.sessions.metadata(cfg, true)).find((t) => t.name === 'V');
    assert.ok(table, 'view V in metadata');
    await vscode.commands.executeCommand('bindb.ddl.goToDdl', { kind: 'table', cfg: api.store.get(cfg.id), table });
    const editor = await until(() => {
      const e = vscode.window.activeTextEditor;
      return e?.document.uri.path.endsWith('/V.sql') && e;
    });
    await run('INSERT INTO T VALUES (7)');

    const text = editor.document.getText().replace(/SELECT\s+1\s+AS/i, 'SELECT 2 AS');
    assert.notEqual(text, editor.document.getText(), editor.document.getText());
    await editor.edit((b) => b.replace(new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)), text));
    const info = answerDialogs('showInformationMessage', () => undefined);
    try {
      await within(vscode.commands.executeCommand('bindb.ddl.submit', editor.document.uri), 30000, 'Submit');
      assert.deepEqual(info.shown, ['Submitted PUBLIC.V to viewddl-h2. H2 commits DDL at once, so the open transaction was committed too.']);
    } finally {
      info.restore();
    }
    // 되돌려도 INSERT는 남는다(DDL이 이미 커밋했다)
    await run('ROLLBACK');
    assert.equal(Number((await rows('SELECT COUNT(*) FROM T'))[0][0]), 1);
    assert.equal(Number((await rows('SELECT ID FROM V'))[0][0]), 2);
  });
});
