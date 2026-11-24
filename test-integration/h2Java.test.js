// H2에 접속할 때 Java가 없으면 OpenJDK를 내려받는 곳을 안내한다(실제 VS Code에서 경고 · 버튼을 확인)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

describe('H2 without Java', function () {
  let api;
  let cfg;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindb-h2java-'));
  const saved = { PATH: process.env.PATH, JAVA_HOME: process.env.JAVA_HOME };
  const restore = [];

  before(async () => {
    api = await vscode.extensions.getExtension('AzuraLight.bindb').activate();
    // 이 테스트 동안 java를 찾지 못하게 한다(빈 폴더만 PATH에)
    process.env.PATH = dir;
    process.env.JAVA_HOME = path.join(dir, 'no-java');
    const jar = path.join(dir, 'h2-2.3.232.jar');
    fs.writeFileSync(jar, '');
    cfg = await api.store.add({ name: 'h2-nojava', driver: 'h2', file: path.join(dir, 'x'), createDatabase: true, driverFile: jar });
  });

  after(async () => {
    for (const r of restore) r();
    process.env.PATH = saved.PATH;
    if (saved.JAVA_HOME === undefined) delete process.env.JAVA_HOME;
    else process.env.JAVA_HOME = saved.JAVA_HOME;
    if (cfg) await api.store.remove(cfg.id);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('refuses to connect and offers Download OpenJDK, which opens the download page', async () => {
    const shown = [];
    const opened = [];
    const warn = vscode.window.showWarningMessage;
    const open = vscode.env.openExternal;
    vscode.window.showWarningMessage = async (message, ...items) => (shown.push({ message, items }), 'Download OpenJDK');
    vscode.env.openExternal = async (uri) => (opened.push(uri.toString()), true);
    restore.push(() => (vscode.window.showWarningMessage = warn), () => (vscode.env.openExternal = open));

    await assert.rejects(api.sessions.execute(cfg, 'SELECT 1'), /Java was not found\. H2 needs Java 11 or later/);
    assert.equal(shown.length, 1);
    assert.match(shown[0].message, /install OpenJDK/);
    assert.deepEqual(shown[0].items, ['Download OpenJDK']);
    for (let i = 0; i < 50 && !opened.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(opened, ['https://adoptium.net/temurin/releases/']);
  });

  it('shows one notice while it is open, however many connections fail, and asks no password before it', async () => {
    const { id, ...rest } = api.store.get(cfg.id);
    await api.store.update(id, { ...rest, passwordSave: 'never' });
    let close;
    const shown = [];
    const asked = [];
    const warn = vscode.window.showWarningMessage;
    const input = vscode.window.showInputBox;
    // 안내를 닫지 않은 채로 둔다
    vscode.window.showWarningMessage = (message) => (shown.push(message), new Promise((r) => (close = r)));
    vscode.window.showInputBox = async (o) => (asked.push(o?.prompt), 'pw');
    try {
      const tries = [];
      for (let i = 0; i < 3; i++) tries.push(assert.rejects(api.sessions.execute(cfg, 'SELECT 1'), /Java was not found/));
      await Promise.all(tries);
      await assert.rejects(api.sessions.metadata(cfg, true), /Java was not found/);
      assert.equal(shown.length, 1);
      assert.deepEqual(asked, []);
      // 닫은 뒤 다시 실패하면 다시 알린다
      close(undefined);
      await new Promise((r) => setTimeout(r, 50));
      await assert.rejects(api.sessions.execute(cfg, 'SELECT 1'), /Java was not found/);
      assert.equal(shown.length, 2);
      close(undefined);
    } finally {
      vscode.window.showWarningMessage = warn;
      vscode.window.showInputBox = input;
    }
  });
});
