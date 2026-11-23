import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Duplex } from 'node:stream';
import {
  checkKnownHost,
  expandProxyCommand,
  fingerprint,
  hostPattern,
  keyType,
  knownHostsLine,
  parseJumpHost,
  resolveSshConfig,
  type SshConfigEntry,
} from './sshHosts';
import { createServer, type Server, type Socket } from 'node:net';
import { Client, utils, type ConnectConfig } from 'ssh2';
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

/** IdentityFile이 없을 때 OpenSSH가 시도하는 기본 키(ssh(1) -i) */
const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

/** 시도할 키 파일들: 설정의 IdentityFile, 없으면 ~/.ssh의 기본 키 */
function keyCandidates(identityFiles: string[]): string[] {
  return identityFiles.length ? identityFiles : DEFAULT_KEYS.map((k) => path.join(os.homedir(), '.ssh', k));
}

/** SSH 에이전트 소켓: SSH_AUTH_SOCK, Windows에서는 OpenSSH 에이전트 파이프. 없으면 undefined */
function agentSocket(): string | undefined {
  return process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
}

/**
 * keyboard-interactive 질문을 사용자에게 묻는다. 물을 수 없거나 취소하면 빈 답으로 끝낸다
 * @param onCancel 사용자가 취소했을 때(답이 없거나 묻기가 실패했을 때) 끝내기 전에 부른다
 */
function askKeyboardAnswers(
  askKeyboard: ConnectOptions['askKeyboard'],
  title: string,
  prompts: { prompt: string; echo: boolean }[],
  finish: (answers: string[]) => void,
  onCancel?: () => void,
): void {
  if (!askKeyboard) return finish([]);
  askKeyboard(title, prompts).then(
    (a) => {
      if (a === undefined) onCancel?.();
      finish(a ?? []);
    },
    () => {
      onCancel?.();
      finish([]);
    },
  );
}

/** Include 패턴(~/.ssh 기준 상대 경로, 파일 이름의 * · ? 글롭) → 파일 내용들(이름순) */
function includeFiles(base: string, pattern: string): string[] {
  const full = path.isAbsolute(pattern) ? pattern : path.join(base, pattern);
  const dir = path.dirname(full);
  const name = path.basename(full);
  if (!/[*?]/.test(name)) return existsSync(full) ? [readFileSync(full, 'utf8')] : [];
  const re = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  try {
    return readdirSync(dir)
      .filter((f) => re.test(f))
      .sort()
      .map((f) => readFileSync(path.join(dir, f), 'utf8'));
  } catch {
    return [];
  }
}

/** 터널이 쓰는 접속 옵션(호스트 키 · keyboard-interactive 질문, known_hosts · ssh_config 경로) */
type TunnelOptions = Pick<ConnectOptions, 'askHostKey' | 'askKeyboard' | 'knownHostsFile' | 'sshConfigFile'>;

/**
 * SSH 터널을 연다. ~/.ssh/config의 ProxyJump · ProxyCommand가 있으면 그 길을 거쳐 마지막 SSH 서버에 접속한다.
 * @param target SSH 서버에서 본 DB 호스트 · 포트
 * @param sshSecret 데이터 소스의 SSH 비밀번호 또는 키 암호 문구
 */
