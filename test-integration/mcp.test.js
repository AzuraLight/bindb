// MCP 서버를 켜고 공식 MCP SDK 클라이언트로 붙어 본다(Claude Code · Codex · Copilot이 하는 것과 같은 요청)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

describe('BindB MCP server', function () {
  let api;
  let client;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindb-mcp-'));

  const connect = async (token) => {
    const c = new Client({ name: 'bindb-test', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(api.ai.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return c;
  };
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: !!r.isError, text: r.content[0].text };
  };

  before(async () => {
    api = await vscode.extensions.getExtension('AzuraLight.bindb').activate();
    const cfg = await api.store.add({ name: 'mcpdb', driver: 'sqlite', file: path.join(dir, 'm.db') });
    for (const sql of ['CREATE TABLE people (id integer, name text)', "INSERT INTO people VALUES (1, 'Ann'), (2, 'Bo')"]) {
      await (await api.sessions.execute(cfg, sql)).close();
    }
    await vscode.workspace.getConfiguration('bindb.ai').update('mcpServer.port', 47999, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('bindb.ai').update('mcpServer.enabled', true, vscode.ConfigurationTarget.Global);
    for (let i = 0; i < 50 && !api.ai.server.running; i++) await new Promise((r) => setTimeout(r, 100));
    client = await connect(await api.ai.token());
  });

  after(async () => {
    await client?.close();
    await vscode.workspace.getConfiguration('bindb.ai').update('mcpServer.enabled', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('bindb.ai').update('mcpServer.port', undefined, vscode.ConfigurationTarget.Global);
    for (const c of api.store.list()) {
      await api.sessions.disconnect(c.id);
      await api.store.remove(c.id);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('rejects requests without the token', async () => {
    const res = await fetch(api.ai.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
    await assert.rejects(connect('wrong-token'));
  });

  // MCP 명세: Streamable HTTP 서버는 Origin을 확인해야 한다(DNS 리바인딩)
  it('rejects requests from web pages (Origin) even with the token', async () => {
    const auth = { Authorization: `Bearer ${await api.ai.token()}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const evil = await fetch(api.ai.url, { method: 'POST', headers: { ...auth, Origin: 'https://evil.example' }, body });
    assert.equal(evil.status, 403);
    const local = await fetch(api.ai.url, { method: 'POST', headers: { ...auth, Origin: new URL(api.ai.url).origin }, body });
    assert.notEqual(local.status, 403);
  });

  it('lists the tools with read-only hints', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(byName).sort(), ['execute_statement', 'explain_query', 'get_schema', 'list_connections', 'run_query']);
    assert.equal(byName.run_query.annotations.readOnlyHint, true);
    assert.equal(byName.execute_statement.annotations.destructiveHint, true);
  });

  it('list_connections shows names, never secrets', async () => {
    const r = await call('list_connections', {});
    const list = JSON.parse(r.text);
    assert.ok(list.some((c) => c.name === 'mcpdb'));
    assert.ok(!/password|secret|token/i.test(r.text));
  });

  it('get_schema returns tables and columns', async () => {
    const r = await call('get_schema', { connection: 'mcpdb' });
    assert.match(r.text, /\*\*people\*\*\(id integer, name text\)/i);
  });

  it('run_query returns rows with a limit, and refuses writes', async () => {
    const r = JSON.parse((await call('run_query', { connection: 'mcpdb', sql: 'SELECT id, name FROM people ORDER BY id', limit: 1 })).text);
    assert.deepEqual(r, { columns: ['id', 'name'], rows: [[1, 'Ann']], rowCount: 1, truncated: true });
    const w = await call('run_query', { connection: 'mcpdb', sql: 'DELETE FROM people' });
    assert.ok(w.error);
    const still = JSON.parse((await call('run_query', { connection: 'mcpdb', sql: 'SELECT count(*) AS n FROM people' })).text);
    assert.deepEqual(still.rows, [[2]], 'the DELETE was rolled back');
  });

  it('execute_statement is off unless the user allows writes', async () => {
    const r = await call('execute_statement', { connection: 'mcpdb', sql: 'DELETE FROM people' });
    assert.ok(r.error);
    assert.match(r.text, /bindb\.ai\.allowWrites/);
  });

  it('unknown connection names fail with the list of names', async () => {
    const r = await call('get_schema', { connection: 'nope' });
    assert.ok(r.error);
    assert.match(r.text, /mcpdb/);
  });
});
