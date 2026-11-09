import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { buildConfig, emptyForm, formFromConfig, objectVisible, parseObjectFilter, schemaVisible, type ConnectionForm } from '../src/core/connectionDraft';
import { queryAll } from '../src/drivers/cursor';
import { resolveTarget, tlsOptions } from '../src/drivers/common';
import { splitArgs, parseEnv } from '../src/drivers/h2';
import { sqliteDriver } from '../src/drivers/sqlite';
import type { ConnectionConfig } from '../src/drivers/types';

const form = (patch: Partial<ConnectionForm>, adv: Partial<ConnectionForm['adv']> = {}): ConnectionForm => {
  const base = emptyForm(patch.driver);
  return { ...base, name: 'x', ...patch, adv: { ...base.adv, ...adv } };
};

describe('DataGrip options → config', () => {
  it('stores only non-default options and round-trips them', () => {
    const f = form(
      {},
      {
        auth: 'pgpass',
        transactionControl: 'manual',
        switchSchema: 'automatic',
        timeZone: 'Asia/Seoul',
        keepAliveOn: true,
        keepAlive: '30',
        autoDisconnectOn: true,
        autoDisconnect: '600',
        sessionControl: 'dedicated',
        startupScript: 'SET a = 1;',
        autoSync: false,
        loadSources: 'all',
        introspectOn: true,
        introspectInterval: '5',
        schemaPattern: 'app:public,sales',
        objectFilter: 'table:-tmp_.*',
        driverOptions: [{ key: 'application_name', value: 'bindb' }],
        scope: 'project',
      },
    );
    const r = buildConfig(f, []);
    assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
    const c = r.ok ? r.config : ({} as never);
    assert.equal(c.auth, 'pgpass');
    assert.equal(c.user, 'postgres');
    assert.equal(c.keepAlive, 30);
    assert.equal(c.autoDisconnect, 600);
    assert.equal(c.introspectInterval, 5);
    assert.equal(c.autoSync, false);
    assert.deepEqual(c.driverOptions, { application_name: 'bindb' });
    assert.equal(c.scope, 'project');
    const again = buildConfig(formFromConfig({ id: '1', ...c }), []);
    assert.deepEqual(again.ok && again.config, c);

    const plain = buildConfig(form({}), []);
    assert.deepEqual(plain, { ok: true, config: { name: 'x', driver: 'postgres', host: 'localhost', user: 'postgres' } });
  });

  it('validates option values', () => {
    const r = buildConfig(form({}, { keepAliveOn: true, keepAlive: '0', sshEnabled: true, objectFilter: 'table:(', vmEnvironment: 'not valid' }), []);
    assert.ok(!r.ok);
    const e = !r.ok ? r.errors : {};
    assert.ok(e.keepAlive && e.sshHost && e.sshUser && e.objectFilter && e.vmEnvironment, JSON.stringify(e));
  });

  it('No auth drops the user; Save other than Forever is kept', () => {
    const none = buildConfig(form({ user: 'u' }, { auth: 'none' }), []);
    assert.equal(none.ok && none.config.user, undefined);
    const never = buildConfig(form({}, { passwordSave: 'never' }), []);
    assert.equal(never.ok && never.config.passwordSave, 'never');
  });

  it('URL only parses the URL, and requires one', () => {
    assert.ok(!buildConfig(form({}, { connectionType: 'url' }), []).ok);
    const r = buildConfig(form({}, { connectionType: 'url', url: 'jdbc:postgresql://u:p%40ss@h:6000/d?sslmode=require' }), []);
    assert.ok(r.ok);
    // 비밀번호는 설정(저장소에 커밋될 수 있다)에 남기지 않고 따로 돌려준다
    assert.equal(r.ok && r.config.url, 'jdbc:postgresql://u@h:6000/d?sslmode=require');
    assert.equal(r.ok && r.urlPassword, 'p@ss');
    const cfg = { id: '1', ...(r.ok ? r.config : ({} as never)) } as ConnectionConfig;
    const t = resolveTarget(cfg, { password: 'p' });
    assert.deepEqual([t.cfg.host, t.cfg.port, t.cfg.database, t.cfg.user, t.cfg.ssl, t.password], ['h', 6000, 'd', 'u', 'require', 'p']);
  });
});