export async function openTunnel(
  cfg: ConnectionConfig,
  target: { host: string; port: number },
  sshSecret: string | undefined,
  opts: TunnelOptions = {},
): Promise<Tunnel> {
  const ssh = { ...cfg.ssh! };
  let configKeys: string[] = [];
  /** 마지막 SSH 서버까지 가는 길(~/.ssh/config의 ProxyJump · ProxyCommand) */
  let route: Route = { alias: ssh.host };
  let lookup: ((alias: string) => SshConfigEntry) | undefined;
  // Parse config file ~/.ssh/config: 비어 있는 값만 채운다
  if (ssh.parseConfig) {
    const configFile = opts.sshConfigFile ?? path.join(os.homedir(), '.ssh', 'config');
    const text = await readFile(configFile, 'utf8').catch(() => '');
    const ropts = { home: os.homedir(), localUser: os.userInfo().username, include: (p: string) => includeFiles(path.dirname(configFile), p) };
    lookup = (alias) => resolveSshConfig(text, alias, ropts);
    const e = lookup(ssh.host);
    route = { alias: ssh.host, proxyJump: e.proxyJump, proxyCommand: e.proxyCommand };
    if (e.user && !ssh.user) ssh.user = e.user;
    if (e.port && (!ssh.port || ssh.port === 22)) ssh.port = e.port;
    configKeys = e.identityFiles;
    if (e.hostName) ssh.host = e.hostName;
  }
  const sshPort = ssh.port ?? 22;
  const prompts = { active: 0, endedAt: 0 };
  // 사용자에게 묻는 동안은 접속 시간 초과를 세지 않는다(sshConnect의 타이머가 prompts를 본다)
  const timed = <A extends unknown[], R>(ask: ((...a: A) => Promise<R>) | undefined) =>
    ask &&
    ((...a: A) => {
      prompts.active++;
      return ask(...a).finally(() => {
        prompts.active--;
        prompts.endedAt = Date.now();
      });
    });
  opts = { ...opts, askKeyboard: timed(opts.askKeyboard), askHostKey: timed(opts.askHostKey) };
  const ctx: HopContext = { cfg, opts, lookup, clients: [], procs: [], prompts, onLate: () => {} };
  let conn: Client;
  try {
    // 점프 호스트 · 프록시 명령을 거쳐 마지막 SSH 서버까지의 통로(없으면 바로 TCP)
    const sock = await reach(ctx, route, ssh.host, sshPort, ssh.user, 0);
    conn = await sshConnect(ctx, 'SSH', {
      host: ssh.host,
      port: sshPort,
      username: ssh.user,
      sock,
      authHandler: authAttempts(cfg, ssh, configKeys, sshSecret, opts.askKeyboard),
    });
  } catch (e) {
    closeHops(ctx);
    throw e;
  }

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
    closeHops(ctx);
    throw e;
  });

  // 어느 단계든 끊기면 터널을 닫고, 그 위의 DB 세션은 연결이 끊긴 것으로 처리된다
  ctx.onLate = () => {
    for (const sock of sockets) sock.destroy();
    server.close();
    closeHops(ctx);
  };

  return {
    localPort,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
        closeHops(ctx);
      }),
  };
}

/** SSH 서버까지 가는 길: 설정에 쓴 별칭과 그 별칭의 ProxyJump · ProxyCommand */
interface Route {
  alias: string;
  proxyJump?: string;
  proxyCommand?: string;
}

/** 한 터널이 연 SSH 연결들(점프 호스트 → 마지막 서버 순)과 프록시 명령 프로세스들 */
interface HopContext {
  cfg: ConnectionConfig;
  opts: TunnelOptions;
  /** ~/.ssh/config에서 별칭의 값(Parse config file을 켰을 때만) */
  lookup?: (alias: string) => SshConfigEntry;
  clients: Client[];
  procs: ChildProcess[];
  /** 사용자에게 묻고 있는 질문 수와 마지막 질문이 끝난 시각(접속 시간 초과에서 뺀다) */
  prompts: { active: number; endedAt: number };
  /** 바로 앞 프록시 명령의 stderr 마지막 줄(접속 실패 이유에 붙인다) */
  proxyError?: () => string;
  /** 터널을 연 뒤 어느 연결이 끊겼을 때 */
  onLate: () => void;
}

/** ssh2 authHandler: 남은 인증 방법을 받아 다음 시도를 next로 넘긴다(false면 포기) */
type AuthHandler = (methodsLeft: string[] | null, partial: boolean | null, next: (attempt: object | false) => void) => void;

/** 무한 ProxyJump(설정의 순환)를 막는 한도: 점프 호스트는 이만큼까지 */
const MAX_HOPS = 8;

