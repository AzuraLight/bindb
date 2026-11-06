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
