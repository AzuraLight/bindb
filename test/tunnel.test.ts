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
/** 비밀번호 서버가 넘겨 준 목적지 포트들(점프 호스트로 거쳐 갔는지 확인한다) */
const forwarded: number[] = [];
/** 서버마다 지금 열려 있는 SSH 연결 수(터널을 닫으면 서버 쪽에서도 끊겼는지 본다) */
const live = { password: 0, auth: 0 };
/**
 * 접속이 거절된 뒤에 늦게 터지는 예외(프록시 스트림의 AbortError, handshake 시간 초과 뒤 ssh2의 두 번째 'error')가
 * 있으면 이 테스트 안에서 드러나도록 잠시 기다린다.
 */
const afterLeak = () => new Promise((r) => setTimeout(r, 500));

before(async () => {
  const echo = createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  echoPort = (echo.address() as AddressInfo).port;
  closers.push(() => echo.close());

  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const ssh = new Server({ hostKeys: [hostKey] }, (client) => {
    live.password++;
    client.on('close', () => live.password--);
    // 실제 서버처럼 남은 인증 방법(password)을 알린다
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'me' && ctx.password === 'sesame' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => {
      client.on('tcpip', (accept, _reject, info) => {
        forwarded.push(info.destPort);
        const stream = accept();
        const out = createConnection(info.destPort, info.destIP);
        stream.pipe(out).pipe(stream);
        out.on('error', () => stream.destroy());
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
      live.auth++;
      client.on('close', () => live.auth--);
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

  /** 에이전트가 있는 개발 기기에서도 같은 순서로 시도하도록 테스트 동안 SSH_AUTH_SOCK을 뺀다 */
  const noAgent = async <T>(fn: () => Promise<T>): Promise<T> => {
    const saved = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
    try {
      return await fn();
    } finally {
      if (saved !== undefined) process.env.SSH_AUTH_SOCK = saved;
    }
  };
  /**
   * 에이전트 없이(noAgent) ~/.ssh/config의 별칭 host로 터널을 연다. 마지막 서버는 id_good 키로 인증한다.
   * @param ssh 데이터 소스 SSH 설정에 덧붙일 값
   * @param conn 데이터 소스에 덧붙일 값(connectTimeout 등)
   */
  const openAlias = (host: string, opts: Parameters<typeof openTunnel>[3], ssh: object = {}, conn: Partial<ConnectionConfig> = {}) =>
    noAgent(() => openTunnel({ ...via('key', 'key', { host, parseConfig: true, keyFile: path.join(dir, 'id_good'), ...ssh }), ...conn }, target(), undefined, opts));
  /** 비밀번호 서버(첫 describe의 sshPort)를 점프 호스트로 쓰는 설정 */
  const bastion = () => `Host bastion\n  HostName 127.0.0.1\n  Port ${sshPort}\n  User me\n  IdentityFile ${path.join(dir, 'no_such_key')}\n`;
  /** 프록시 명령으로 실행할 스크립트를 써 두고 경로를 돌려준다 */
  const script = config;

  it('ProxyJump: reaches the server through a jump host, asking the jump host password', async () => {
    const sshConfigFile = config('cfg-jump', `${bastion()}Host inner\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump bastion\n`);
    const asked: string[] = [];
    const before = forwarded.length;
    const t = await openAlias('inner', {
      sshConfigFile,
      askKeyboard: async (title, prompts) => (asked.push(`${title} | ${prompts.map((p) => p.prompt).join()}`), ['sesame']),
    });
    assert.equal(await roundTrip(t.localPort, 'via bastion'), 'via bastion');
    await t.close();
    // 점프 호스트의 비밀번호만 물었고(데이터 소스의 키는 마지막 서버에), 점프 호스트가 마지막 서버로 넘겼다
    assert.deepEqual(asked, ['SSH jump host bastion | Password for me@bastion:']);
    assert.ok(forwarded.slice(before).includes(port));
  });

  it('the time spent answering the jump host password does not count toward connectTimeout', { timeout: 10_000 }, async () => {
    const sshConfigFile = config('cfg-jump-slow', `${bastion()}Host inner-slow\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump bastion\n`);
    const t = await openAlias(
      'inner-slow',
      { sshConfigFile, askKeyboard: () => new Promise((r) => setTimeout(() => r(['sesame']), 2500)) },
      {},
      { connectTimeout: 1 },
    );
    assert.equal(await roundTrip(t.localPort, 'slow answer'), 'slow answer');
    await t.close();
  });

  it('ProxyJump with several hops (user@host:port, then an alias)', async () => {
    const sshConfigFile = config('cfg-jump2', `${bastion()}Host inner2\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump me@127.0.0.1:${sshPort},bastion\n`);
    let asks = 0;
    const t = await openAlias('inner2', { sshConfigFile, askKeyboard: async () => (asks++, ['sesame']) });
    assert.equal(await roundTrip(t.localPort, 'two hops'), 'two hops');
    await t.close();
    assert.equal(asks, 2);
  });

  it('ProxyCommand: runs the command and uses its standard input/output (%h %p)', async () => {
    const proxy = script('proxy.js', "const s = require('net').connect(Number(process.argv[3]), process.argv[2]); process.stdin.pipe(s).pipe(process.stdout); s.on('close', () => process.exit(0));\n");
    const sshConfigFile = config('cfg-cmd', `Host viacmd\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyCommand "${process.execPath}" "${proxy}" %h %p\n`);
    const t = await openTunnel(via('key', 'key', { host: 'viacmd', parseConfig: true, keyFile: path.join(dir, 'id_good') }), target(), undefined, { sshConfigFile });
    assert.equal(await roundTrip(t.localPort, 'via command'), 'via command');
    await t.close();
  });

  it('ProxyCommand failures show the command error', async () => {
    const fail = script('fail.js', "process.stderr.write('boom: no route to host\\n'); setTimeout(() => process.exit(1), 50);\n");
    const sshConfigFile = config('cfg-cmdfail', `Host badcmd\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyCommand "${process.execPath}" "${fail}"\n`);
    await assert.rejects(
      openTunnel(via('key', 'key', { host: 'badcmd', parseConfig: true, keyFile: path.join(dir, 'id_good') }), target(), undefined, { sshConfigFile }),
      /boom: no route to host/,
    );
    await afterLeak();
  });

  it('a jump host still asks the password when the SSH agent socket is dead', async () => {
    const sshConfigFile = config('cfg-deadagent', `${bastion()}Host inner-da\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump bastion\n`);
    const saved = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = path.join(dir, 'no_such_agent.sock');
    try {
      const asked: string[] = [];
      const t = await openTunnel(
        via('key', 'key', { host: 'inner-da', parseConfig: true, keyFile: path.join(dir, 'id_good') }),
        target(),
        undefined,
        { sshConfigFile, askKeyboard: async (title, prompts) => (asked.push(`${title} | ${prompts.map((p) => p.prompt).join()}`), ['sesame']) },
      );
      assert.equal(await roundTrip(t.localPort, 'dead agent'), 'dead agent');
      await t.close();
      assert.deepEqual(asked, ['SSH jump host bastion | Password for me@bastion:']);
    } finally {
      if (saved === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = saved;
    }
  });

  it('a connection that closes after the server banner fails instead of hanging', { timeout: 5000 }, async () => {
    const banner = script('banner.js', "process.stdout.write('SSH-2.0-fake\\r\\n'); setTimeout(() => process.exit(0), 50);\n");
    const sshConfigFile = config('cfg-banner', `Host bannerquit\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyCommand "${process.execPath}" "${banner}"\n`);
    await assert.rejects(openAlias('bannerquit', { sshConfigFile }, {}, { connectTimeout: 60 }), /^Error: SSH: connection closed before authentication finished/);
    await afterLeak();
  });

  it('stops a ProxyJump loop', async () => {
    const sshConfigFile = config('cfg-loop', `Host loopy\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump loopy\n`);
    await assert.rejects(openTunnel(via('key', 'key', { host: 'loopy', parseConfig: true }), target(), undefined, { sshConfigFile }), /ProxyJump loop/);
  });

  describe('ProxyJump / ProxyCommand edge cases', () => {
    const goodKey = path.join(dir, 'id_good');
    /** cond가 참이 될 때까지 기다린다(서버 쪽 연결 종료 · 프로세스 종료는 조금 늦게 보인다) */
    const settle = async (cond: () => boolean, what: string, ms = 3000) => {
      const end = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > end) assert.fail(`timed out waiting: ${what}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    /** 앞 테스트들이 닫은 연결이 서버 쪽에서도 다 끊긴 뒤의 수(0)를 기준으로 삼는다 */
    const idle = async () => {
      await settle(() => live.password === 0 && live.auth === 0, 'earlier tests to close their SSH connections');
      return { ...live };
    };
    const noConnections = (base: typeof live) => settle(() => live.password === base.password && live.auth === base.auth, 'server-side SSH connections to close');
    /** 시작하자마자 pid를 적고, 신호로 끝낼 때까지 살아 있는 프록시(표준 입력이 닫혀도 끝나지 않는다) */
    const stubborn = script(
      'stubborn.js',
      "require('fs').writeFileSync(process.argv[4], String(process.pid));\n" +
        "const s = require('net').connect(Number(process.argv[3]), process.argv[2]);\n" +
        "process.stdin.pipe(s).pipe(process.stdout); s.on('error', () => {}); process.stdin.on('error', () => {}); process.stdout.on('error', () => {});\n" +
        'setInterval(() => {}, 1000);\n',
    );
    const proxyCfg = (name: string, alias: string, command: string) => config(name, `Host ${alias}\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyCommand ${command}\n`);

    it('three hops: user@host:port, user@host:port, then an alias — and closing ends every SSH connection', async () => {
      const base = await idle();
      const sshConfigFile = config('cfg-jump3', `${bastion()}Host inner3\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump me@127.0.0.1:${sshPort},me@127.0.0.1:${sshPort},bastion\n`);
      let asks = 0;
      const t = await openAlias('inner3', { sshConfigFile, askKeyboard: async () => (asks++, ['sesame']) });
      assert.equal(await roundTrip(t.localPort, 'three hops'), 'three hops');
      assert.equal(asks, 3);
      assert.equal(live.password - base.password, 3);
      assert.equal(live.auth - base.auth, 1);
      await t.close();
      await noConnections(base);
    });

    it('a jump host whose own config entry has a ProxyJump is reached through that one first', async () => {
      const sshConfigFile = config(
        'cfg-jumpjump',
        `${bastion()}Host bastion2\n  HostName 127.0.0.1\n  Port ${sshPort}\n  User me\n  IdentityFile ${path.join(dir, 'no_such_key')}\n  ProxyJump bastion\n` +
          `Host inner4\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump bastion2\n`,
      );
      const asked: string[] = [];
      const t = await openAlias('inner4', { sshConfigFile, askKeyboard: async (title) => (asked.push(title), ['sesame']) });
      assert.equal(await roundTrip(t.localPort, 'jump of a jump'), 'jump of a jump');
      await t.close();
      assert.deepEqual(asked, ['SSH jump host bastion', 'SSH jump host bastion2']);
    });

    it('a jump host that refuses every method names the jump host, and leaves no connection open', async () => {
      const base = await idle();
      const sshConfigFile = config('cfg-jumpauth', `${bastion()}Host inner5\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump bastion\n`);
      const open = (askKeyboard?: () => Promise<string[]>) => openAlias('inner5', { sshConfigFile, askKeyboard });
      await assert.rejects(open(async () => ['wrong']), /^Error: SSH \(jump host bastion\): .*authentication methods failed/i);
      await assert.rejects(open(), /^Error: SSH \(jump host bastion\): /);
      // 물음을 취소해도(undefined) 같은 오류로 끝난다
      await assert.rejects(open(async () => undefined as unknown as string[]), /jump host bastion/);
      await noConnections(base);
    });

    it('Strict host key checking applies to the jump host too (unknown, not trusted, changed)', async () => {
      const sshConfigFile = config('cfg-jumpkey', `${bastion()}Host inner6\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump bastion\n`);
      const open = (strictHostKey: string, knownHostsFile: string, askHostKey?: (h: string) => Promise<boolean>) =>
        openAlias('inner6', { sshConfigFile, knownHostsFile, askHostKey, askKeyboard: async () => ['sesame'] }, { strictHostKey });
      const jump = `\\[127\\.0\\.0\\.1\\]:${sshPort}`;
      await assert.rejects(open('yes', known('kh-jump-yes')), new RegExp(`^Error: SSH \\(jump host bastion\\): ${jump} is not in`));
      const asked: string[] = [];
      await assert.rejects(open('ask', known('kh-jump-ask'), async (h) => (asked.push(h), false)), new RegExp(`^Error: SSH \\(jump host bastion\\): The host key of ${jump} was not trusted`));
      assert.deepEqual(asked, [`[127.0.0.1]:${sshPort}`]);
      const changed = known('kh-jump-changed');
      writeFileSync(changed, `[127.0.0.1]:${sshPort} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n`);
      await assert.rejects(open('acceptNew', changed), new RegExp(`^Error: SSH \\(jump host bastion\\): The host key of ${jump} changed`));
      // 마지막 서버까지 가지 않았으니 그 키는 known_hosts에 적히지 않았다
      assert.doesNotMatch(readFileSync(changed, 'utf8'), new RegExp(`\\[127\\.0\\.0\\.1\\]:${port} `));
    });

    it('a ProxyCommand that exits at once without stderr fails fast (no readyTimeout wait), without an uncaught error', { timeout: 10_000 }, async () => {
      const quit = script('quit.js', 'process.exit(0);\n');
      const sshConfigFile = proxyCfg('cfg-quit', 'quitcmd', `"${process.execPath}" "${quit}"`);
      const started = Date.now();
      await assert.rejects(openAlias('quitcmd', { sshConfigFile }, {}, { connectTimeout: 30 }), /^Error: SSH: /);
      assert.ok(Date.now() - started < 5000);
      await afterLeak();
    });

    it('a ProxyCommand that writes garbage and exits is rejected, without an uncaught error', { timeout: 10_000 }, async () => {
      const garbage = script('garbage-exit.js', "process.stdout.write('HTTP/1.1 400 Bad Request\\r\\n\\r\\n<html>nope</html>\\r\\n', () => process.exit(0));\n");
      const sshConfigFile = proxyCfg('cfg-garbage-exit', 'garbageexit', `"${process.execPath}" "${garbage}"`);
      await assert.rejects(openAlias('garbageexit', { sshConfigFile }, {}, { connectTimeout: 30 }), /^Error: SSH: /);
      await afterLeak();
    });

    it('a ProxyCommand that writes garbage and stays up is rejected at connectTimeout and its process is killed', { timeout: 15_000 }, async () => {
      const pidFile = path.join(dir, 'garbage.pid');
      const garbage = script(
        'garbage.js',
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write('HTTP/1.1 400 Bad Request\\r\\n\\r\\n<html>nope</html>\\r\\n'); setInterval(() => {}, 1000);\n`,
      );
      const sshConfigFile = proxyCfg('cfg-garbage', 'garbagecmd', `"${process.execPath}" "${garbage}"`);
      await assert.rejects(openAlias('garbagecmd', { sshConfigFile }, {}, { connectTimeout: 2 }), /^Error: SSH: /);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      await settle(() => !alive(pid), `ProxyCommand process ${pid} to end`);
      // handshake 시간 초과 뒤 ssh2가 한 번 더 내는 'error'가 잡히지 않는 예외가 되지 않는다
      await afterLeak();
    });

    it('closing the tunnel also ends children of a compound ProxyCommand (process group)', { skip: process.platform === 'win32' && 'POSIX process groups' }, async () => {
      const pidFile = path.join(dir, 'compound.pid');
      // 파이프는 exec로도 셸이 명령으로 바뀌지 않는다 — 셸만 끝내면 프록시가 고아로 남는다
      const sshConfigFile = proxyCfg('cfg-compound', 'compoundcmd', `"${process.execPath}" "${stubborn}" %h %p "${pidFile}" | cat`);
      const t = await openAlias('compoundcmd', { sshConfigFile });
      assert.equal(await roundTrip(t.localPort, 'compound'), 'compound');
      const pid = Number(readFileSync(pidFile, 'utf8'));
      await t.close();
      await settle(() => !alive(pid), `ProxyCommand child ${pid} to end`);
    });

    it('refuses host and user names with shell metacharacters in a ProxyCommand', async () => {
      const sshConfigFile = config('cfg-meta', `Host *\n  ProxyCommand nc %h %p\n`);
      for (const host of ['a$(touch x)', 'a;b', 'a b', '-oProxyCommand=x']) {
        await assert.rejects(openTunnel(via('key', 'key', { host, parseConfig: true, keyFile: goodKey }), target(), undefined, { sshConfigFile }), /not allowed in a ProxyCommand/, host);
      }
    });

    it('cancelling the jump host prompt stops at once (the password is not asked again)', async () => {
      const kbd = config('cfg-cancel', `Host kjump\n  HostName 127.0.0.1\n  Port ${port}\n  User kbd\n  IdentityFile ${path.join(dir, 'no_such_key')}\nHost inner7\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump kjump\n`);
      let asks = 0;
      await assert.rejects(openAlias('inner7', { sshConfigFile: kbd, askKeyboard: async () => (asks++, undefined as unknown as string[]) }), /jump host kjump/);
      assert.equal(asks, 1);
    });

    it('allows eight jump hosts (the loop limit is not hit by a real chain)', { timeout: 30_000 }, async () => {
      const hop = `me@127.0.0.1:${sshPort}`;
      const sshConfigFile = config('cfg-jump8', `Host inner8\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump ${Array(8).fill(hop).join(',')}\n`);
      const t = await openAlias('inner8', { sshConfigFile, askKeyboard: async () => ['sesame'] });
      assert.equal(await roundTrip(t.localPort, 'eight hops'), 'eight hops');
      await t.close();
      const nine = config('cfg-jump9', `Host inner9\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump ${Array(9).fill(hop).join(',')}\n`);
      await assert.rejects(openTunnel(via('key', 'key', { host: 'inner9', parseConfig: true, keyFile: goodKey }), target(), undefined, { sshConfigFile: nine }), /more than 8 jumps/);
    });

    it('closing the tunnel kills the ProxyCommand process and ends the server-side connection', async () => {
      const base = await idle();
      const pidFile = path.join(dir, 'stubborn.pid');
      const sshConfigFile = proxyCfg('cfg-stubborn', 'stubborncmd', `"${process.execPath}" "${stubborn}" %h %p "${pidFile}"`);
      const t = await openAlias('stubborncmd', { sshConfigFile });
      assert.equal(await roundTrip(t.localPort, 'stubborn'), 'stubborn');
      const pid = Number(readFileSync(pidFile, 'utf8'));
      assert.ok(alive(pid));
      await t.close();
      await settle(() => !alive(pid), `ProxyCommand process ${pid} to end`);
      await noConnections(base);
    });

    /** 접속은 받지만 아무것도 보내지 않는 TCP 서버(SSH handshake가 끝나지 않는다) */
    let silentPort = 0;
    before(async () => {
      const held = new Set<import('node:net').Socket>();
      const silent = createServer((s) => {
        held.add(s);
        s.on('close', () => held.delete(s));
        s.on('error', () => {});
      });
      await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
      silentPort = (silent.address() as AddressInfo).port;
      closers.push(() => {
        for (const s of held) s.destroy();
        silent.close();
      });
    });
    /** 표준 입출력을 host:port로 잇고, 그 연결이 끝나면 끝나는 프록시 */
    const relay = script('relay.js', "const s = require('net').connect(Number(process.argv[3]), process.argv[2]); process.stdin.pipe(s).pipe(process.stdout); s.on('error', () => process.exit(1)); s.on('close', () => process.exit(0));\n");
    /** pid를 적고 신호를 받을 때까지 사는 프로세스(백그라운드 자식으로 쓴다) */
    const sleeper = script('sleeper.js', "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n");
    const quitNow = script('quit-now.js', 'process.exit(0);\n');
    /** 파일이 생길 때까지 기다렸다가 pid를 읽는다 */
    const pidOf = async (file: string) => {
      await settle(() => {
        try {
          return readFileSync(file, 'utf8').length > 0;
        } catch {
          return false;
        }
      }, `${file} to be written`);
      return Number(readFileSync(file, 'utf8'));
    };

    it('a two-host ProxyJump loop and nine hops are refused before any connection or prompt', async () => {
      const base = await idle();
      let asks = 0;
      const askKeyboard = async () => (asks++, ['sesame']);
      const loop2 = config('cfg-loop2', `Host la\n  HostName 127.0.0.1\n  Port ${sshPort}\n  User me\n  ProxyJump lb\nHost lb\n  HostName 127.0.0.1\n  Port ${sshPort}\n  User me\n  ProxyJump la\nHost inner-l\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump la\n`);
      await assert.rejects(openAlias('inner-l', { sshConfigFile: loop2, askKeyboard }), /more than 8 jumps to reach (la|lb) .*ProxyJump loop/);
      // 아홉 단계 목록은 첫 연결 전에 거부한다
      const hop = `me@127.0.0.1:${sshPort}`;
      const nine = config('cfg-jump9b', `Host inner9b\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump ${Array(9).fill(hop).join(',')}\n`);
      await assert.rejects(openAlias('inner9b', { sshConfigFile: nine, askKeyboard }), /more than 8 jumps/);
      // 목록의 첫 점프 호스트가 자기 ProxyJump를 따르는 체인도 합쳐서 센다(목록 5개 + c1의 ProxyJump 4개 = 9)
      const chained = config(
        'cfg-chain9',
        `Host c1\n  HostName 127.0.0.1\n  Port ${sshPort}\n  User me\n  ProxyJump ${Array(4).fill(hop).join(',')}\nHost inner-c\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump c1,${Array(4).fill(hop).join(',')}\n`,
      );
      await assert.rejects(openAlias('inner-c', { sshConfigFile: chained, askKeyboard }), /more than 8 jumps/);
      assert.equal(asks, 0);
      assert.deepEqual({ ...live }, base);
    });

    it('ProxyCommand runs with exec: the proxy replaces the shell (its parent is this process)', { skip: process.platform === 'win32' && 'POSIX exec' }, async () => {
      const pidFile = path.join(dir, 'exec.pid');
      const who = script('who.js', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + process.ppid);\n` + "const s = require('net').connect(Number(process.argv[3]), process.argv[2]); process.stdin.pipe(s).pipe(process.stdout); s.on('close', () => process.exit(0));\n");
      const sshConfigFile = proxyCfg('cfg-exec', 'execcmd', `"${process.execPath}" "${who}" %h %p`);
      const t = await openAlias('execcmd', { sshConfigFile });
      assert.equal(await roundTrip(t.localPort, 'exec'), 'exec');
      const [pid, ppid] = readFileSync(pidFile, 'utf8').split(' ').map(Number);
      // 셸이 남아 있으면 부모는 /bin/sh가 된다
      assert.equal(ppid, process.pid);
      await t.close();
      await settle(() => !alive(pid), `ProxyCommand ${pid} to end`);
    });

    it('closing the tunnel ends a background (&) child of the ProxyCommand too', { skip: process.platform === 'win32' && 'POSIX process groups' }, async () => {
      const pidFile = path.join(dir, 'bg.pid');
      const sshConfigFile = proxyCfg('cfg-bg', 'bgcmd', `"${process.execPath}" "${sleeper}" "${pidFile}" & "${process.execPath}" "${relay}" %h %p`);
      const t = await openAlias('bgcmd', { sshConfigFile });
      assert.equal(await roundTrip(t.localPort, 'background'), 'background');
      const pid = await pidOf(pidFile);
      assert.ok(alive(pid));
      await t.close();
      await settle(() => !alive(pid), `background child ${pid} to end`);
    });

    it('closing the tunnel ends every stage of a three-stage pipeline', { skip: process.platform === 'win32' && 'POSIX process groups' }, async () => {
      const pidFile = path.join(dir, 'pipe3.pid');
      const sshConfigFile = proxyCfg('cfg-pipe3', 'pipe3cmd', `"${process.execPath}" "${stubborn}" %h %p "${pidFile}" | cat | cat`);
      const t = await openAlias('pipe3cmd', { sshConfigFile });
      assert.equal(await roundTrip(t.localPort, 'pipe3'), 'pipe3');
      const pid = await pidOf(pidFile);
      await t.close();
      await settle(() => !alive(pid), `first pipeline stage ${pid} to end`);
    });

    it('a ProxyCommand that exits at once leaves no background (&) child behind', { skip: process.platform === 'win32' && 'POSIX process groups' }, async () => {
      const pidFile = path.join(dir, 'bg-quit.pid');
      const sshConfigFile = proxyCfg('cfg-bg-quit', 'bgquit', `"${process.execPath}" "${sleeper}" "${pidFile}" & "${process.execPath}" "${quitNow}"`);
      await assert.rejects(openAlias('bgquit', { sshConfigFile }), /^Error: SSH: /);
      const pid = await pidOf(pidFile);
      try {
        await settle(() => !alive(pid), `background child ${pid} to end`);
      } finally {
        // 실패했을 때 남은 프로세스를 치운다
        if (alive(pid)) process.kill(pid, 'SIGTERM');
      }
    });

    it('cancelling the jump host password prompt (not keyboard-interactive) stops at once', async () => {
      const sshConfigFile = config('cfg-cancel-pw', `${bastion()}Host inner-pw\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump bastion\n`);
      for (const answer of [async () => undefined as unknown as string[], async () => Promise.reject(new Error('dialog closed'))]) {
        const asked: string[] = [];
        await assert.rejects(
          openAlias('inner-pw', { sshConfigFile, askKeyboard: async (title, prompts) => (asked.push(`${title} | ${prompts.map((p) => p.prompt).join()}`), answer()) }),
          /^Error: SSH \(jump host bastion\): /,
        );
        assert.deepEqual(asked, ['SSH jump host bastion | Password for me@bastion:']);
      }
    });

    it('a keyboard-interactive prompt that throws counts as cancel (the password is not asked)', async () => {
      const kbd = config('cfg-cancel-throw', `Host kjump2\n  HostName 127.0.0.1\n  Port ${port}\n  User kbd\n  IdentityFile ${path.join(dir, 'no_such_key')}\nHost inner-kt\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump kjump2\n`);
      const asked: string[] = [];
      await assert.rejects(
        openAlias('inner-kt', {
          sshConfigFile: kbd,
          askKeyboard: async (title, prompts) => {
            asked.push(`${title} | ${prompts.map((p) => p.prompt).join()}`);
            throw new Error('dialog closed');
          },
        }),
        /jump host kjump2/,
      );
      assert.equal(asked.length, 1);
      assert.match(asked[0], /^SSH jump host kjump2.* \| Password: $/);
    });

    it('a wrong keyboard-interactive answer is followed by the password step (only cancel stops)', async () => {
      const kbd = config('cfg-kbd-wrong', `Host kjump3\n  HostName 127.0.0.1\n  Port ${port}\n  User kbd\n  IdentityFile ${path.join(dir, 'no_such_key')}\nHost inner-kw\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump kjump3\n`);
      let asks = 0;
      await assert.rejects(openAlias('inner-kw', { sshConfigFile: kbd, askKeyboard: async () => (asks++, ['wrong']) }), /jump host kjump3/);
      // 서버가 password 방식을 알리지 않으므로 비밀번호는 묻지 않는다 — keyboard-interactive 한 번
      assert.equal(asks, 1);
    });

    it('a handshake timeout behind a jump host is a clean error, and the jump connection is closed', { timeout: 20_000 }, async () => {
      const base = await idle();
      const sshConfigFile = config('cfg-jump-silent', `${bastion()}Host silent-inner\n  HostName 127.0.0.1\n  Port ${silentPort}\n  ProxyJump bastion\n`);
      const started = Date.now();
      await assert.rejects(
        openAlias('silent-inner', { sshConfigFile, askKeyboard: async () => ['sesame'] }, { port: 22 }, { connectTimeout: 2 }),
        /^Error: SSH: .*(Timed out|handshake)/i,
      );
      assert.ok(Date.now() - started < 8000);
      await afterLeak();
      await noConnections(base);
    });

    it('a jump host that never answers the handshake names the jump host', { timeout: 20_000 }, async () => {
      const sshConfigFile = config('cfg-silent-jump', `Host silentjump\n  HostName 127.0.0.1\n  Port ${silentPort}\n  User me\nHost behind-silent\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump silentjump\n`);
      await assert.rejects(openAlias('behind-silent', { sshConfigFile }, {}, { connectTimeout: 2 }), /^Error: SSH \(jump host silentjump\): .*(Timed out|handshake)/i);
      await afterLeak();
    });

    it('a handshake timeout through a ProxyCommand to a silent server kills the proxy, without an uncaught error', { timeout: 20_000 }, async () => {
      const pidFile = path.join(dir, 'silent-proxy.pid');
      const sshConfigFile = config('cfg-silent-cmd', `Host silentcmd\n  HostName 127.0.0.1\n  Port ${silentPort}\n  ProxyCommand "${process.execPath}" "${stubborn}" %h %p "${pidFile}"\n`);
      await assert.rejects(openAlias('silentcmd', { sshConfigFile }, { port: 22 }, { connectTimeout: 2 }), /^Error: SSH: .*(Timed out|handshake)/i);
      const pid = await pidOf(pidFile);
      await settle(() => !alive(pid), `ProxyCommand ${pid} to end`);
      await afterLeak();
    });

    it('a failed login through a ProxyCommand also kills the process', async () => {
      const pidFile = path.join(dir, 'stubborn-fail.pid');
      const sshConfigFile = proxyCfg('cfg-stubborn-fail', 'stubbornfail', `"${process.execPath}" "${stubborn}" %h %p "${pidFile}"`);
      await assert.rejects(openAlias('stubbornfail', { sshConfigFile }, { keyFile: path.join(dir, 'id_bad') }), /^Error: SSH: /);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      await settle(() => !alive(pid), `ProxyCommand process ${pid} to end`);
    });

    /** SSH_AUTH_SOCK을 없는 소켓으로 바꿔 fn을 실행한다(에이전트에 붙지 못하는 'agent' 오류가 난다) */
    const deadAgent = async <T>(fn: () => Promise<T>): Promise<T> => {
      const saved = process.env.SSH_AUTH_SOCK;
      process.env.SSH_AUTH_SOCK = path.join(dir, 'dead_agent.sock');
      try {
        return await fn();
      } finally {
        if (saved === undefined) delete process.env.SSH_AUTH_SOCK;
        else process.env.SSH_AUTH_SOCK = saved;
      }
    };

    it('a dead agent does not end the attempt early: data-source agent auth fails with the methods error plus the agent reason', async () => {
      // agent → keyboard-interactive까지 시도한 뒤 끝나고, 에이전트의 이유가 뒤에 붙는다
      let asks = 0;
      await deadAgent(() =>
        assert.rejects(
          openTunnel(via('key', 'key', { auth: 'agent' }), target(), undefined, { askKeyboard: async () => (asks++, ['x']) }),
          /^Error: SSH: All configured authentication methods failed \(agent: .+\)$/,
        ),
      );
      // 서버가 keyboard-interactive 질문을 보내지 않았으니 묻지도 않았다
      assert.equal(asks, 0);
    });

    it('a jump host with a dead agent and a wrong password names the jump host and the agent reason', async () => {
      const sshConfigFile = config('cfg-deadagent-wrong', `${bastion()}Host inner-daw\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump bastion\n`);
      let asks = 0;
      await deadAgent(() =>
        assert.rejects(
          openTunnel(via('key', 'key', { host: 'inner-daw', parseConfig: true, keyFile: goodKey }), target(), undefined, { sshConfigFile, askKeyboard: async () => (asks++, ['wrong']) }),
          /^Error: SSH \(jump host bastion\): All configured authentication methods failed \(agent: .+\)$/,
        ),
      );
      // 에이전트 오류 뒤에도 비밀번호 단계까지 갔다
      assert.equal(asks, 1);
    });

    it('without an agent the methods error has no agent suffix', async () => {
      await assert.rejects(openAlias('127.0.0.1', {}, { port, parseConfig: false, keyFile: path.join(dir, 'id_bad') }), (e: Error) => {
        assert.match(e.message, /^SSH: All configured authentication methods failed$/);
        return true;
      });
    });

    it('a connection that closes before authentication also shows the ProxyCommand stderr', { timeout: 5000 }, async () => {
      const bye = script('banner-bye.js', "process.stderr.write('proxy: upstream went away\\n'); process.stdout.write('SSH-2.0-fake\\r\\n'); setTimeout(() => process.exit(0), 100);\n");
      const sshConfigFile = proxyCfg('cfg-banner-bye', 'bannerbye', `"${process.execPath}" "${bye}"`);
      // 여기서는 stderr가 붙는지만 본다(이유 문구는 아래 테스트)
      await assert.rejects(openAlias('bannerbye', { sshConfigFile }, {}, { connectTimeout: 60 }), /^Error: SSH: .+ \(ProxyCommand: proxy: upstream went away\)$/);
      await afterLeak();
    });

    it(
      'a ProxyCommand that exits after the banner always gives "connection closed before authentication finished" (not an AbortError)',
      { timeout: 30_000 },
      async () => {
        const bye = script('banner-race.js', "process.stderr.write('bye\\n'); process.stdout.write('SSH-2.0-fake\\r\\n'); setTimeout(() => process.exit(0), 100);\n");
        const sshConfigFile = proxyCfg('cfg-banner-race', 'bannerrace', `"${process.execPath}" "${bye}"`);
        const messages = new Set<string>();
        for (let i = 0; i < 20; i++) {
          await openAlias('bannerrace', { sshConfigFile }, {}, { connectTimeout: 60 }).then(
            (t) => (t.close(), assert.fail('should not connect')),
            (e: Error) => messages.add(e.message),
          );
        }
        assert.deepEqual([...messages], ['SSH: connection closed before authentication finished (ProxyCommand: bye)']);
        await afterLeak();
      },
    );

    it('a jump host that closes before authentication names the jump host', { timeout: 5000 }, async () => {
      const banner = script('banner-jump.js', "process.stdout.write('SSH-2.0-fake\\r\\n'); setTimeout(() => process.exit(0), 50);\n");
      const sshConfigFile = config('cfg-banner-jump', `Host bjump\n  HostName 127.0.0.1\n  Port ${sshPort}\n  ProxyCommand "${process.execPath}" "${banner}"\nHost behind-bjump\n  HostName 127.0.0.1\n  Port ${port}\n  ProxyJump bjump\n`);
      await assert.rejects(openAlias('behind-bjump', { sshConfigFile }, {}, { connectTimeout: 60 }), /^Error: SSH \(jump host bjump\): connection closed before authentication finished/);
      await afterLeak();
    });

    it(
      'a ProxyCommand that dies after the tunnel is open closes the tunnel and still ends its background (&) child (the shell has already exited)',
      { skip: process.platform === 'win32' && 'POSIX process groups' },
      async () => {
        const bgFile = path.join(dir, 'late-bg.pid');
        const mainFile = path.join(dir, 'late-main.pid');
        const sshConfigFile = proxyCfg('cfg-late', 'latecmd', `"${process.execPath}" "${sleeper}" "${bgFile}" & "${process.execPath}" "${stubborn}" %h %p "${mainFile}"`);
        const t = await openAlias('latecmd', { sshConfigFile });
        assert.equal(await roundTrip(t.localPort, 'late'), 'late');
        const bg = await pidOf(bgFile);
        const main = await pidOf(mainFile);
        try {
          // 프록시만 죽인다 — 셸이 끝나고, 연결이 끊긴 것을 받아 터널을 닫으며 그룹에 남은 자식까지 끝낸다
          process.kill(main, 'SIGKILL');
          await settle(() => !alive(bg), `background child ${bg} to end after the shell exited`);
          // 로컬 포트도 닫혔다
          const refused = () =>
            new Promise<boolean>((r) => {
              const s = createConnection(t.localPort, '127.0.0.1');
              s.on('connect', () => (s.destroy(), r(false)));
              s.on('error', () => r(true));
            });
          const end = Date.now() + 3000;
          while (!(await refused())) {
            if (Date.now() > end) assert.fail('local port still accepts connections');
            await new Promise((r) => setTimeout(r, 25));
          }
          // 이미 닫힌 터널을 다시 닫아도 끝난다
          await t.close();
        } finally {
          if (alive(bg)) process.kill(bg, 'SIGTERM');
        }
      },
    );
  });
});
