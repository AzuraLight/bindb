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
    assert.deepEqual(resolveSshConfig(conf, 'prod-db', '/home/me'), {
      hostName: '10.0.0.prod-db',
      user: 'deploy',
      port: 2222,
      identityFile: '/home/me/.ssh/id_prod',
      identityFiles: ['/home/me/.ssh/id_prod'],
    });
    assert.deepEqual(resolveSshConfig(conf, 'web'), { user: 'fallback', port: 22, identityFiles: [] });
    assert.deepEqual(resolveSshConfig(conf, 'skip'), { identityFiles: [] });
  });

  it('collects every IdentityFile, expands tokens, follows Include, reports ProxyJump', () => {
    const files: Record<string, string> = {
      '/home/me/.ssh/conf.d/work': 'Host db\n  IdentityFile ~/.ssh/id_%r_%h\n  ProxyJump bastion\n',
    };
    const conf = `
Include conf.d/*
Host db
  HostName db.%h.internal
  User alice
  Port 2200
  IdentityFile %d/.ssh/id_ed25519
  IdentityFile ~/.ssh/id_rsa
  IdentityFile none
`;
    const include = (pattern: string) => {
      const full = pattern.startsWith('/') ? pattern : `/home/me/.ssh/${pattern}`;
      const re = new RegExp(`^${full.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
      return Object.keys(files).filter((f) => re.test(f)).map((f) => files[f]);
    };
    const e = resolveSshConfig(conf, 'db', { home: '/home/me', localUser: 'me', include });
    assert.equal(e.hostName, 'db.db.internal');
    assert.equal(e.user, 'alice');
    // Include가 먼저 나왔으므로 그 IdentityFile이 먼저. %r은 User(alice), %h는 HostName
    assert.deepEqual(e.identityFiles, ['/home/me/.ssh/id_alice_db.db.internal', '/home/me/.ssh/id_ed25519', '/home/me/.ssh/id_rsa']);
    assert.equal(e.proxyJump, 'bastion');
    // Include 안의 Host 블록이 다른 호스트면 적용하지 않는다
    assert.deepEqual(resolveSshConfig(conf, 'other', { home: '/home/me', include }), { identityFiles: [] });
    // Match 블록은 건너뛴다
    assert.deepEqual(resolveSshConfig('Match user x\n  User nope\nHost *\n  User yes\n', 'h'), { user: 'yes', identityFiles: [] });
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

  it('negated patterns, other key types, @revoked and @cert-authority', () => {
    const line = (hosts: string, kk: Buffer) => `${hosts} ${keyType(kk)} ${kk.toString('base64')}\n`;
    // *.example 이지만 !bad.example 은 아니다
    assert.equal(checkKnownHost(line('*.example,!bad.example', k), 'db.example', 22, k), 'known');
    assert.equal(checkKnownHost(line('*.example,!bad.example', other), 'bad.example', 22, k), 'unknown');
    // 그 호스트에 다른 종류의 키만 있으면 바뀐 것이 아니라 처음 보는 키
    const ecdsa = key('ecdsa-sha2-nistp256', 'CCCC');
    assert.equal(checkKnownHost(line('db.example', ecdsa), 'db.example', 22, k), 'unknown');
    assert.equal(checkKnownHost(line('db.example', ecdsa) + line('db.example', other), 'db.example', 22, k), 'changed');
    // @revoked는 다른 줄에 같은 키가 있어도 거부. 다른 호스트의 @revoked는 상관없다
    assert.equal(checkKnownHost(`@revoked db.example ${keyType(k)} ${k.toString('base64')}\n` + line('db.example', k), 'db.example', 22, k), 'revoked');
    assert.equal(checkKnownHost(`@revoked other ${keyType(k)} ${k.toString('base64')}\n` + line('db.example', k), 'db.example', 22, k), 'known');
    // @cert-authority 줄은 호스트 키와 비교하지 않는다
    assert.equal(checkKnownHost(`@cert-authority db.example ${keyType(other)} ${other.toString('base64')}\n`, 'db.example', 22, k), 'unknown');
  });

  it('fingerprints like ssh-keygen', () => {
    assert.match(fingerprint(k), /^SHA256:[A-Za-z0-9+/]+$/);
  });
});
