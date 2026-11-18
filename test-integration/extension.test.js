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

  it('SQL editor: go to declaration, find usages, hover, unresolved warnings and reveal in explorer', async () => {
    const content = '-- @conn: shop\nSELECT o.total FROM orders o;\nSELECT * FROM orders;\nSELECT * FROM nope';
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
    const editor = await vscode.window.showTextDocument(doc);
    const pos = (needle, from = 0) => doc.positionAt(content.indexOf(needle, from));

    const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, pos('o.total'));
    assert.deepEqual(defs.map((d) => doc.offsetAt(d.range.start)), [content.indexOf('orders o') + 'orders '.length]);

    const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', doc.uri, pos('orders'));
    assert.equal(refs.length, 2);

    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, pos('total'));
    assert.match(hovers.map((h) => h.contents.map((c) => c.value ?? c).join('')).join(''), /column.*orders\.total/);

    const warnings = await until(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'BindB').length && vscode.languages.getDiagnostics(doc.uri));
    assert.deepEqual(warnings.map((d) => d.message), ["Unable to resolve table 'nope'"]);

    // 탐색기에서 보여 주기: 테이블 · 열 노드가 실제로 선택되어야 한다
    editor.selection = new vscode.Selection(pos('orders'), pos('orders'));
    assert.equal(await vscode.commands.executeCommand('bindb.revealInExplorer'), true);
    assert.deepEqual(api.explorerView.selection.map((n) => `${n.kind}:${n.table?.name}`), ['table:orders']);
    await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(pos('total'), pos('total'));
    assert.equal(await vscode.commands.executeCommand('bindb.revealInExplorer'), true);
    assert.deepEqual(api.explorerView.selection.map((n) => `${n.kind}:${n.table?.name}.${n.column?.name}`), ['column:orders.total']);
    // DB 객체가 아닌 자리는 false(안내만)
    await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(pos('nope'), pos('nope'));
    assert.equal(await vscode.commands.executeCommand('bindb.revealInExplorer'), false);
  });

  it('Find All References searches bound .sql files but skips node_modules and files.exclude', async () => {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const made = ['refs/a.sql', 'refs/other.sql', 'node_modules/pkg/b.sql', 'build/c.sql'].map((f) => path.join(root, f));
    const settings = path.join(root, '.vscode', 'settings.json');
    const hadSettings = fs.existsSync(settings);
    for (const f of made) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      // other.sql은 다른 연결에 바인딩 — 제외
      fs.writeFileSync(f, `-- @conn: ${f.endsWith('other.sql') ? 'someone else' : 'shop'}\nSELECT * FROM orders;\n`);
    }
    try {
      await vscode.workspace.getConfiguration('files').update('exclude', { '**/build': true, '**/when': { when: '$(basename).x' } }, vscode.ConfigurationTarget.Workspace);
      const content = '-- @conn: shop\nSELECT * FROM orders';
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
      const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', doc.uri, doc.positionAt(content.indexOf('orders')));
      const where = refs.map((r) => (r.uri.toString() === doc.uri.toString() ? 'this' : path.relative(root, r.uri.fsPath))).sort();
      assert.deepEqual(where, [path.join('refs', 'a.sql'), 'this']);
    } finally {
      await vscode.workspace.getConfiguration('files').update('exclude', undefined, vscode.ConfigurationTarget.Workspace);
      if (!hadSettings) fs.rmSync(settings, { force: true });
      for (const d of ['refs', 'node_modules', 'build']) fs.rmSync(path.join(root, d), { recursive: true, force: true });
    }
  });

  it('completion follows the -- @schema binding like hover and navigation', async () => {
    const folder = path.join(dir, 'schemas');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'a.sql'), 'CREATE TABLE public.items (id integer);\nCREATE TABLE sales.items (region text);\n');
    const cfg = await api.store.add({ name: 'two schemas', driver: 'postgres', kind: 'ddl', ddlFolder: folder });
    await api.sessions.metadata(cfg);
    const columnsAt = async (header) => {
      const content = `${header}SELECT i. FROM items i`;
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, doc.positionAt(content.indexOf('i.') + 2));
      return list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label)).sort();
    };
    assert.deepEqual(await columnsAt('-- @conn: two schemas\n'), ['id']);
    assert.deepEqual(await columnsAt('-- @conn: two schemas\n-- @schema: sales\n'), ['region']);
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
