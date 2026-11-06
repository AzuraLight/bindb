// 결과 그리드: 그리드가 보내는 메시지를 넣고, 그리드로 가는 메시지와 DB를 확인한다
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

describe('result grid', function () {
  let api;
  let cfg;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindb-grid-'));

  /** 마지막으로 그리드에 간 t 종류 메시지(qid 이후) */
  const last = (t, after = 0) => api.results.trace.slice(after).filter((m) => m.t === t).pop();
  const mark = () => api.results.trace.length;
  const rows = async (sql) => {
    const c = await api.sessions.execute(cfg, sql);
    const r = (await c.fetch(1000)).rows;
    await c.close();
    return r;
  };
  const table = async (name) => (await api.sessions.metadata(cfg, true)).find((t) => t.name === name);

  before(async () => {
    api = await vscode.extensions.getExtension('AzuraLight.bindb').activate();
    cfg = await api.store.add({ name: 'gridtest', driver: 'sqlite', file: path.join(dir, 'g.db') });
    for (const sql of [
      'CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, note TEXT)',
      "INSERT INTO people VALUES (1, 'Ann', 'a'), (2, 'Bo', NULL), (3, 'Cy', 'c')",
      'CREATE TABLE nokey (x TEXT)',
      "INSERT INTO nokey VALUES ('one'), ('two')",
      'CREATE VIEW v AS SELECT id FROM people',
    ]) {
      await (await api.sessions.execute(cfg, sql)).close();
    }
  });

  after(async () => {
    await api.sessions.disconnect(cfg.id);
    await api.store.remove(cfg.id);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('opens table data as editable, with the primary key', async () => {
    const m = mark();
    await api.results.openTable(cfg, await table('people'));
    const start = await until(() => last('result/start', m));
    assert.equal(start.edit.editable, true);
    assert.deepEqual(start.edit.key, ['id']);
    assert.equal(start.filterable, true);
    const r = await until(() => last('result/rows', m));
    assert.equal(r.rows.length, 3);
  });

  it('Preview shows the SQL; Submit saves, re-reads, and a stale row rolls everything back', async () => {
    let m = mark();
    const qid = api.results.currentQid;
    const changes = {
      updates: [{ row: 0, original: [1, 'Ann', 'a'], cells: [[1, "Ann's"]] }],
      deletes: [{ row: 2, original: [3, 'Cy', 'c'] }],
      inserts: [[[1, 'Dee']]],
    };
    api.results.receive({ t: 'edit/preview', qid, changes });
    const p = await until(() => last('edit/preview', m));
    assert.deepEqual(p.statements, [`DELETE FROM "people" WHERE "id" = 3`, `UPDATE "people" SET "name" = 'Ann''s' WHERE "id" = 1`, `INSERT INTO "people" ("name") VALUES ('Dee')`]);

    m = mark();
    api.results.receive({ t: 'edit/submit', qid, changes });
    const res = await until(() => last('edit/result', m));
    assert.equal(res.ok, true, res.message);
    await until(() => last('result/start', m)); // 저장 뒤 다시 읽는다
    assert.deepEqual(await rows('SELECT id, name FROM people ORDER BY id'), [[1, "Ann's"], [2, 'Bo'], [3, 'Dee']]);

    // 다른 곳에서 지워진 행을 고치려 하면 아무것도 저장하지 않는다
    m = mark();
    const stale = {
      updates: [
        { row: 0, original: [1, "Ann's", 'a'], cells: [[2, 'keep?']] },
        { row: 1, original: [99, 'Ghost', null], cells: [[1, 'x']] },
      ],
      deletes: [],
      inserts: [],
    };
    api.results.receive({ t: 'edit/submit', qid: api.results.currentQid, changes: stale });
    const bad = await until(() => last('edit/result', m));
    assert.equal(bad.ok, false);
    assert.match(bad.message, /Nothing was saved.*affected 0 rows/);
    assert.deepEqual(await rows('SELECT note FROM people WHERE id = 1'), [['a']]);
  });

  it('WHERE / ORDER BY re-runs; a bad filter keeps the bar usable', async () => {
    let m = mark();
    api.results.receive({ t: 'filter', qid: api.results.currentQid, where: "name <> 'Bo'", orderBy: '1 DESC' });
    await until(() => last('result/start', m));
    const r = await until(() => last('result/rows', m));
    assert.deepEqual(r.rows.map((x) => x[0]), [3, 1]);

    m = mark();
    api.results.receive({ t: 'filter', qid: api.results.currentQid, where: '1 = 1; DROP TABLE people', orderBy: '' });
    const err = await until(() => last('result/error', m));
    assert.match(err.message, /";" is not allowed/);
    // 같은 qid로 고친 필터가 받아들여진다
    m = mark();
    api.results.receive({ t: 'filter', qid: api.results.currentQid, where: 'id = 2', orderBy: '' });
    const ok = await until(() => last('result/rows', m));
    assert.deepEqual(ok.rows.map((x) => x[1]), ['Bo']);
  });

  it('exports every row to a file', async () => {
    const file = path.join(dir, 'out.csv');
    api.results.pickExportFile = async () => vscode.Uri.file(file);
    let m = mark();
    api.results.receive({ t: 'filter', qid: api.results.currentQid, where: '', orderBy: '1' });
    await until(() => last('result/rows', m));
    m = mark();
    api.results.receive({ t: 'export', qid: api.results.currentQid, format: 'csv' });
    const n = await until(() => last('notice', m));
    assert.match(n.message, /Exported 3 rows/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'id,name,note\r\n1,Ann\'s,a\r\n2,Bo,\r\n3,Dee,\r\n');
  });

  it('read-only cases explain why: views, query results, tables without a key (SQLite uses rowid)', async () => {
    let m = mark();
    await api.results.openTable(cfg, await table('v'));
    assert.match((await until(() => last('result/start', m))).edit.reason, /Views are read-only/);

    m = mark();
    await api.results.run(cfg, 'SELECT * FROM people');
    const q = await until(() => last('result/start', m));
    assert.equal(q.edit.editable, false);
    assert.equal(q.filterable, true);

    m = mark();
    await api.results.run(cfg, 'PRAGMA table_info(people)');
    assert.match((await until(() => last('result/start', m))).filterable, /SELECT queries only/);

    m = mark();
    await api.results.openTable(cfg, await table('nokey'));
    const nk = await until(() => last('result/start', m));
    assert.deepEqual(nk.edit.key, ['rowid'], 'SQLite tables without a primary key are edited by rowid');
    assert.equal(nk.edit.columns[0], false, 'rowid itself is not editable');
  });

  it('records what the user ran in Query History (not filter re-runs)', async () => {
    const list = await api.history.list(cfg.id);
    assert.deepEqual(list.map((e) => e.sql).slice(0, 2), ['PRAGMA table_info(people)', 'SELECT * FROM people']);
    assert.ok(list.every((e) => !/bindb_q|WHERE/.test(e.sql)));
  });
});
