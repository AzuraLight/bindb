import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildConfig, emptyForm, fieldsFor, formFromConfig, parseUrl, suggestName, toUrl, type ConnectionForm } from '../src/core/connectionDraft';
import { pgClientConfig } from '../src/drivers/postgres';

const form = (patch: Partial<ConnectionForm>): ConnectionForm => ({ ...emptyForm(patch.driver), ...patch });

describe('buildConfig', () => {
  it('builds a server connection and drops empty optional fields', () => {
    const r = buildConfig(form({ name: ' local ', host: 'db.example', port: '6543', database: '', user: 'app' }), []);
    assert.deepEqual(r, { ok: true, config: { name: 'local', driver: 'postgres', host: 'db.example', port: 6543, user: 'app' } });
  });

  it('rejects a bad port instead of silently using the default', () => {
    for (const port of ['abc', '0', '70000', '54.3']) {
      const r = buildConfig(form({ name: 'x', port }), []);
      assert.equal(r.ok, false, port);
      assert.ok(!r.ok && r.errors.port, port);
    }
  });

  it('requires a name that no other connection uses (case-insensitive)', () => {
    assert.ok(!buildConfig(form({ name: '' }), []).ok);
    const dup = buildConfig(form({ name: 'Prod' }), [{ name: 'prod' }]);
    assert.ok(!dup.ok && dup.errors.name?.includes('already exists'));
  });

  it('keeps ssl, timeout and read-only only where they apply', () => {
    const pg = buildConfig(form({ name: 'p', ssl: 'verify', connectTimeout: '30', readOnly: true }), []);
    assert.ok(pg.ok);
    assert.equal(pg.ok && pg.config.ssl, 'verify');
    assert.equal(pg.ok && pg.config.connectTimeout, 30);
    assert.equal(pg.ok && pg.config.readOnly, true);

    const lite = buildConfig(form({ driver: 'sqlite', name: 's', file: '/tmp/a.db', ssl: 'verify', connectTimeout: '30' }), []);
    assert.deepEqual(lite, { ok: true, config: { name: 's', driver: 'sqlite', file: '/tmp/a.db' } });

    const bad = buildConfig(form({ name: 'p', connectTimeout: '0' }), []);
    assert.ok(!bad.ok && bad.errors.connectTimeout);
  });

  it('needs a file for SQLite and an .mv.db file for H2 file mode', () => {
    assert.ok(!buildConfig(form({ driver: 'sqlite', name: 's' }), []).ok);
    const h2 = buildConfig(form({ driver: 'h2', h2Mode: 'file', name: 'h', file: '/x/data.db' }), []);
    assert.ok(!h2.ok && h2.errors.file);
    const ok = buildConfig(form({ driver: 'h2', h2Mode: 'file', name: 'h', file: '/x/data.mv.db', user: 'sa' }), []);
    assert.deepEqual(ok, { ok: true, config: { name: 'h', driver: 'h2', file: '/x/data.mv.db', user: 'sa' } });
  });

  it('round-trips through formFromConfig', () => {
    const cfg = { id: '1', name: 'm', driver: 'mysql' as const, host: 'h', port: 3307, database: 'd', user: 'u', ssl: 'require' as const, connectTimeout: 5, readOnly: true };
    const r = buildConfig(formFromConfig(cfg), []);
    const { id: _id, ...rest } = cfg;
    assert.deepEqual(r, { ok: true, config: rest });
    assert.equal(formFromConfig({ id: '2', name: 'h', driver: 'h2', file: '/a.mv.db' }).h2Mode, 'file');
  });
});

describe('form helpers', () => {
  it('shows file or server fields per driver and mode', () => {
    assert.deepEqual(fieldsFor('sqlite', 'server'), { file: true, server: false, credentials: false, ssl: false, timeout: false });
    assert.equal(fieldsFor('h2', 'file').file, true);
    assert.equal(fieldsFor('h2', 'server').ssl, false);
  });

  it('suggests a name from the file or db@host', () => {
    assert.equal(suggestName(form({ driver: 'sqlite', file: '/a/b/shop.sqlite3' })), 'shop');
    assert.equal(suggestName(form({ driver: 'h2', h2Mode: 'file', file: 'C:\\x\\test.mv.db' })), 'test');
    assert.equal(suggestName(form({ database: 'app', host: 'db' })), 'app@db');
  });
});

describe('driver options', () => {
  it('maps ssl and timeout onto the pg client config', () => {
    const base = { id: '1', name: 'p', driver: 'postgres' as const };
    assert.equal(pgClientConfig(base, {}).ssl, false);
    assert.equal(pgClientConfig(base, {}).connectionTimeoutMillis, 10000);
    assert.deepEqual(pgClientConfig({ ...base, ssl: 'require', connectTimeout: 3 }, {}).ssl, { rejectUnauthorized: false });
    assert.equal(pgClientConfig({ ...base, connectTimeout: 3 }, {}).connectionTimeoutMillis, 3000);
    assert.deepEqual(pgClientConfig({ ...base, ssl: 'verify' }, {}).ssl, { rejectUnauthorized: true });
  });
});

describe('connection URL', () => {
  it('builds a URL from the fields, without the password', () => {
    assert.equal(toUrl(form({ host: 'db', port: '6543', database: 'app', user: 'me', ssl: 'verify' })), 'postgresql://me@db:6543/app?sslmode=verify-full');
    assert.equal(toUrl(form({ driver: 'mysql', host: 'h', user: 'root', ssl: 'require' })), 'mysql://root@h:3306?ssl-mode=REQUIRED');
  });

  it('fills the fields from a pasted URL, including jdbc: and the password', () => {
    const r = parseUrl('jdbc:postgresql://u%40x:p%3Aw@db.example:5433/my%20db?sslmode=require', 'postgres');
    assert.deepEqual(r, { ok: true, patch: { host: 'db.example', port: '5433', database: 'my db', user: 'u@x', ssl: 'require' }, password: 'p:w' });
    const v6 = parseUrl('postgres://[::1]/x', 'postgres');
    assert.ok(v6.ok && v6.patch.host === '::1' && v6.patch.port === '');
  });

  it('round-trips toUrl → parseUrl', () => {
    const f = form({ driver: 'mysql', host: 'h', port: '3307', database: 'd', user: 'u', ssl: 'verify' });
    const r = parseUrl(toUrl(f), 'mysql');
    assert.ok(r.ok);
    assert.deepEqual(r.ok && r.patch, { host: 'h', port: '3307', database: 'd', user: 'u', ssl: 'verify' });
  });

  it('rejects other schemes and a scheme that does not match the driver', () => {
    assert.ok(!parseUrl('db.example:5432', 'postgres').ok);
    assert.ok(!parseUrl('mongodb://h/x', 'postgres').ok);
    const r = parseUrl('mysql://h/x', 'postgres');
    assert.ok(!r.ok && r.error.includes('MySQL'));
  });

  it('keeps the comment', () => {
    const r = buildConfig(form({ name: 'c', comment: '  staging  ' }), []);
    assert.equal(r.ok && r.config.comment, 'staging');
  });
});