describe('Schemas tab filters', () => {
  it('schema pattern', () => {
    const ctx = { database: 'app', currentSchema: 'public' };
    assert.ok(schemaVisible('', ctx, 'x'));
    assert.ok(schemaVisible('app:public,sales', ctx, 'sales'));
    assert.ok(!schemaVisible('app:public,sales', ctx, 'audit'));
    assert.ok(schemaVisible('@:@', ctx, 'public'));
    assert.ok(!schemaVisible('@:@', ctx, 'sales'));
    assert.ok(schemaVisible('*:*', ctx, 'anything'));
    assert.ok(!schemaVisible('other:*', ctx, 'public'));
    assert.ok(schemaVisible('main', {}, 'main'), 'SQLite has no database part');
  });

  it('object filter', () => {
    const rules = parseObjectFilter('table:-tmp_.* view:report_.*');
    assert.ok(objectVisible(rules, 'table', 'orders'));
    assert.ok(!objectVisible(rules, 'table', 'tmp_x'));
    assert.ok(objectVisible(rules, 'view', 'report_daily'));
    assert.ok(!objectVisible(rules, 'view', 'other'));
  });
});

describe('Advanced tab', () => {
  it('VM options and environment for the H2 java process', () => {
    assert.deepEqual(splitArgs('-Xmx512m -Duser.timezone="Asia/Seoul" "-Dx=a b"'), ['-Xmx512m', '-Duser.timezone=Asia/Seoul', '-Dx=a b']);
    assert.deepEqual(parseEnv('A=1\n B = two \nbad'), { A: '1', B: 'two' });
  });

  it('SSL files are read relative to the working directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bindb-ssl-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    require('node:fs').writeFileSync(path.join(dir, 'ca.pem'), 'CA');
    const base = { id: '1', name: 'x', driver: 'postgres' as const, ssl: 'verify' as const, sslCaFile: 'ca.pem', workingDirectory: dir };
    // 기본(Use truststore 둘 다): CA 파일 + Node 내장 목록 + OS 저장소
    const tls = tlsOptions(base, {});
    const ca = tls?.ca as (string | Buffer)[];
    assert.equal(String(ca[0]), 'CA');
    assert.ok(ca.length > 100, 'bundled and system CAs are trusted too');
    assert.equal(tls?.rejectUnauthorized, true);
    // 저장소를 모두 끄면 CA 파일만
    const only = tlsOptions({ ...base, sslTruststore: { bundled: false, system: false } }, {});
    assert.deepEqual((only?.ca as Buffer[]).map(String), ['CA']);
    // CA 파일 없이 기본값이면 Node 기본(ca를 넘기지 않는다)
    assert.equal(tlsOptions({ ...base, sslCaFile: undefined }, {})?.ca, undefined);
  });
});

describe('SQLite with Manual transactions', () => {
  it('writes the file only on COMMIT', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bindb-tx-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 't.db');
    const cfg: ConnectionConfig = { id: 'x', name: 'x', driver: 'sqlite', file };
    let s = await sqliteDriver.connect(cfg, {});
    await (await s.execute('CREATE TABLE t(a)')).close();
    await (await s.execute('BEGIN')).close();
    await (await s.execute('INSERT INTO t VALUES (1)')).close();
    const before = await sqliteDriver.connect(cfg, {});
    assert.deepEqual(await queryAll(before, 'SELECT count(*) FROM t'), [[0]], 'not written inside the transaction');
    await before.close();
    await (await s.execute('COMMIT')).close();
    await s.close();
    s = await sqliteDriver.connect(cfg, {});
    assert.deepEqual(await queryAll(s, 'SELECT count(*) FROM t'), [[1]]);
    await s.close();
  });
});

describe('Session templates', () => {
  it('the chosen template overrides user, read-only and adds its startup script', async () => {
    const { withSessionTemplate } = await import('../src/core/connectionDraft');
    const cfg: ConnectionConfig = {
      id: '1', name: 'x', driver: 'postgres', user: 'app', startupScript: 'SET a = 1',
      sessionTemplates: [{ name: 'report', user: 'reader', readOnly: true, startupScript: 'SET b = 2' }],
      useSessionTemplate: 'report',
    };
    const t = withSessionTemplate(cfg);
    assert.deepEqual([t.user, t.readOnly, t.startupScript], ['reader', true, 'SET a = 1;\nSET b = 2']);
    assert.equal(withSessionTemplate({ ...cfg, useSessionTemplate: undefined }).user, 'app');
  });

  it('validates the template name and round-trips Other options', () => {
    const bad = buildConfig(form({}, { useSessionTemplate: 'missing' }), []);
    assert.ok(!bad.ok && bad.errors.useSessionTemplate);
    const r = buildConfig(
      form({}, {
        sessionTemplates: [{ name: 'report', user: 'reader', readOnly: true, startupScript: '' }],
        useSessionTemplate: 'report', beforeConnection: 'start db\n\n', keywordCase: 'lower', quoteIdentifiers: 'needed', color: '#ff8800', introspectionLevel: '1',
      }),
      [],
    );
    assert.ok(r.ok);
    const c = r.ok ? r.config : ({} as never);
    assert.deepEqual(c.beforeConnection, ['start db']);
    assert.deepEqual(c.codeStyle, { keywordCase: 'lower', quoteIdentifiers: 'needed' });
    assert.equal(c.introspectionLevel, 1);
    assert.equal(c.color, '#ff8800');
    assert.deepEqual(buildConfig(formFromConfig({ id: '1', ...c }), []), r);
  });
});

