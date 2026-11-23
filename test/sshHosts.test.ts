import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { checkKnownHost, expandProxyCommand, fingerprint, hostPattern, keyType, knownHostsLine, parseJumpHost, resolveSshConfig } from '../src/drivers/sshHosts';

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

/** [ProxyJump, ProxyCommand] */
const proxy = (e: ReturnType<typeof resolveSshConfig>) => [e.proxyJump, e.proxyCommand];

describe('ProxyJump / ProxyCommand in ssh_config', () => {
  it('uses whichever comes first, and none takes the place too', () => {
    assert.deepEqual(proxy(resolveSshConfig('Host a\n  ProxyCommand nc %h %p\n  ProxyJump b\n', 'a')), [undefined, 'nc %h %p']);
    assert.deepEqual(proxy(resolveSshConfig('Host a\n  ProxyJump b,c\nHost *\n  ProxyCommand nc %h %p\n', 'a')), ['b,c', undefined]);
    assert.deepEqual(proxy(resolveSshConfig('Host a\n  ProxyJump none\nHost *\n  ProxyJump bastion\n', 'a')), [undefined, undefined]);
  });

  it('reads jump host specs', () => {
    assert.deepEqual(parseJumpHost('bastion'), { host: 'bastion', user: undefined, port: undefined });
    assert.deepEqual(parseJumpHost('me@bastion:2222'), { host: 'bastion', user: 'me', port: 2222 });
    assert.deepEqual(parseJumpHost('ssh://me@10.0.0.1:22'), { host: '10.0.0.1', user: 'me', port: 22 });
    assert.deepEqual(parseJumpHost('[::1]:2200'), { host: '::1', user: undefined, port: 2200 });
    assert.deepEqual(parseJumpHost('a@b@host'), { host: 'host', user: 'a@b', port: undefined });
  });

  it('expands ProxyCommand tokens', () => {
    assert.equal(
      expandProxyCommand('ssh -W %h:%p -l %r %n %%x', { host: '10.0.0.5', port: 2222, user: 'me', alias: 'db' }),
      'ssh -W 10.0.0.5:2222 -l me db %x',
    );
  });
});

