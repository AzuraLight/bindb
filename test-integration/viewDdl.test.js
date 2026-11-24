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
});