/**
 * host:port의 SSH 서버까지 통로를 연다(ssh_config(5) ProxyJump · ProxyCommand).
 *  - ProxyJump a,b: b까지 a를 거쳐 가고(b는 a에서 forwardOut), 그 b에서 host:port로 forwardOut한다. 마지막 점프 호스트(b)에
 *    남은 목록(a)을 ProxyJump로 넘기고, 첫 점프 호스트(a)는 자기 설정(HostName · User · Port · IdentityFile · ProxyJump …)을 따른다 — OpenSSH -J와 같다
 *  - ProxyCommand: 셸 명령을 실행해 표준 입출력을 SSH 통로로 쓴다(%h %p %r %n %% 토큰)
 * @param depth 지금까지 거친 단계 수(MAX_HOPS를 넘으면 순환으로 본다)
 * @returns SSH 통로. ProxyJump · ProxyCommand가 둘 다 없으면 undefined(ssh2가 TCP로 바로 붙는다)
 */
async function reach(ctx: HopContext, route: Route, host: string, port: number, user: string, depth: number): Promise<Duplex | undefined> {
  // depth = 이 서버 앞에 거친 점프 호스트 수. 첫 점프 호스트 자신의 경로를 볼 때 depth가 점프 호스트 수와 같다
  if (depth > MAX_HOPS) throw new Error(`SSH: more than ${MAX_HOPS} jumps to reach ${route.alias} — is there a ProxyJump loop in ~/.ssh/config?`);
  if (route.proxyJump) {
    const jumps = route.proxyJump.split(',').map((s) => s.trim()).filter(Boolean);
    const last = parseJumpHost(jumps.pop()!);
    const e: SshConfigEntry = ctx.lookup?.(last.host) ?? { identityFiles: [] };
    const jumpHost = e.hostName ?? last.host;
    const jumpPort = last.port ?? e.port ?? 22;
    const jumpUser = last.user ?? e.user ?? os.userInfo().username;
    const next: Route = jumps.length ? { alias: last.host, proxyJump: jumps.join(',') } : { alias: last.host, proxyJump: e.proxyJump, proxyCommand: e.proxyCommand };
    const sock = await reach(ctx, next, jumpHost, jumpPort, jumpUser, depth + 1);
    const label = `SSH (jump host ${last.host})`;
    const jump = await sshConnect(ctx, label, {
      host: jumpHost,
      port: jumpPort,
      username: jumpUser,
      sock,
      authHandler: jumpAuth(e.identityFiles, jumpUser, last.host, ctx.opts.askKeyboard),
    });
    return new Promise<Duplex>((resolve, reject) =>
      jump.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? reject(new Error(`${label}: cannot reach ${host}:${port}: ${err.message}`)) : resolve(stream))),
    );
  }
  if (route.proxyCommand) return spawnProxy(ctx, expandProxyCommand(route.proxyCommand, { host, port, user, alias: route.alias }));
  return undefined;
}

/**
 * ProxyCommand를 셸로 실행하고 그 표준 입출력을 SSH 통로로 돌려준다.
 * OpenSSH처럼 `exec 명령`으로 실행해 셸이 명령으로 바뀌게 하고(POSIX), 따로 프로세스 그룹을 만들어
 * 닫을 때 파이프 · 복합 명령의 자식까지 함께 끝낸다.
 */
function spawnProxy(ctx: HopContext, command: string): Duplex {
  const posix = process.platform !== 'win32';
  const child = posix
    ? spawn('/bin/sh', ['-c', `exec ${command}`], { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    : spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  ctx.procs.push(child);
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr = (stderr + String(d)).slice(-1000)));
  ctx.proxyError = () => stderr.trim().split('\n').pop()?.trim() ?? '';
  const sock = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
  // 통로를 닫으면 Duplex.from이 자식의 stdin · stdout을 AbortError로 끝낸다 — 받는 곳이 없으면 잡히지 않는 예외가 된다
  for (const s of [child.stdin!, child.stdout!, child.stderr!]) s.on('error', () => {});
  child.on('error', (e) => sock.destroy(e));
  child.on('exit', () => sock.destroy());
  sock.on('error', () => {});
  return sock;
}