describe('ProxyJump / ProxyCommand edge cases', () => {
  const withFiles = (files: Record<string, string>) => ({ home: '/home/me', include: (p: string) => (files[p] !== undefined ? [files[p]] : []) });

  it('ProxyJump / ProxyCommand from Include files and Host * blocks', () => {
    assert.deepEqual(proxy(resolveSshConfig('Host *\n  Include extra\n', 'db', withFiles({ extra: 'ProxyJump bastion\n' }))), ['bastion', undefined]);
    assert.deepEqual(proxy(resolveSshConfig('Include extra\nHost db\n  ProxyJump b\n', 'db', withFiles({ extra: 'Host *\n  ProxyCommand nc %h %p\n' }))), [undefined, 'nc %h %p']);
    // Include 안의 다른 Host 블록은 이 호스트에 적용하지 않는다
    assert.deepEqual(proxy(resolveSshConfig('Include extra\nHost db\n  ProxyJump b\n', 'db', withFiles({ extra: 'Host other\n  ProxyJump x\n' }))), ['b', undefined]);
    // Include가 맞지 않는 Host 블록 안에 있으면 읽지 않는다
    assert.deepEqual(proxy(resolveSshConfig('Host other\n  Include extra\nHost db\n  ProxyJump b\n', 'db', withFiles({ extra: 'ProxyJump x\n' }))), ['b', undefined]);
  });

  it('after an Include, the enclosing Host block still applies (ssh_config(5) restores it)', () => {
    assert.deepEqual(proxy(resolveSshConfig('Host db\n  Include extra\n  ProxyJump b\n', 'db', withFiles({ extra: 'Host other\n  User o\n' }))), ['b', undefined]);
    assert.deepEqual(proxy(resolveSshConfig('Include extra\nProxyJump b\n', 'db', withFiles({ extra: 'Host other\n  User o\n' }))), ['b', undefined]);
  });

  it('Match blocks are skipped, Host after Match applies again', () => {
    assert.deepEqual(proxy(resolveSshConfig('Match host db\n  ProxyJump x\nHost db\n  ProxyCommand y %h\n', 'db')), [undefined, 'y %h']);
    assert.deepEqual(proxy(resolveSshConfig('Host db\n  User a\nMatch all\n  ProxyJump x\n', 'db')), [undefined, undefined]);
  });

  it('none takes the place in either order and any case', () => {
    assert.deepEqual(proxy(resolveSshConfig('Host db\n  ProxyCommand none\nHost *\n  ProxyJump b\n', 'db')), [undefined, undefined]);
    assert.deepEqual(proxy(resolveSshConfig('Host db\n  ProxyJump NONE\n  ProxyCommand nc %h %p\n', 'db')), [undefined, undefined]);
    assert.deepEqual(proxy(resolveSshConfig('Host *\n  ProxyJump b\nHost db\n  ProxyJump none\n', 'db')), ['b', undefined]);
  });

  it('= syntax and quotes: ProxyCommand keeps the rest of the line as written, ProxyJump drops quotes', () => {
    assert.deepEqual(proxy(resolveSshConfig('Host db\n  ProxyCommand = "/opt/my nc" %h %p\n', 'db')), [undefined, '"/opt/my nc" %h %p']);
    assert.deepEqual(proxy(resolveSshConfig('Host db\n  ProxyJump=b\n', 'db')), ['b', undefined]);
    assert.deepEqual(proxy(resolveSshConfig('Host db\n  proxyjump="me@b:2222"\n', 'db')), ['me@b:2222', undefined]);
    assert.deepEqual(proxy(resolveSshConfig('Host db\n\tProxyJump\tb1,b2\r\n', 'db')), ['b1,b2', undefined]);
  });

  it('Key=value without spaces around = when the value itself has spaces', () => {
    assert.deepEqual(proxy(resolveSshConfig('Host db\n  ProxyCommand=ssh -W %h:%p "jump host"\n', 'db')), [undefined, 'ssh -W %h:%p "jump host"']);
  });

  it('ProxyCommand tokens are left for the tunnel to expand (not the config %h of HostName)', () => {
    const e = resolveSshConfig('Host db\n  HostName 10.0.0.9\n  ProxyCommand nc %h %p\n', 'db');
    assert.equal(e.proxyCommand, 'nc %h %p');
    assert.equal(expandProxyCommand(e.proxyCommand!, { host: e.hostName!, port: 22, user: 'u', alias: 'db' }), 'nc 10.0.0.9 22');
    // 모르는 토큰은 그대로 둔다
    assert.equal(expandProxyCommand('x %u %C %h', { host: 'h', port: 1, user: 'u', alias: 'a' }), 'x %u %C h');
  });

  it('Include restores the enclosing state across nested Includes', () => {
    const files = withFiles({
      // a: 맞지 않는 Host 블록 안의 Include b는 읽지 않는다. 끝의 Host other는 a 안에서만
      a: 'User from-a\nHost other\n  Include b\n  Port 1\nHost other2\n',
      b: 'Port 2\n',
      // c: Include d가 Host 블록을 바꿔도 c의 다음 줄은 c의 상태(모든 호스트)로 돌아온다
      c: 'Include d\nIdentityFile after-d\n',
      d: 'Host nomatch\n  ProxyJump nope\n',
      // e → f → g: 가장 안쪽의 Match도 바깥 두 단계로 새지 않는다
      e: 'Include f\nHostName from-e\n',
      f: 'Include g\nUser from-f\n',
      g: 'Match all\n  Port 9\n',
    });
    assert.deepEqual(resolveSshConfig('Host db\n  Include a\n  Port 3\n', 'db', files), { user: 'from-a', port: 3, identityFiles: [] });
    assert.deepEqual(resolveSshConfig('Host db\n  Include c\n  ProxyJump j\n', 'db', files), { proxyJump: 'j', identityFiles: ['after-d'], identityFile: 'after-d' });
    assert.deepEqual(resolveSshConfig('Host db\n  Include e\n  Port 4\n', 'db', files), { hostName: 'from-e', user: 'from-f', port: 4, identityFiles: [] });
    // 맞지 않는 블록 안의 중첩 Include는 어느 단계도 읽지 않는다
    assert.deepEqual(resolveSshConfig('Host other\n  Include e\nHost db\n  Port 5\n', 'db', files), { port: 5, identityFiles: [] });
    // Include 뒤의 Host 줄은 평소대로 상태를 바꾼다
    assert.deepEqual(resolveSshConfig('Host db\n  Include c\nHost other\n  User nope\n', 'db', files), { identityFiles: ['after-d'], identityFile: 'after-d' });
  });

  it('an Include loop stops and the lines after it still apply', () => {
    const self = withFiles({ loop: 'Include loop\nIdentityFile k\n' });
    const e = resolveSshConfig('Host db\n  Include loop\n  User after\n', 'db', self);
    assert.equal(e.user, 'after');
    assert.ok(e.identityFiles.length > 0 && e.identityFiles.length <= 16, String(e.identityFiles.length));
  });

  it('Key = value, Key=value, Key value with tabs, and key case', () => {
    const forms = ['User = bob', 'User=bob', 'User\tbob', 'User\t=\tbob', '\tuser  =bob  ', 'USER bob # trailing comment', 'User "bob"'];
    for (const line of forms) assert.equal(resolveSshConfig(`Host db\n${line}\n`, 'db').user, 'bob', JSON.stringify(line));
    assert.equal(resolveSshConfig('Host=db\nPort = 2222\n', 'db').port, 2222);
    assert.equal(resolveSshConfig('Host\tdb other\n\tPort\t2201\n', 'other').port, 2201);
    assert.deepEqual(resolveSshConfig('Host db\n  IdentityFile = "~/my key"\n', 'db', '/home/me').identityFiles, ['/home/me/my key']);
    // 값 안의 = 는 값의 일부다
    assert.equal(resolveSshConfig('Host db\n  ProxyCommand ssh -o Foo=bar -W %h:%p j\n', 'db').proxyCommand, 'ssh -o Foo=bar -W %h:%p j');
    assert.equal(resolveSshConfig('Host db\n  ProxyCommand\t=\tssh -W %h:%p j\n', 'db').proxyCommand, 'ssh -W %h:%p j');
    // 숫자가 아닌 Port는 자리를 차지하지 않아 다음 Port 줄이 쓰인다
    assert.equal(resolveSshConfig('Host db\n  Port abc\n  Port 2022\n', 'db').port, 2022);
  });

  it('jump host specs: empty user, IPv6 with and without port, bare IPv6, scheme case, whitespace', () => {
    assert.deepEqual(parseJumpHost('@bastion'), { host: 'bastion', user: undefined, port: undefined });
    assert.deepEqual(parseJumpHost('[::1]'), { host: '::1', user: undefined, port: undefined });
    assert.deepEqual(parseJumpHost('me@[fe80::1]:2200'), { host: 'fe80::1', user: 'me', port: 2200 });
    assert.deepEqual(parseJumpHost('::1'), { host: '::1', user: undefined, port: undefined });
    assert.deepEqual(parseJumpHost('fe80::1:22'), { host: 'fe80::1:22', user: undefined, port: undefined });
    assert.deepEqual(parseJumpHost('SSH://me@h'), { host: 'h', user: 'me', port: undefined });
    assert.deepEqual(parseJumpHost('  me@h:2022 '), { host: 'h', user: 'me', port: 2022 });
  });

  it('jump host specs: dotted user names and user@domain users', () => {
    assert.deepEqual(parseJumpHost('first.last@bastion:2200'), { host: 'bastion', user: 'first.last', port: 2200 });
    assert.deepEqual(parseJumpHost('me@corp.example@[::1]:22'), { host: '::1', user: 'me@corp.example', port: 22 });
  });
});

