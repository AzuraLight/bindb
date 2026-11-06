// 이번에 넣은 Options 항목을 실제 VS Code 안에서 확인한다
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

describe('BindB options in VS Code', function () {
  let api;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindb-opt-'));
  const marker = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'prepared.txt');

  before(async () => {
    api = await vscode.extensions.getExtension('AzuraLight.bindb').activate();
    // Before connection 작업은 test-integration/workspace/.vscode/tasks.json 에 있다
  });

  after(async () => {
    fs.rmSync(marker, { force: true });
    for (const c of api.store.list()) {
      await api.sessions.disconnect(c.id);
      await api.store.remove(c.id);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('Before connection runs VS Code tasks first and stops on a failing task', async () => {
    const ok = await api.store.add({ name: 'prep', driver: 'sqlite', file: path.join(dir, 'p.db'), beforeConnection: ['prepare-db'] });
    await (await api.sessions.execute(ok, 'SELECT 1')).close();
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'ready');
    const bad = await api.store.add({ name: 'bad', driver: 'sqlite', file: path.join(dir, 'b.db'), beforeConnection: ['broken'] });
    await assert.rejects(api.sessions.execute(bad, 'SELECT 1'), /exited with code 3/);
    const missing = await api.store.add({ name: 'missing', driver: 'sqlite', file: path.join(dir, 'm.db'), beforeConnection: ['nope'] });
    await assert.rejects(api.sessions.execute(missing, 'SELECT 1'), /no task named "nope"/);
  });

  it('Use session template applies the template (read-only + startup script)', async () => {
    const cfg = await api.store.add({
      name: 'tpl',
      driver: 'sqlite',
      file: path.join(dir, 't.db'),
      startupScript: 'CREATE TABLE IF NOT EXISTS log(x)',
      sessionTemplates: [{ name: 'safe', readOnly: true }],
      useSessionTemplate: 'safe',
    });
    // 템플릿의 Read-only가 먹으면 쓰기가 막힌다(시작 스크립트는 템플릿 적용 전 값과 합쳐서 돈다 — 여기선 CREATE가 막혀 실패)
    await assert.rejects(api.sessions.execute(cfg, 'SELECT 1'), /read-only/i);
    const writable = await api.store.update(cfg.id, { ...cfg, id: undefined, useSessionTemplate: undefined });
    await api.sessions.disconnect(cfg.id);
    await (await api.sessions.execute(writable, 'INSERT INTO log VALUES (1)')).close();
  });

  it('SQLite: a long query can be cancelled and the extension host keeps running', async () => {
    const cfg = await api.store.add({ name: 'long', driver: 'sqlite', file: path.join(dir, 'long.db') });
    const running = api.sessions.execute(cfg, 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000000000) SELECT count(*) FROM c');
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(Date.now() - t0 < 1500, 'the extension host was not blocked');
    await api.sessions.cancel(cfg);
    await assert.rejects(running, /cancelled/i);
    // 다음 실행은 새 프로세스로 다시 연다
    const cur = await api.sessions.execute(cfg, 'SELECT 42');
    assert.deepEqual((await cur.fetch(10)).rows, [[42]]);
    await cur.close();
  });
});
