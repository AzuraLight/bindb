import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { BufferedCursor, emptyCursor } from '../cursor';
import type { ColumnMeta, QueryCursor, Session } from '../types';

/*
 * JDBC 연동 모듈(Node 쪽). JDBC 드라이버는 Java라서, 필요할 때만 띄우는 JVM(java/bridge의 bindb.JdbcBridge)에서
 * 실행하고 표준 입출력의 JSON 줄로 주고받는다 — DataGrip의 RemoteJdbcServer와 같은 구조.
 *  - JVM은 (java · VM 옵션 · 환경 변수 · 작업 폴더)가 같으면 하나를 함께 쓴다. 드라이버 jar는 연결마다 정한다
 *  - 첫 연결을 열 때 띄우고, 마지막 연결이 닫히면 끈다
 *  - JVM이 죽으면 그 위의 세션은 "연결이 끊김"이 된다(확장 호스트는 영향 없음)
 *  - 네트워크 포트를 열지 않는다
 */

export interface JvmOptions {
  /** java 실행 파일. 없으면 JAVA_HOME/bin/java, 그다음 PATH의 java */
  java?: string;
  /** VM options(java 인자 앞에 붙는다) */
  vmArgs?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface JdbcTarget {
  /** 드라이버 jar 파일들 */
  jars: string[];
  /** 드라이버 클래스(org.h2.Driver 등) */
  driver: string;
  url: string;
  props?: Record<string, string | undefined>;
  readOnly?: boolean;
}

/** 런타임 jar: 빌드하면 out/ 옆에, 번들 없이 돌 때(테스트)는 저장소의 java/ */
export function bridgeJar(): string {
  const bundled = path.join(__dirname, 'bindb-jdbc.jar');
  if (existsSync(bundled)) return bundled;
  for (const up of ['..', '../..', '../../..']) {
    const repo = path.join(__dirname, up, 'java', 'bindb-jdbc.jar');
    if (existsSync(repo)) return repo;
  }
  return bundled;
}

export function javaExecutable(java?: string): string {
  if (java) return java;
  const home = process.env.JAVA_HOME;
  const fromHome = home && path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  return fromHome && existsSync(fromHome) ? fromHome : 'java';
}

type Reply = Record<string, unknown> & { ok: boolean; error?: string };

/** 실행 중인 JVM 하나 */
class Bridge {
  private readonly proc: ChildProcess;
  private readonly pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
  private seq = 0;
  private dead?: Error;
  private stderr = '';
  readonly ready: Promise<void>;
  /** 이 JVM 위에서 열린 연결 수 */
  refs = 0;
  private readonly deathListeners = new Set<(e: Error) => void>();

  constructor(opts: JvmOptions) {
    const java = javaExecutable(opts.java);
    this.proc = spawn(java, [...(opts.vmArgs ?? []), '-cp', bridgeJar(), 'bindb.JdbcBridge'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd || undefined,
    });
    let markReady: () => void = () => {};
    let failReady: (e: Error) => void = () => {};
    this.ready = new Promise((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    this.ready.catch(() => {});
    createInterface({ input: this.proc.stdout! }).on('line', (line) => {
      let msg: Reply & { id?: number; ready?: boolean };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.ready) return markReady();
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id!);
      p.resolve(msg);
    });
    // 드라이버 로그 · JVM 오류. 끝 부분만 오류 메시지에 쓴다
    this.proc.stderr!.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-4000)));
    const die = (e: Error) => {
      if (this.dead) return;
      this.dead = e;
      failReady(e);
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
      for (const l of this.deathListeners) l(e);
    };
    this.proc.once('error', (e) =>
      die(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? `Java was not found (${java}). Install a Java runtime (11 or later) or set JAVA_HOME.` : `Could not run Java: ${e.message}`)),
    );
    this.proc.once('exit', (code, signal) => die(new Error(`The JDBC process stopped (${signal ?? `exit code ${code}`}).${this.stderr.trim() ? `\n${this.stderr.trim()}` : ''}`)));
  }

  get alive(): boolean {
    return !this.dead;
  }

  onDeath(listener: (e: Error) => void): () => void {
    this.deathListeners.add(listener);
    return () => this.deathListeners.delete(listener);
  }

  /** 요청 하나. 실패 응답은 예외로 */
  async request(op: string, body: Record<string, unknown> = {}): Promise<Reply> {
    await this.ready;
    if (this.dead) throw this.dead;
    const id = ++this.seq;
    const reply = await new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(`${JSON.stringify({ id, op, ...body })}\n`);
    });
    if (!reply.ok) throw new Error(String(reply.error ?? 'JDBC error'));
    return reply;
  }

  stop(): void {
    // 표준 입력을 닫으면 런타임이 연결을 닫고 스스로 끝난다(H2 파일 잠금 해제). 늦으면 끝낸다
    this.proc.stdin!.end();
    const timer = setTimeout(() => this.proc.kill(), 5000);
    timer.unref?.();
  }

  kill(): void {
    this.proc.kill();
  }
}

