import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { checkKnownHost, fingerprint, hostPattern, keyType, knownHostsLine, resolveSshConfig } from '../src/drivers/sshHosts';

const key = (type: string, body: string) => {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(t.length);
  return Buffer.concat([len, t, Buffer.from(body)]);
};

describe('~/.ssh/config', () => {
  it('resolves an alias, first value wins, wildcards and negation', () => {
    const conf = `
Host bastion prod-*
  HostName 10.0.0.%h
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_prod
Host prod-db
  User other
Host * !skip
  User fallback
  Port 22
`;
    assert.deepEqual(resolveSshConfig(conf, 'prod-db', '/home/me'), { hostName: '10.0.0.prod-db', user: 'deploy', port: 2222, identityFile: '/home/me/.ssh/id_prod' });
    assert.deepEqual(resolveSshConfig(conf, 'web'), { user: 'fallback', port: 22 });
    assert.deepEqual(resolveSshConfig(conf, 'skip'), {});
  });
});

describe('known_hosts (Strict host key checking)', () => {
  const k = key('ssh-ed25519', 'AAAA-key-one');
  const other = key('ssh-ed25519', 'BBBB-key-two');

  it('matches plain, [host]:port and hashed entries', () => {
    const plain = knownHostsLine('db.example', 22, keyType(k), k);
    assert.equal(checkKnownHost(plain, 'db.example', 22, k), 'known');
    assert.equal(checkKnownHost(plain, 'db.example', 22, other), 'changed');
    assert.equal(checkKnownHost(plain, 'db.example', 2222, k), 'unknown', '[host]:port is a different entry');
    assert.equal(hostPattern('h', 2222), '[h]:2222');

    const salt = randomBytes(20);
    const hash = createHmac('sha1', salt).update('[db.example]:2222').digest('base64');
    const hashed = `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${k.toString('base64')}\n`;
    assert.equal(checkKnownHost(hashed, 'db.example', 2222, k), 'known');
    assert.equal(checkKnownHost(hashed, 'other', 2222, k), 'unknown');
  });

  it('fingerprints like ssh-keygen', () => {
    assert.match(fingerprint(k), /^SHA256:[A-Za-z0-9+/]+$/);
  });
});