describe('ProxyCommand metacharacter boundaries', () => {
  const t = (patch: Partial<{ host: string; user: string; alias: string }>) => ({ host: 'h', port: 22, user: 'u', alias: 'a', ...patch });
  const refused = (patch: Partial<{ host: string; user: string; alias: string }>) => assert.throws(() => expandProxyCommand('nc %h %p %r %n', t(patch)), /not allowed in a ProxyCommand/, JSON.stringify(patch));

  it('accepts IPv6 hosts, dotted / @ user names, % in the alias, and does not expand twice', () => {
    assert.equal(expandProxyCommand('nc %h %p', t({ host: '::1' })), 'nc ::1 22');
    assert.equal(expandProxyCommand('nc %h %p', t({ host: '[::1]' })), 'nc [::1] 22');
    assert.equal(expandProxyCommand('nc %h %p', t({ host: 'fe80::1%en0' })), 'nc fe80::1%en0 22');
    assert.equal(expandProxyCommand('ssh -l %r %h', t({ user: 'first.last' })), 'ssh -l first.last h');
    assert.equal(expandProxyCommand('ssh -l %r %h', t({ user: 'me@corp.example' })), 'ssh -l me@corp.example h');
    assert.equal(expandProxyCommand('ssh -l %r %h', t({ user: 'a-b_c' })), 'ssh -l a-b_c h');
    // 바꿔 넣은 값의 %h는 다시 바꾸지 않는다
    assert.equal(expandProxyCommand('x %n %h', t({ alias: 'db%h', host: 'real' })), 'x db%h real');
    assert.equal(expandProxyCommand('x %n', t({ alias: '100%' })), 'x 100%');
    assert.equal(expandProxyCommand('x %h', t({ host: '%p' })), 'x %p');
  });

  it('refuses each shell metacharacter, whitespace and a leading dash, in host, user and alias', () => {
    for (const ch of [' ', '\t', '\n', "'", '"', '`', '$', '\\', ';', '&', '<', '>', '|', '(', ')', '{', '}', '*', '?', '!', '#', '~']) {
      refused({ host: `a${ch}b` });
      refused({ user: `a${ch}b` });
      refused({ alias: `a${ch}b` });
    }
    refused({ host: '-oProxyCommand=x' });
    refused({ user: '-l' });
    refused({ alias: '-x' });
    // 가운데의 - 는 괜찮다
    assert.equal(expandProxyCommand('nc %h', t({ host: 'db-1.example' })), 'nc db-1.example');
  });

  it('only checks the values the command uses (a user name with a space is fine without %r)', () => {
    assert.equal(expandProxyCommand('nc %h %p', t({ user: 'John Smith', alias: 'a b' })), 'nc h 22');
    assert.equal(expandProxyCommand('nc %h %p', t({ user: 'CORP\\jdoe' })), 'nc h 22');
    assert.equal(expandProxyCommand('nc 10.0.0.1 22', t({ host: 'a;b' })), 'nc 10.0.0.1 22');
    assert.throws(() => expandProxyCommand('ssh -l %r %h', t({ user: 'John Smith' })), /the user "John Smith"/);
    // %%r 은 글자 %r 이라 사용자 이름이 들어가지 않는다
    assert.equal(expandProxyCommand('x %%r', t({ user: 'a b' })), 'x %r');
  });

  it('an empty user is allowed (nothing to inject)', () => {
    assert.equal(expandProxyCommand('nc %h %p %r.', t({ user: '' })), 'nc h 22 .');
  });

  it('%% runs: an odd run ends in a real token (checked), an even run is only percent signs', () => {
    assert.equal(expandProxyCommand('x %%%h', t({})), 'x %h');
    assert.throws(() => expandProxyCommand('x %%%h', t({ host: 'a;b' })), /the host "a;b"/);
    assert.throws(() => expandProxyCommand('x %%%r', t({ user: 'a b' })), /the user "a b"/);
    assert.equal(expandProxyCommand('x %%%%h', t({ host: 'a;b' })), 'x %%h');
    assert.equal(expandProxyCommand('x %%%%', t({})), 'x %%');
    // %%h 다음에 진짜 %h가 있으면 그 값은 검사한다
    assert.throws(() => expandProxyCommand('x %%h %h', t({ host: 'a;b' })), /the host "a;b"/);
  });

  it('a lone % at the end, other letters and upper-case tokens are left as written and not checked', () => {
    assert.equal(expandProxyCommand('x 100%', t({})), 'x 100%');
    assert.equal(expandProxyCommand('x %', t({ host: 'a;b' })), 'x %');
    assert.equal(expandProxyCommand('x %H %R %N', t({ host: 'a;b', user: 'a b', alias: '$x' })), 'x %H %R %N');
    assert.equal(expandProxyCommand('x %d %u %C %L %l', t({ host: 'a;b', user: 'a b', alias: '$x' })), 'x %d %u %C %L %l');
  });

  it('%p is never checked (a number), and tokens next to each other each expand', () => {
    assert.equal(expandProxyCommand('x %p', t({ host: 'a;b', user: 'a b', alias: 'a b' })), 'x 22');
    assert.equal(expandProxyCommand('%h%p%r%n', t({})), 'h22ua');
    assert.equal(expandProxyCommand('%h:%p', { host: 'db', port: 65535, user: 'u', alias: 'a' }), 'db:65535');
  });

  it('the error names which value was refused (host, user, host alias), checked in command order', () => {
    assert.throws(() => expandProxyCommand('x %n', t({ alias: 'a b' })), /^Error: SSH: the host alias "a b" contains characters that are not allowed in a ProxyCommand\.$/);
    // 앞에 나온 토큰의 값부터 검사한다
    assert.throws(() => expandProxyCommand('x %r %h', t({ host: 'a;b', user: 'c d' })), /the user "c d"/);
    assert.throws(() => expandProxyCommand('x %h %r', t({ host: 'a;b', user: 'c d' })), /the host "a;b"/);
  });

  it('other whitespace (CR, NBSP) is refused; characters the shell does not treat specially are kept', () => {
    refused({ host: 'a\rb' });
    refused({ user: 'a b' });
    refused({ alias: 'a\vb' });
    for (const host of ['café', 'a/b', 'a,b', 'a=b', 'a:b', 'a@b', 'a+b', 'a%b', 'a.b-c_d']) {
      assert.equal(expandProxyCommand('nc %h', t({ host })), `nc ${host}`, host);
    }
    // 가운데의 - 는 괜찮고, 사용자 · 별칭도 같다
    assert.equal(expandProxyCommand('x %r %n', t({ user: 'a-', alias: 'b-' })), 'x a- b-');
  });
});