const bridges = new Map<string, Bridge>();

function bridgeFor(opts: JvmOptions): Bridge {
  const key = JSON.stringify([javaExecutable(opts.java), opts.vmArgs ?? [], opts.env ?? {}, opts.cwd ?? '']);
  let b = bridges.get(key);
  if (!b || !b.alive) {
    const created = new Bridge(opts);
    created.onDeath(() => bridges.get(key) === created && bridges.delete(key));
    bridges.set(key, created);
    b = created;
  }
  return b;
}

/** 확장을 끌 때(deactivate): JVM을 모두 끝낸다 */
export function stopAllBridges(): void {
  for (const b of bridges.values()) b.kill();
  bridges.clear();
}

/** 실행 중인 JVM 수(테스트 · 진단) */
export function runningBridges(): number {
  return [...bridges.values()].filter((b) => b.alive).length;
}

/** JDBC 연결을 연다(필요하면 JVM을 띄운다) */
export async function openJdbc(jvm: JvmOptions, target: JdbcTarget): Promise<JdbcSession> {
  const bridge = bridgeFor(jvm);
  bridge.refs++;
  try {
    const r = await bridge.request('open', { ...target });
    return new JdbcSession(bridge, String(r.conn), String(r.product ?? ''), String(r.version ?? ''));
  } catch (e) {
    release(bridge);
    throw e;
  }
}

function release(bridge: Bridge): void {
  if (--bridge.refs <= 0 && bridge.alive) {
    // 마지막 연결이 닫혔다 — JVM을 내린다(필요할 때만 띄운다)
    for (const [k, b] of bridges) if (b === bridge) bridges.delete(k);
    bridge.stop();
  }
}

/** 값: 런타임은 바이너리를 {"$b64": …}로 보낸다 */
function decode(v: unknown): unknown {
  return v && typeof v === 'object' && '$b64' in v ? Buffer.from(String((v as { $b64: string }).$b64), 'base64') : v;
}
const decodeRows = (rows: unknown): unknown[][] => (Array.isArray(rows) ? rows.map((r) => (r as unknown[]).map(decode)) : []);

const FIRST_BATCH = 200;

export class JdbcSession implements Session {
  private closed = false;
  private readonly lost = new Set<(e: Error) => void>();
  private readonly offDeath: () => void;

  constructor(
    private readonly bridge: Bridge,
    private readonly conn: string,
    readonly product: string,
    readonly version: string,
  ) {
    this.offDeath = bridge.onDeath((e) => {
      if (this.closed) return;
      this.closed = true;
      for (const l of this.lost) l(e);
    });
  }

  onLost(listener: (e: Error) => void): void {
    this.lost.add(listener);
  }

  async execute(sql: string, params?: readonly unknown[]): Promise<QueryCursor> {
    if (this.closed) throw new Error('The connection is closed.');
    const values = (params ?? []).map((p) => (typeof p === 'bigint' ? p.toString() : p instanceof Uint8Array ? Buffer.from(p).toString() : p));
    const r = await this.bridge.request('execute', { conn: this.conn, sql, params: values, fetch: FIRST_BATCH });
    const columns = (r.columns as ColumnMeta[] | undefined) ?? [];
    if (!columns.length) return emptyCursor(typeof r.affected === 'number' ? r.affected : undefined);
    const cursor = r.cursor as string | undefined;
    // 런타임은 끝까지 읽으면 커서를 닫는다. 남은 행이 요청한 수와 딱 맞아도 다시 묻지 않게 done을 기억한다
    let finished = !!r.done;
    return new BufferedCursor(
      columns.map((c) => ({ name: c.name, type: c.type })),
      decodeRows(r.rows),
      finished,
      async (n) => {
        if (!cursor || finished) return [];
        const page = await this.bridge.request('fetch', { conn: this.conn, cursor, n });
        finished = !!page.done;
        return decodeRows(page.rows);
      },
      async () => {
        if (cursor && !finished && !this.closed) await this.bridge.request('closeCursor', { conn: this.conn, cursor }).catch(() => {});
      },
    );
  }

  async cancel(): Promise<void> {
    if (!this.closed) await this.bridge.request('cancel', { conn: this.conn }).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.offDeath();
    try {
      await this.bridge.request('close', { conn: this.conn });
    } catch {
      // JVM이 이미 끝났다
    } finally {
      release(this.bridge);
    }
  }
}
