// 실제 VS Code 안에서 BindB를 띄워 확인한다. 임시 폴더의 SQLite 파일만 쓴다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await cond();
    if (v) return v;
    await sleep(100);
  }
  throw new Error('timed out');
}

describe('BindB in VS Code', function () {
  let api;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindb-it-'));
  const dbFile = path.join(dir, 'shop.db');
  const ddlDir = path.join(dir, 'ddl');

  before(async () => {
    const ext = vscode.extensions.getExtension('AzuraLight.bindb');
    api = await ext.activate();
    // 모달 확인은 테스트가 누를 수 없다
    api.ddl.confirm = async () => true;
    // Migration 창: 기본으로 골라 둔 변경(지우지 않는 것)을 그대로 고른다
    api.ddl.pickChanges = async (items) => items.filter((i) => i.picked).map((i) => i.label);
  });

  after(async () => {
    for (const c of api.store.list()) {
      await api.sessions.disconnect(c.id);
      await api.store.remove(c.id);
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('registers every command in package.json', async () => {
    const pkg = require('../package.json');
    const all = await vscode.commands.getCommands(true);
    const missing = pkg.contributes.commands.map((c) => c.command).filter((c) => !all.includes(c));
    assert.deepEqual(missing, []);
  });

  it('opens the Data Sources panel', async () => {
    await vscode.commands.executeCommand('bindb.manageConnections');
    const tab = await until(() =>
      vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label === 'Data Sources'),
    );
    assert.ok(tab);
    // 웹뷰 스크립트가 떠서 ready를 보내고, 호스트가 init으로 답해야 화면이 그려진다
    await until(() => api.panelTrace().includes('out:init'), 15000).catch(() => {
      throw new Error(`panel never initialised: ${JSON.stringify(api.panelTrace())}`);
    });
    assert.ok(!api.panelTrace().some((t) => t.startsWith('error:')), JSON.stringify(api.panelTrace()));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('runs a statement from a console bound with -- @conn and syncs the explorer (Auto sync)', async () => {
    const cfg = await api.store.add({ name: 'shop', driver: 'sqlite', file: dbFile });
    const doc = await vscode.workspace.openTextDocument({
      language: 'sql',
      content: '-- @conn: shop\nCREATE TABLE orders (id integer, total numeric)',
    });
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('bindb.runStatement', doc.uri, doc.getText().indexOf('CREATE'));
    const tables = await until(async () => {
      const meta = await api.sessions.metadata(cfg);
      return meta.find((t) => t.name === 'orders');
    });
    assert.deepEqual(tables.columns.map((c) => c.name), ['id', 'total']);
    assert.ok(fs.statSync(dbFile).size > 0, 'written to the SQLite file');
  });

  it('DDL mapping: Dump to writes files, Apply to opens a migration script', async () => {
    const ddl = await api.store.add({ name: 'shop (DDL)', driver: 'sqlite', kind: 'ddl', ddlFolder: ddlDir });
    const src = api.store.findByName('shop');
    const mapped = await api.store.update(src.id, { ...src, id: undefined, ddlMapping: { ddl: ddl.id } });
    await api.ddl.dump(mapped);
    const file = path.join(ddlDir, 'orders.sql');
    assert.match(fs.readFileSync(file, 'utf8'), /CREATE TABLE "orders"/);

    // DDL 쪽에 컬럼을 더하면 Apply가 ADD COLUMN 스크립트를 연다
    fs.writeFileSync(file, 'CREATE TABLE "orders" ("id" integer, "total" numeric, "note" text);\n');
    await api.ddl.apply(api.store.get(ddl.id));
    const script = await until(() => vscode.window.activeTextEditor?.document.getText().includes('ADD COLUMN') && vscode.window.activeTextEditor.document);
    assert.match(script.getText(), /^-- @conn: shop/m);
    assert.match(script.getText(), /ALTER TABLE "orders" ADD COLUMN "note" text;/);
  });

  it('Read-only connections refuse writes', async () => {
    const src = api.store.findByName('shop');
    const ro = await api.store.update(src.id, { ...src, id: undefined, readOnly: true });
    await api.sessions.disconnect(ro.id);
    await assert.rejects(api.sessions.execute(ro, 'DELETE FROM orders'), /read-only/i);
  });
});
