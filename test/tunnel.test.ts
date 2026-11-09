import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Server, utils } from 'ssh2';
import { openTunnel } from '../src/drivers/tunnel';
import type { ConnectionConfig } from '../src/drivers/types';

/** 테스트용 SSH 서버(비밀번호 sesame) + 그 너머의 TCP 에코 서버 */
let sshPort = 0;
const dir = mkdtempSync(path.join(tmpdir(), 'bindb-ssh-'));
let echoPort = 0;
const closers: (() => void)[] = [];

before(async () => {
  const echo = createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  echoPort = (echo.address() as AddressInfo).port;
  closers.push(() => echo.close());

  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const ssh = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'me' && ctx.password === 'sesame' ? ctx.accept() : ctx.reject()));
    client.on('ready', () => {
      client.on('tcpip', (accept, _reject, info) => {
        const stream = accept();
        const out = createConnection(info.destPort, info.destIP);
        stream.pipe(out).pipe(stream);
      });
    });
    client.on('error', () => {});
  });
  await new Promise<void>((r) => ssh.listen(0, '127.0.0.1', () => r()));
  sshPort = (ssh.address() as AddressInfo).port;
  closers.push(() => ssh.close());
});
after(() => {
  closers.forEach((c) => c());
  rmSync(dir, { recursive: true, force: true });
});

const cfg = (): ConnectionConfig => ({
  id: 't',
  name: 't',
  driver: 'postgres',
  ssh: { enabled: true, host: '127.0.0.1', port: sshPort, user: 'me', auth: 'password' },
});

function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = createConnection(port, '127.0.0.1', () => s.write(text));
    s.on('data', (d) => {
      resolve(d.toString());
      s.end();
    });
    s.on('error', reject);
  });
}

const known = (name: string) => path.join(dir, name);
const target = () => ({ host: '127.0.0.1', port: echoPort });
const withSsh = (patch: object): ConnectionConfig => ({ ...cfg(), ssh: { ...cfg().ssh!, ...patch } });

describe('SSH tunnel', () => {
  it('forwards a local port through the SSH server to the target (Ask → trusted → added to known_hosts)', async () => {
    const asked: string[] = [];
    const file = known('kh1');
    const t = await openTunnel(cfg(), target(), 'sesame', { knownHostsFile: file, askHostKey: async (h, fp) => (asked.push(`${h} ${fp}`), true) });
    assert.equal(await roundTrip(t.localPort, 'ping through ssh'), 'ping through ssh');
    await t.close();
    assert.equal(asked.length, 1);
    assert.match(asked[0], new RegExp(`^\\[127\\.0\\.0\\.1\\]:${sshPort} SHA256:`));
    assert.match(readFileSync(file, 'utf8'), new RegExp(`^\\[127\\.0\\.0\\.1\\]:${sshPort} ssh-ed25519 `));
    // 두 번째는 known_hosts에 있으니 묻지 않는다
    const again = await openTunnel(cfg(), target(), 'sesame', { knownHostsFile: file, askHostKey: async () => assert.fail('should not ask') });
    await again.close();
  });

  it('rejects when the user does not trust the key, and with a wrong password', async () => {
    await assert.rejects(openTunnel(cfg(), target(), 'sesame', { knownHostsFile: known('kh2'), askHostKey: async () => false }), /not trusted/);
    await assert.rejects(openTunnel(withSsh({ strictHostKey: 'no' }), target(), 'wrong', {}), /SSH/);
  });

  it('Strict host key checking: Yes refuses unknown hosts, Accept New adds them, a changed key is refused', async () => {
    await assert.rejects(openTunnel(withSsh({ strictHostKey: 'yes' }), target(), 'sesame', { knownHostsFile: known('kh3') }), /not in/);
    const file = known('kh4');
    const t = await openTunnel(withSsh({ strictHostKey: 'acceptNew' }), target(), 'sesame', { knownHostsFile: file });
    await t.close();
    assert.match(readFileSync(file, 'utf8'), /ssh-ed25519/);
    writeFileSync(file, `[127.0.0.1]:${sshPort} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n`);
    await assert.rejects(openTunnel(withSsh({ strictHostKey: 'acceptNew' }), target(), 'sesame', { knownHostsFile: file }), /changed/);
  });

  it('Parse config file: an alias from ~/.ssh/config gives the host, port and user', async () => {
    const conf = known('ssh_config');
    writeFileSync(conf, `Host dbjump\n  HostName 127.0.0.1\n  Port ${sshPort}\n  User me\n`);
    const t = await openTunnel(
      withSsh({ host: 'dbjump', port: 22, user: '', parseConfig: true, strictHostKey: 'no' }),
      target(),
      'sesame',
      { sshConfigFile: conf },
    );
    assert.equal(await roundTrip(t.localPort, 'via alias'), 'via alias');
    await t.close();
  });
});

