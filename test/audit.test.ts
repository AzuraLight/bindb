import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLocalRequest } from '../src/ai/mcpServer';
import { parseUrl, toUrl, emptyForm } from '../src/core/connectionDraft';
import { buildFilteredSql } from '../src/core/gridQuery';
import { secretKey, workspaceKey } from '../src/core/secretKeys';
import { cannotRunInTransaction, switchSchemaSql } from '../src/core/sessionSql';
import { effectiveSslMode, isSslUnsupported, tlsOptions } from '../src/drivers/common';
import { h2FileProblem } from '../src/drivers/h2';
import type { ConnectionConfig } from '../src/drivers/types';

/* 설계 점검(docs/audit-2026-11-06.md)에서 고친 항목들 */

describe('#5–7 secrets and settings that a repository must not control', () => {
  it('project connections keep their secrets per workspace; global ones keep the old key', () => {
    assert.equal(secretKey('password', 'abc'), 'bindb.pw.abc');
    assert.equal(secretKey('ssh', 'abc'), 'bindb.ssh.abc');
    const a = workspaceKey('file:///work/repo-a');
    const b = workspaceKey('file:///work/repo-b');
    assert.ok(a && b && a !== b);
    assert.equal(secretKey('password', 'abc', a), `bindb.pw.project.${a}.abc`);
    assert.notEqual(secretKey('password', 'abc', a), secretKey('password', 'abc', b), 'same id in another repository → another key');
    assert.equal(workspaceKey(undefined), undefined);
  });
});

describe('#6 MCP server: Host and Origin (DNS rebinding)', () => {
  it('accepts local hosts without an Origin, or with a same-host Origin only', () => {
    assert.ok(isLocalRequest('127.0.0.1:47999', undefined, 47999));
    assert.ok(isLocalRequest('localhost:47999', 'http://localhost:47999', 47999));
    assert.ok(!isLocalRequest('127.0.0.1:47999', 'https://evil.example', 47999), 'a web page');
    assert.ok(!isLocalRequest('127.0.0.1:47999', 'null', 47999), 'sandboxed iframe / file:// page');
    assert.ok(!isLocalRequest('evil.example:47999', undefined, 47999), 'rebound host name');
    assert.ok(!isLocalRequest('127.0.0.1:1234', undefined, 47999), 'another port');
    assert.ok(!isLocalRequest(undefined, undefined, 47999));
  });
});

describe('#10 switch schema keeps the rest of search_path', () => {
  const pg = { id: 't', name: 't', driver: 'postgres' } as ConnectionConfig;
  it('puts the schema in front of the original path, without repeating it', () => {
    assert.equal(switchSchemaSql(pg, 'sales', '"$user", public'), 'SET search_path TO "sales", "$user", public');
    assert.equal(switchSchemaSql(pg, 'sales', 'sales, public'), 'SET search_path TO "sales", public');
    assert.equal(switchSchemaSql(pg, 'My "x"', '"$user", public, "a,b"'), 'SET search_path TO "My ""x""", "$user", public, "a,b"');
    assert.equal(switchSchemaSql(pg, 'sales'), 'SET search_path TO "sales"');
    assert.equal(switchSchemaSql({ ...pg, driver: 'mysql' }, 'shop'), 'USE `shop`');
  });
});

describe('#11 manual transactions: statements that cannot run inside BEGIN', () => {
  it('knows the PostgreSQL commands documented as "cannot be executed inside a transaction block"', () => {
    for (const sql of [
      'VACUUM',
      'vacuum (analyze) t',
      'CREATE INDEX CONCURRENTLY i ON t (a)',
      'create unique index concurrently i on t (a)',
      'DROP INDEX CONCURRENTLY i',
      'REINDEX TABLE CONCURRENTLY t',
      'REINDEX DATABASE d',
      'CREATE DATABASE d',
      'DROP TABLESPACE s',
      'ALTER SYSTEM SET work_mem = 1',
      'CLUSTER',
      'CLUSTER VERBOSE',
      'DISCARD ALL',
      'CREATE SUBSCRIPTION s CONNECTION $$x$$ PUBLICATION p',
      '/* c */ VACUUM FULL',
    ]) assert.ok(cannotRunInTransaction(sql, 'postgres'), sql);
    for (const sql of ['CREATE INDEX i ON t (a)', 'CLUSTER t USING i', 'REINDEX TABLE t', 'DISCARD PLANS', 'SELECT 1', "SELECT 'VACUUM'"]) {
      assert.ok(!cannotRunInTransaction(sql, 'postgres'), sql);
    }
    assert.ok(cannotRunInTransaction('VACUUM', 'sqlite'));
    assert.ok(!cannotRunInTransaction('CREATE DATABASE d', 'sqlite'));
  });
});