/** 프록시 명령과 그 자식들을 끝낸다(POSIX는 프로세스 그룹, Windows는 프로세스 트리) */
function killProxy(child: ChildProcess): void {
  if (child.pid === undefined) return;
  const exited = child.exitCode !== null || child.signalCode !== null;
  try {
    if (process.platform === 'win32') {
      if (!exited) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
    } else {
      // 셸이 먼저 끝나도 그룹에 남은 자식(& 등)이 있을 수 있다 — 그룹에 아무도 없으면 ESRCH
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    if (!exited) child.kill();
  }
}

/**
 * SSH 서버 하나에 접속한다(호스트 키 검사 포함). 연결은 ctx에 모아 터널을 닫을 때 함께 닫는다.
 * @param label 오류 메시지 앞에 붙는 이름(SSH · SSH (jump host …))
 * @param c 접속할 서버와 인증. sock이 있으면 그 통로(점프 호스트 · 프록시 명령)로 붙는다
 */
async function sshConnect(
  ctx: HopContext,
  label: string,
  c: { host: string; port: number; username: string; sock?: Duplex; authHandler: AuthHandler },
): Promise<Client> {
  const ssh = ctx.cfg.ssh!;
  let reason: string | undefined;
  const proxyError = ctx.proxyError;
  ctx.proxyError = undefined;
  const conn = new Client();
  ctx.clients.push(conn);
  const config: ConnectConfig = {
    host: c.host,
    port: c.port,
    username: c.username,
    ...(c.sock ? { sock: c.sock } : {}),
    // ssh2의 시간 초과는 사용자에게 묻는 시간까지 센다 — 끄고 아래에서 직접 잰다
    readyTimeout: 0,
    ...(ssh.keepAlive ? { keepaliveInterval: ssh.keepAlive * 1000 } : {}),
    hostVerifier: hostVerifier(ctx, c.host, c.port, (r) => (reason = r)) as unknown as ConnectConfig['hostVerifier'],
    authHandler: c.authHandler as ConnectConfig['authHandler'],
  };
  // 'error' 리스너는 하나를 끝까지 둔다: ssh2는 handshake 시간 초과 뒤 "Connection lost before handshake"를 한 번 더 내고,
  // 연결된 뒤의 끊김도 'error'로 알린다 — 받는 곳이 없으면 확장 호스트에서 잡히지 않는 예외가 된다
  let ready = false;
  // ssh2는 에이전트에 붙지 못하면 'error'를 내고도 다음 인증으로 넘어간다 — 실패로 보지 않고 이유만 남긴다
  let agentError: string | undefined;
  const closedEarly = 'connection closed before authentication finished';
  const limit = (ctx.cfg.connectTimeout ?? 10) * 1000;
  let timer: NodeJS.Timeout | undefined;
  await new Promise<void>((resolve, reject) => {
    const fail = (message: string) => {
      clearTimeout(timer);
      const proxy = reason ? '' : proxyError?.();
      reject(new Error(`${label}: ${reason ?? message}${proxy ? ` (ProxyCommand: ${proxy})` : ''}`));
    };
    // 접속 시간 초과: 질문 중이면 기다리고, 질문이 끝난 뒤부터 다시 connectTimeout만큼 준다
    const check = () => {
      const left = ctx.prompts.active > 0 ? limit : ctx.prompts.endedAt + limit - Date.now();
      if (left > 0) {
        timer = setTimeout(check, left);
        return;
      }
      fail('Timed out while waiting for handshake');
      conn.end();
    };
    if (limit > 0) timer = setTimeout(check, limit);
    conn.on('error', (e: Error & { level?: string; code?: string }) => {
      if (ready) return ctx.onLate();
      if (e.level === 'agent') {
        agentError = e.message;
        return;
      }
      // 프록시 명령이 끝나면 통로(Duplex.from)가 AbortError로 끝날 수 있다 — 'close'와 같은 뜻이다
      if (e.code === 'ABORT_ERR' || e.name === 'AbortError') return fail(closedEarly);
      fail(agentError && e.level === 'client-authentication' ? `${e.message} (agent: ${agentError})` : e.message);
    });
    // 배너를 받은 뒤 오류 없이 닫히면 ssh2는 'close'만 낸다
    conn.on('close', () => (ready ? ctx.onLate() : fail(closedEarly)));
    conn.once('ready', () => {
      ready = true;
      clearTimeout(timer);
      resolve();
    });
    conn.connect(config);
  });
  return conn;
}

/**
 * Strict host key checking: Yes = known_hosts에 있어야, Accept New = 처음 보면 추가, No = 검사 안 함, Ask = 처음 보면 묻는다.
 * 키가 바뀌었으면 No가 아닌 한 거부한다. 점프 호스트도 같은 규칙으로 검사한다.
 * @param reject 거부한 이유를 받는다(접속 오류 메시지에 쓴다)
 * @returns ssh2 hostVerifier(비동기로 verify를 부른다)
 */
function hostVerifier(ctx: HopContext, host: string, port: number, reject: (reason: string) => void) {
  const { opts } = ctx;
  const mode = ctx.cfg.ssh!.strictHostKey ?? 'ask';
  const knownFile = opts.knownHostsFile ?? path.join(os.homedir(), '.ssh', 'known_hosts');
  // 시스템 known_hosts도 본다(새 키는 사용자 파일에만 적는다)
  const knownFiles = opts.knownHostsFile ? [knownFile] : [knownFile, '/etc/ssh/ssh_known_hosts'];
  return (key: Buffer, verify: (ok: boolean) => void) => {
    if (mode === 'no') return verify(true);
    void (async () => {
      const known = (await Promise.all(knownFiles.map((f) => readFile(f, 'utf8').catch(() => '')))).join('\n');
      const status = checkKnownHost(known, host, port, key);
      if (status === 'known') return true;
      if (status === 'revoked') {
        reject(`The host key of ${hostPattern(host, port)} (${fingerprint(key)}) is marked @revoked in known_hosts.`);
        return false;
      }
      if (status === 'changed') {
        reject(`The host key of ${hostPattern(host, port)} changed (${fingerprint(key)}). It does not match ${knownFile}.`);
        return false;
      }
      if (mode === 'yes') {
        reject(`${hostPattern(host, port)} is not in ${knownFile} (Strict host key checking: Yes).`);
        return false;
      }
      if (mode === 'ask' && !(await opts.askHostKey?.(hostPattern(host, port), fingerprint(key)))) {
        reject(`The host key of ${hostPattern(host, port)} was not trusted.`);
        return false;
      }
      await mkdir(path.dirname(knownFile), { recursive: true });
      await appendFile(knownFile, knownHostsLine(host, port, keyType(key), key));
      return true;
    })().then(verify, () => verify(false));
  };
}

/** 터널의 SSH 연결을 마지막 서버부터 닫고 프록시 명령 프로세스를 끝낸다 */
function closeHops(ctx: HopContext): void {
  ctx.onLate = () => {};
  for (const c of ctx.clients.splice(0).reverse()) c.end();
  for (const p of ctx.procs.splice(0)) killProxy(p);
}

/**
 * 점프 호스트 인증(OpenSSH처럼, 데이터 소스의 비밀번호 · 키는 쓰지 않는다):
 * 그 호스트 설정의 IdentityFile(없으면 기본 키) → 에이전트 → keyboard-interactive → 비밀번호(물어본다).
 * 암호 문구가 걸린 키는 건너뛴다(에이전트에 올려 둔 키로 시도한다). 물어본 값은 저장하지 않는다.
 */
function jumpAuth(identityFiles: string[], username: string, alias: string, askKeyboard: ConnectOptions['askKeyboard']): AuthHandler {
  type Step = object | 'password';
  const steps: Step[] = [];
  for (const file of keyCandidates(identityFiles)) {
    let key: Buffer;
    try {
      key = readFileSync(file);
    } catch {
      continue;
    }
    if (utils.parseKey(key) instanceof Error) continue;
    steps.push({ type: 'publickey', username, key });
  }
  const agent = agentSocket();
  if (agent) steps.push({ type: 'agent', username, agent });
  const title = `SSH jump host ${alias}`;
  // 사용자가 질문을 취소하면 그 점프 호스트 인증을 그만둔다(비밀번호를 또 묻지 않는다)
  let cancelled = false;
  steps.push({
    type: 'keyboard-interactive',
    username,
    prompt: (name: string, instructions: string, _lang: string, prompts: { prompt: string; echo: boolean }[], finish: (answers: string[]) => void) =>
      askKeyboardAnswers(askKeyboard, [title, name, instructions].filter((s) => s?.trim()).join(' — '), prompts, finish, () => (cancelled = true)),
  });
  steps.push('password');
  const handler: AuthHandler = (methodsLeft, partial, next) => {
    if (cancelled) return next(false);
    const step = steps.shift();
    if (step === undefined) return next(false);
    if (step !== 'password') return next(step);
    if (!askKeyboard || (methodsLeft && !methodsLeft.includes('password'))) return handler(methodsLeft, partial, next);
    askKeyboard(title, [{ prompt: `Password for ${username}@${alias}:`, echo: false }]).then(
      (a) => (a?.[0] !== undefined ? next({ type: 'password', username, password: a[0] }) : next(false)),
      () => next(false),
    );
  };
  return handler;
}

/**
 * 인증 시도 순서(ssh2 authHandler). 앞의 것이 실패하면 다음 것을 시도한다.
 *  - password: 비밀번호 → keyboard-interactive
 *  - key: 지정한 키 파일 하나. 없으면 ~/.ssh/config의 IdentityFile들, 그것도 없으면 기본 키(id_ed25519 · id_ecdsa · id_rsa) →
 *    keyboard-interactive(공개키 뒤에 2FA를 요구하는 서버)
 *  - agent: SSH_AUTH_SOCK, Windows에서는 OpenSSH 에이전트 파이프 → keyboard-interactive
 * keyboard-interactive: 비밀번호를 묻는 것이면 저장된 비밀번호로 답하고, 그 밖의 질문(OTP 등)은 사용자에게 묻는다.
 */
function authAttempts(
  cfg: ConnectionConfig,
  ssh: NonNullable<ConnectionConfig['ssh']>,
  configKeys: string[],
  secret: string | undefined,
  askKeyboard: ConnectOptions['askKeyboard'],
): AuthHandler {
  const username = ssh.user;
  const attempts: object[] = [];
  if (ssh.auth === 'password') {
    attempts.push({ type: 'password', username, password: secret ?? '' });
  } else if (ssh.auth === 'key') {
    let files: string[];
    if (ssh.keyFile) {
      const file = resolvePath(cfg, ssh.keyFile);
      if (!existsSync(file)) throw new Error(`SSH key file not found: ${file}`);
      files = [file];
    } else {
      const candidates = keyCandidates(configKeys);
      files = candidates.filter((f) => existsSync(f));
      if (!files.length) throw new Error(`No SSH key file: set one, or add IdentityFile to ~/.ssh/config (looked for ${candidates.join(', ')}).`);
    }
    for (const file of files) attempts.push({ type: 'publickey', username, key: readFileSync(file), ...(secret ? { passphrase: secret } : {}) });
  } else {
    const agent = agentSocket();
    if (!agent) throw new Error('SSH agent is not available (SSH_AUTH_SOCK is not set).');
    attempts.push({ type: 'agent', username, agent });
  }
  attempts.push({
    type: 'keyboard-interactive',
    username,
    prompt: (name: string, instructions: string, _lang: string, prompts: { prompt: string; echo: boolean }[], finish: (answers: string[]) => void) => {
      if (ssh.auth === 'password' && secret !== undefined && prompts.every((p) => /password/i.test(p.prompt))) return finish(prompts.map(() => secret));
      askKeyboardAnswers(askKeyboard, [name, instructions].filter((s) => s?.trim()).join(' — ') || `SSH ${ssh.host}`, prompts, finish);
    },
  });
  return (_methodsLeft, _partial, next) => next(attempts.shift() ?? false);
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
      // JDBC 세션(H2 Remote)의 구조 정보 읽기를 그대로 넘긴다
      ...(session.jdbcMetadata ? { jdbcMetadata: (keys: boolean) => session.jdbcMetadata!(keys), serverVersion: session.serverVersion } : {}),
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