describe('Introspection level', () => {
  it('level 1 loads names only', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bindb-lvl-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const cfg: ConnectionConfig = { id: 'x', name: 'x', driver: 'sqlite', file: path.join(dir, 'l.db') };
    const s = await sqliteDriver.connect(cfg, {});
    await (await s.execute('CREATE TABLE t(a, b)')).close();
    assert.deepEqual((await sqliteDriver.introspect(s, { ...cfg, introspectionLevel: 1 }))[0].columns, []);
    assert.equal((await sqliteDriver.introspect(s, cfg))[0].columns.length, 2);
    await s.close();
  });
});

describe('H2 driver download', () => {
  const fake = (files: Record<string, string | Buffer>): typeof fetch =>
    (async (url: string) => {
      const body = files[String(url)];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body);
    }) as typeof fetch;
  const base = 'https://repo1.maven.org/maven2/com/h2database/h2';

  it('lists versions, newest first', async () => {
    const { h2Versions } = await import('../src/drivers/h2Download');
    const r = await h2Versions(fake({ [`${base}/maven-metadata.xml`]: '<versions><version>1.4.200</version><version>2.2.224</version></versions><release>2.2.224</release>' }));
    assert.deepEqual(r, { latest: '2.2.224', versions: ['2.2.224', '1.4.200'] });
  });

  it('saves the jar only when the SHA-1 matches', async () => {
    const { downloadH2 } = await import('../src/drivers/h2Download');
    const { createHash } = await import('node:crypto');
    const dir = mkdtempSync(path.join(tmpdir(), 'bindb-h2dl-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const jar = Buffer.from('jar bytes');
    const sha = createHash('sha1').update(jar).digest('hex');
    const url = `${base}/2.2.224/h2-2.2.224.jar`;
    const file = await downloadH2('2.2.224', dir, fake({ [url]: jar, [`${url}.sha1`]: sha }));
    assert.equal(require('node:fs').readFileSync(file, 'utf8'), 'jar bytes');
    await assert.rejects(downloadH2('2.2.224', dir, fake({ [url]: jar, [`${url}.sha1`]: '0'.repeat(40) })), /Checksum mismatch/);
    await assert.rejects(downloadH2('../evil', dir, fake({})), /Invalid version/);
  });
});

describe('fixes from the code review', () => {
  it('stripUrlPassword leaves URLs without a password alone', async () => {
    const { stripUrlPassword } = await import('../src/core/connectionDraft');
    assert.deepEqual(stripUrlPassword('mysql://root@h/db'), { url: 'mysql://root@h/db' });
    assert.deepEqual(stripUrlPassword('mysql://h/db'), { url: 'mysql://h/db' });
    assert.deepEqual(stripUrlPassword('postgresql://a:b:c@h'), { url: 'postgresql://a@h', password: 'b:c' });
  });

  it('DDL paths never leave the folder', async () => {
    const { ddlPath } = await import('../src/core/ddl');
    assert.equal(ddlPath('postgres', { schema: '..', name: 'orders', kind: 'table' }), '__/orders.sql');
    assert.equal(ddlPath('postgres', { schema: 'a/../../b', name: '.hidden', kind: 'table' }), 'a_.._.._b/_hidden.sql');
    assert.equal(ddlPath('postgres', { schema: '', name: '', kind: 'table' }), '_/_.sql');
  });

  it('a @revoked key is refused', async () => {
    const { checkKnownHost } = await import('../src/drivers/sshHosts');
    const key = Buffer.from('k');
    assert.equal(checkKnownHost(`@revoked * ssh-ed25519 ${key.toString('base64')}\n`, 'h', 22, key), 'revoked');
  });

  it('H2 and SQLite URL-only file forms', async () => {
    const os = await import('node:os');
    const t = resolveTarget({ id: '1', name: 'x', driver: 'h2', connectionType: 'url', url: 'jdbc:h2:~/data/app;MODE=PostgreSQL' }, {});
    assert.equal(t.cfg.file, `${os.homedir()}/data/app.mv.db`);
    assert.equal(resolveTarget({ id: '1', name: 'x', driver: 'sqlite', connectionType: 'url', url: 'jdbc:sqlite:/tmp/a.db?mode=ro' }, {}).cfg.file, '/tmp/a.db');
  });
});