describe('#13 SSL modes follow libpq', () => {
  it('reads every sslmode / ssl-mode from URLs and writes it back', () => {
    const mode = (u: string, d: 'postgres' | 'mysql') => {
      const r = parseUrl(u, d);
      return r.ok ? r.patch.ssl : r.error;
    };
    assert.equal(mode('postgresql://h/db?sslmode=prefer', 'postgres'), 'prefer');
    assert.equal(mode('postgresql://h/db?sslmode=allow', 'postgres'), 'prefer');
    assert.equal(mode('postgresql://h/db?sslmode=verify-ca', 'postgres'), 'verify-ca');
    assert.equal(mode('postgresql://h/db?sslmode=verify-full', 'postgres'), 'verify');
    assert.equal(mode('postgresql://h/db?sslmode=disable', 'postgres'), 'disable');
    assert.equal(mode('mysql://h/db?ssl-mode=PREFERRED', 'mysql'), 'prefer');
    assert.equal(mode('mysql://h/db?ssl-mode=VERIFY_CA', 'mysql'), 'verify-ca');
    assert.equal(mode('mysql://h/db?ssl-mode=VERIFY_IDENTITY', 'mysql'), 'verify');
    const form = (driver: 'postgres' | 'mysql', ssl: ConnectionConfig['ssl']) => toUrl({ ...emptyForm(driver), host: 'h', ssl: ssl! });
    assert.match(form('postgres', 'verify-ca'), /\?sslmode=verify-ca$/);
    assert.match(form('postgres', 'prefer'), /\?sslmode=prefer$/);
    assert.match(form('mysql', 'verify-ca'), /\?ssl-mode=VERIFY_CA$/);
  });

  it('Require with a CA file verifies the chain; Verify CA skips only the host name', () => {
    assert.equal(effectiveSslMode({ ssl: 'require' }), 'require');
    assert.equal(effectiveSslMode({ ssl: 'require', sslCaFile: '/ca.pem' }), 'verify-ca');
    const base = { id: 't', name: 't', driver: 'postgres', sslTruststore: { bundled: true, system: false } } as ConnectionConfig;
    const req = tlsOptions({ ...base, ssl: 'require' }, {})!;
    assert.equal(req.rejectUnauthorized, false);
    const ca = tlsOptions({ ...base, ssl: 'verify-ca' }, {})!;
    assert.equal(ca.rejectUnauthorized, true);
    assert.equal((ca.checkServerIdentity as () => unknown)(), undefined);
    const full = tlsOptions({ ...base, ssl: 'verify' }, {})!;
    assert.equal(full.rejectUnauthorized, true);
    assert.equal(full.checkServerIdentity, undefined, 'Node checks the host name');
    assert.equal(tlsOptions({ ...base, ssl: 'disable' }, {}), undefined);
  });

  it('recognises "server has no SSL" from both drivers', () => {
    assert.ok(isSslUnsupported(new Error('The server does not support SSL connections')));
    assert.ok(isSslUnsupported(new Error('Server does not support secure connection')));
    assert.ok(!isSslUnsupported(new Error('password authentication failed')));
  });
});

describe('#17 filter bar on queries', () => {
  it('refuses queries that change data, since filtering runs them again', () => {
    const r = buildFilteredSql({ query: 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d' }, { where: 'true' }, undefined, 'postgres');
    assert.deepEqual(r, { ok: false, error: 'Filtering and sorting run the query again, and this query changes data.' });
  });

  it('MySQL and H2: refuses duplicate column names instead of failing on the server', () => {
    for (const d of ['mysql', 'h2'] as const) {
      const r = buildFilteredSql({ query: 'SELECT a.id, b.id FROM t a JOIN t b ON a.id = b.id', columns: ['id', 'ID'] }, { orderBy: '1' }, undefined, d);
      assert.equal(r.ok, false, d);
    }
    assert.equal(buildFilteredSql({ query: 'SELECT 1 a, 2 a', columns: ['a', 'a'] }, { orderBy: '1' }, undefined, 'postgres').ok, true, 'PostgreSQL allows it');
  });
});

describe('#19 H2 jar and file format', () => {
  const header = (format: number) => `H:2,block:6,blockSize:1000,chunk:b,clean:1,created:1,format:${format},version:b`;
  it('each H2 jar opens its own file format only (checked with 1.4.200, 2.1.214, 2.3.232)', () => {
    assert.equal(h2FileProblem('/d/a.mv.db', '/j/h2-2.3.232.jar', header(3)), undefined);
    assert.equal(h2FileProblem('/d/a.mv.db', '/j/h2-2.1.214.jar', header(2)), undefined);
    assert.equal(h2FileProblem('/d/a.mv.db', '/j/h2-1.4.200.jar', header(1)), undefined);
    assert.match(String(h2FileProblem('/d/a.mv.db', '/j/h2-2.3.232.jar', header(1))), /format 1.*H2 1\.4\.200 jar/);
    assert.match(String(h2FileProblem('/d/a.mv.db', '/j/h2-2.3.232.jar', header(2))), /format 2.*H2 2\.1\.214 jar/);
    assert.match(String(h2FileProblem('/d/a.mv.db', '/j/h2-2.1.214.jar', header(3))), /format 3.*2\.2 or later/);
    assert.match(String(h2FileProblem('/d/old.h2.db', '/j/h2-2.3.232.jar', '')), /PageStore/);
    // 알 수 없으면 막지 않는다(jar 이름에 버전이 없음 · 머리말을 못 읽음)
    assert.equal(h2FileProblem('/d/a.mv.db', '/j/h2.jar', header(1)), undefined);
    assert.equal(h2FileProblem('/d/a.mv.db', '/j/h2-2.3.232.jar', ''), undefined);
  });
});
