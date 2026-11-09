// 저장소(작업 공간) 설정이 사용자의 비밀 값 · 정책을 건드리지 못하는지 — 설계 점검 5 · 7번
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

describe('workspace settings cannot reach user secrets', function () {
  let api;
  const cfg = () => vscode.workspace.getConfiguration('bindb');

  before(async () => {
    api = await vscode.extensions.getExtension('AzuraLight.bindb').activate();
  });

  after(async () => {
    await cfg().update('connections', undefined, vscode.ConfigurationTarget.Workspace);
    for (const c of api.store.list()) await api.store.remove(c.id);
    await cfg().update('connections', undefined, vscode.ConfigurationTarget.Global);
    // 작업 공간 설정을 쓰면 비어도 settings.json이 남는다 — 테스트 폴더를 깨끗이 둔다
    const file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.vscode', 'settings.json');
    if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').replace(/[\s{}]/g, '')) fs.rmSync(file);
  });

  it('a project connection reusing a global id is ignored, so the global password never goes to its host', async () => {
    const g = await api.store.add({ name: 'prod', driver: 'postgres', host: 'db.internal' }, { password: 'g-secret' });
    await cfg().update('connections', [{ id: g.id, name: 'look-alike', driver: 'postgres', host: 'attacker.example' }], vscode.ConfigurationTarget.Workspace);
    assert.deepEqual(
      api.store.list().map((c) => `${c.name}@${c.host}`),
      ['prod@db.internal'],
    );
    assert.equal(api.store.get(g.id).host, 'db.internal');
    assert.equal(await api.store.password(g.id), 'g-secret');
    await cfg().update('connections', undefined, vscode.ConfigurationTarget.Workspace);
    await api.store.remove(g.id);
  });

  it('project secrets are stored per workspace: the same id as a global connection elsewhere does not see them', async () => {
    const p = await api.store.add({ name: 'local', driver: 'postgres', host: 'localhost', scope: 'project' }, { password: 'p-secret' });
    assert.equal(await api.store.password(p.id), 'p-secret');
    // 같은 id를 전역에 두면(다른 저장소의 연결을 흉내 낸 경우와 같은 키 이름) 그 비밀번호는 보이지 않는다
    await cfg().update('connections', undefined, vscode.ConfigurationTarget.Workspace);
    await cfg().update('connections', [{ id: p.id, name: 'other', driver: 'postgres', host: 'attacker.example' }], vscode.ConfigurationTarget.Global);
    assert.equal(await api.store.password(p.id), undefined);
    await cfg().update('connections', undefined, vscode.ConfigurationTarget.Global);
  });

  it('moving a connection between Global and Project keeps its password', async () => {
    const c = await api.store.add({ name: 'mover', driver: 'postgres', host: 'h' }, { password: 'm-secret' });
    const { id, ...rest } = api.store.get(c.id);
    await api.store.update(id, { ...rest, scope: 'project' });
    assert.equal(api.store.get(id).scope, 'project');
    assert.equal(await api.store.password(id), 'm-secret');
    await api.store.update(id, { ...api.store.get(id), id: undefined, scope: undefined });
    assert.equal(await api.store.password(id), 'm-secret');
    await api.store.remove(id);
  });

  it('AI write access and the H2 jar path cannot be set from workspace settings', async () => {
    for (const [section, key] of [
      ['bindb.ai', 'allowWrites'],
      ['bindb.ai', 'mcpServer.enabled'],
      ['bindb', 'h2.jarPath'],
      ['bindb', 'ssh.configurations'],
    ]) {
      await assert.rejects(
        Promise.resolve(vscode.workspace.getConfiguration(section).update(key, key === 'ssh.configurations' ? [] : true, vscode.ConfigurationTarget.Workspace)),
        undefined,
        `${section}.${key}`,
      );
    }
  });
});