/**
 * 인증 방식을 고르는 두 번째 SSH 서버.
 *  - key: goodKey 공개키만 받는다
 *  - otp: goodKey 다음에 keyboard-interactive로 인증 코드 123456을 요구한다(부분 성공)
 *  - kbd: password 방식은 거절하고 keyboard-interactive의 "Password:"로 sesame를 받는다
 */
describe('SSH authentication methods', () => {
  let port = 0;
  const good = utils.generateKeyPairSync('ed25519');
  const bad = utils.generateKeyPairSync('ed25519');
  const goodPub = utils.parseKey(good.public) as ReturnType<typeof utils.parseKey> & { getPublicSSH(): Buffer; verify(d: Buffer, s: Buffer, h?: string): boolean; type: string };
  writeFileSync(path.join(dir, 'id_bad'), bad.private);
  writeFileSync(path.join(dir, 'id_good'), good.private);

  before(async () => {
    const hostKey = utils.generateKeyPairSync('ed25519').private;
    const server = new Server({ hostKeys: [hostKey] }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'publickey' && (ctx.username === 'key' || ctx.username === 'otp')) {
          if (ctx.key.algo !== goodPub.type || !ctx.key.data.equals(goodPub.getPublicSSH())) return ctx.reject();
          if (!ctx.signature) return ctx.accept(); // 이 키를 쓸 수 있는지 묻는 단계
          if (goodPub.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject();
          return ctx.username === 'otp' ? ctx.reject(['keyboard-interactive'], true) : ctx.accept();
        }
        if (ctx.method === 'keyboard-interactive' && ctx.username === 'otp') {
          return ctx.prompt([{ prompt: 'Verification code: ', echo: true }], (a) => (a[0] === '123456' ? ctx.accept() : ctx.reject()));
        }
        if (ctx.method === 'keyboard-interactive' && ctx.username === 'kbd') {
          return ctx.prompt([{ prompt: 'Password: ', echo: false }], (a) => (a[0] === 'sesame' ? ctx.accept() : ctx.reject()));
        }
        return ctx.reject(ctx.username === 'kbd' ? ['keyboard-interactive'] : ['publickey']);
      });
      client.on('ready', () => {
        client.on('tcpip', (accept, _reject, info) => {
          const stream = accept();
          const out = createConnection(info.destPort, info.destIP);
          stream.pipe(out).pipe(stream);
        });
      });
      client.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
    closers.push(() => server.close());
  });

  const via = (user: string, auth: 'key' | 'password', extra: object = {}): ConnectionConfig => ({
    ...cfg(),
    ssh: { enabled: true, host: '127.0.0.1', port, user, auth, strictHostKey: 'no', ...extra },
  });
  const config = (name: string, text: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, text);
    return file;
  };

  it('tries every IdentityFile from ~/.ssh/config in order', async () => {
    const sshConfigFile = config('cfg-keys', `Host db-alias\n  HostName 127.0.0.1\n  Port ${port}\n  IdentityFile ${path.join(dir, 'id_bad')}\n  IdentityFile ${path.join(dir, 'id_good')}\n`);
    const t = await openTunnel(via('key', 'key', { host: 'db-alias', port: 22, parseConfig: true }), target(), undefined, { sshConfigFile });
    assert.equal(await roundTrip(t.localPort, 'two keys'), 'two keys');
    await t.close();
  });

  it('asks for a one-time code after the key (keyboard-interactive, partial success)', async () => {
    const asked: string[] = [];
    const t = await openTunnel(via('otp', 'key', { keyFile: path.join(dir, 'id_good') }), target(), undefined, {
      askKeyboard: async (_title, prompts) => (asked.push(...prompts.map((p) => p.prompt)), ['123456']),
    });
    assert.equal(await roundTrip(t.localPort, 'otp'), 'otp');
    await t.close();
    assert.deepEqual(asked, ['Verification code: ']);
  });

  it('answers a keyboard-interactive password prompt with the saved password', async () => {
    const t = await openTunnel(via('kbd', 'password'), target(), 'sesame', { askKeyboard: async () => assert.fail('should not ask') });
    assert.equal(await roundTrip(t.localPort, 'kbd'), 'kbd');
    await t.close();
  });

  it('refuses hosts that need ProxyJump instead of connecting directly', async () => {
    const sshConfigFile = config('cfg-jump', `Host inner\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump bastion\n`);
    await assert.rejects(openTunnel(via('key', 'key', { host: 'inner', parseConfig: true }), target(), undefined, { sshConfigFile }), /ProxyJump \(bastion\)/);
  });
});
