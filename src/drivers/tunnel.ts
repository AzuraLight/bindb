import { readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkKnownHost, fingerprint, hostPattern, keyType, knownHostsLine, resolveSshConfig } from './sshHosts';
import { createServer, type Server, type Socket } from 'node:net';
import { Client, type ConnectConfig } from 'ssh2';
import { resolvePath, resolveTarget } from './common';
import { DEFAULT_PORTS } from './ports';
import type { ConnectionConfig, ConnectOptions, Driver, Session } from './types';

/**
 * SSH/SSL 탭 · Use SSH tunnel. SSH 서버에 접속해 로컬 포트를 열고, 그 포트로 들어온 연결을
 * SSH 서버에서 본 DB 호스트:포트로 넘긴다(ssh -L 과 같다). DB 드라이버는 127.0.0.1:로컬 포트로 붙는다.
 */
export interface Tunnel {
  localPort: number;
  close(): Promise<void>;
}

export async function openTunnel(
  cfg: ConnectionConfig,
  target: { host: string; port: number },
  sshSecret: string | undefined,
  opts: Pick<ConnectOptions, 'askHostKey' | 'knownHostsFile' | 'sshConfigFile'> = {},
): Promise<Tunnel> {
  const ssh = { ...cfg.ssh! };
  // Parse config file ~/.ssh/config: 비어 있는 값만 채운다
  if (ssh.parseConfig) {
    const text = await readFile(opts.sshConfigFile ?? path.join(os.homedir(), '.ssh', 'config'), 'utf8').catch(() => '');
    const e = resolveSshConfig(text, ssh.host, os.homedir());
    if (e.user && !ssh.user) ssh.user = e.user;
    if (e.port && (!ssh.port || ssh.port === 22)) ssh.port = e.port;
    if (e.identityFile && ssh.auth === 'key' && !ssh.keyFile) ssh.keyFile = e.identityFile;
    if (e.hostName) ssh.host = e.hostName;
  }
  const sshPort = ssh.port ?? 22;
  const knownFile = opts.knownHostsFile ?? path.join(os.homedir(), '.ssh', 'known_hosts');
  const mode = ssh.strictHostKey ?? 'ask';
  let rejectReason: string | undefined;
  const conn = new Client();
  const config: ConnectConfig = {
    host: ssh.host,
    port: sshPort,
    username: ssh.user,
    readyTimeout: (cfg.connectTimeout ?? 10) * 1000,
    ...(ssh.keepAlive ? { keepaliveInterval: ssh.keepAlive * 1000 } : {}),
    // Strict host key checking: Yes = known_hosts에 있어야, Accept New = 처음 보면 추가, No = 검사 안 함, Ask = 처음 보면 묻는다.
    // 키가 바뀌었으면 No가 아닌 한 거부한다.
    hostVerifier: ((key: Buffer, verify: (ok: boolean) => void) => {
      if (mode === 'no') return verify(true);
      void (async () => {
        const known = await readFile(knownFile, 'utf8').catch(() => '');
        const status = checkKnownHost(known, ssh.host, sshPort, key);
        if (status === 'known') return true;
        if (status === 'changed') {
          rejectReason = `The host key of ${hostPattern(ssh.host, sshPort)} changed (${fingerprint(key)}). It does not match ${knownFile}.`;
          return false;
        }
        if (mode === 'yes') {
          rejectReason = `${hostPattern(ssh.host, sshPort)} is not in ${knownFile} (Strict host key checking: Yes).`;
          return false;
        }
        if (mode === 'ask' && !(await opts.askHostKey?.(hostPattern(ssh.host, sshPort), fingerprint(key)))) {
          rejectReason = `The host key of ${hostPattern(ssh.host, sshPort)} was not trusted.`;
          return false;
        }
        await mkdir(path.dirname(knownFile), { recursive: true });
        await appendFile(knownFile, knownHostsLine(ssh.host, sshPort, keyType(key), key));
        return true;
      })().then(verify, () => verify(false));
    }) as unknown as ConnectConfig['hostVerifier'],
  };
  if (ssh.auth === 'password') config.password = sshSecret;
  else if (ssh.auth === 'key') {
    config.privateKey = readFileSync(resolvePath(cfg, ssh.keyFile ?? ''));
    if (sshSecret) config.passphrase = sshSecret;
  } else {
    // OpenSSH agent
    config.agent = process.env.SSH_AUTH_SOCK;
    if (!config.agent) throw new Error('SSH agent is not available (SSH_AUTH_SOCK is not set).');
  }

  await new Promise<void>((resolve, reject) => {
    conn.once('ready', () => resolve());
    conn.once('error', (e) => reject(new Error(`SSH: ${rejectReason ?? e.message}`)));
    conn.connect(config);
  });
  // 연결된 뒤의 오류(끊김 등)도 받는다 — 받는 곳이 없으면 확장 호스트에서 잡히지 않는 예외가 된다
  let onLate = () => {};
  conn.on('error', () => onLate());

  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    conn.forwardOut('127.0.0.1', socket.localPort ?? 0, target.host, target.port, (err, stream) => {
      if (err) {
        socket.destroy(err);
        return;
      }
      socket.pipe(stream).pipe(socket);
      stream.on('error', () => socket.destroy());
      socket.on('error', () => stream.destroy());
    });
  });
  const localPort = await new Promise<number>((resolve, reject) => {
    server.once('error', (e) => reject(new Error(`SSH tunnel: cannot listen on local port ${ssh.localPort ?? '(dynamic)'}: ${e.message}`)));
    server.listen(ssh.localPort ?? 0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  }).catch((e) => {
    conn.end();
    throw e;
  });

  // 터널은 닫고, 그 위의 DB 세션은 연결이 끊긴 것으로 처리된다
  onLate = () => {
    for (const sock of sockets) sock.destroy();
    server.close();
  };

  return {
    localPort,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
        conn.end();
      }),
  };
}

/**
 * 드라이버로 접속한다. SSH 터널이 켜져 있으면 터널을 열고 그 로컬 포트로 붙이며,
 * 세션을 닫을 때 터널도 닫는다.
 */
export async function connectDriver(
  driver: Driver,
  cfg: ConnectionConfig,
  opts: ConnectOptions & { sshSecret?: string },
): Promise<Session> {
  if (!cfg.ssh?.enabled || cfg.driver === 'sqlite' || (cfg.driver === 'h2' && resolveTarget(cfg, opts).cfg.file)) {
    return driver.connect(cfg, opts);
  }
  // URL only면 URL 안의 호스트 · 포트를 터널 너머 목적지로 쓴다
  const { cfg: t, password } = resolveTarget(cfg, opts);
  const tunnel = await openTunnel(cfg, { host: t.host ?? 'localhost', port: t.port ?? DEFAULT_PORTS[cfg.driver] ?? 0 }, opts.sshSecret, opts);
  try {
    const through: ConnectionConfig = { ...t, connectionType: 'default', url: undefined, host: '127.0.0.1', port: tunnel.localPort };
    const realTarget = { host: t.host ?? 'localhost', port: t.port ?? DEFAULT_PORTS[cfg.driver] ?? 0 };
    const session = await driver.connect(through, { ...opts, password: password ?? opts.password, realTarget });
    return {
      execute: (sql, params) => session.execute(sql, params),
      onLost: (l) => session.onLost?.(l),
      cancel: () => session.cancel(),
      close: async () => {
        try {
          await session.close();
        } finally {
          await tunnel.close();
        }
      },
    };
  } catch (e) {
    await tunnel.close();
    throw e;
  }
}
