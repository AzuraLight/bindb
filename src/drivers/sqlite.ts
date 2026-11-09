import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { resolvePath, resolveTarget } from './common';
import { BufferedCursor, emptyCursor, queryAll } from './cursor';
import type { Request, Response } from './sqliteHost';
import { levelsBySchema } from './introspection';
import type { Driver, MetaTable, QueryCursor, Session } from './types';

/*
 * SQLite: Node 내장 node:sqlite를 별도 프로세스(sqliteHost)에서 돌린다.
 *  - 실제 파일을 SQLite가 직접 연다 — 잠금 · 저널 · WAL을 SQLite가 처리한다(https://www.sqlite.org/howtocorrupt.html)
 *  - 확장 호스트는 쿼리 · 잠금 대기 동안 멈추지 않는다
 *  - 취소 = 프로세스 종료(SIGKILL). SQLite가 다음에 열 때 저널로 되돌린다(https://www.sqlite.org/atomiccommit.html)
 *  - 띄우는 방식은 VS Code 언어 서버 클라이언트와 같다: fork + ELECTRON_RUN_AS_NODE=1
 *    (https://github.com/microsoft/vscode-languageserver-node/blob/main/client/src/node/main.ts)
 *  - node:sqlite에 필요한 API는 Node 22.16+ → VS Code 1.103+(Node 22.17, https://code.visualstudio.com/updates/v1_103)
 */

/** 다른 프로세스가 잠근 동안 기다리는 시간(ms). node:sqlite timeout = sqlite3_busy_timeout */
const BUSY_TIMEOUT = 5000;
/** 결과를 확장 호스트로 한 번에 보내는 행 수(최소 · 최대) */
const PAGE = 500;
const MAX_PAGE = 5000;

/** 살아 있는 SQLite 프로세스. 확장을 끌 때 모두 끝낸다(deactivate) */
const running = new Set<SqliteProcess>();

/** 확장 비활성화 때: 쿼리가 돌고 있어도 자식 프로세스를 남기지 않는다 */
export function killAllSqliteProcesses(): void {
  for (const p of running) p.kill(false);
}

type Ok = Extract<Response, { ok: true }>;
type Pending = { resolve: (r: Ok) => void; reject: (e: Error) => void };

/** 번들(out/sqliteHost.js)이 있으면 그것을, 없으면(소스에서 테스트) tsx로 .ts를 띄운다 */
function hostEntry(): { module: string; execArgv: string[] } {
  const js = path.join(__dirname, 'sqliteHost.js');
  if (existsSync(js)) return { module: js, execArgv: [] };
  return { module: path.join(__dirname, 'sqliteHost.ts'), execArgv: ['--import', 'tsx'] };
}

class SqliteProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private exitError?: Error;
  private readonly lostListeners: ((e: Error) => void)[] = [];
  private cancelled = false;

  constructor() {
    const entry = hostEntry();
    this.child = fork(entry.module, [], {
      execArgv: [...entry.execArgv, '--disable-warning=ExperimentalWarning'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BINDB_SQLITE_HOST: '1' },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    running.add(this);
    let stderr = '';
    this.child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    // 'error': 띄우지 못했거나 끝내지 못했거나 보내기가 실패했다. 이 뒤에 'exit'가 안 올 수도 있다
    // (https://nodejs.org/api/child_process.html) — 여기서도 프로세스를 잃은 것으로 처리한다
    this.child.on('error', (e) => this.lost(new Error(`The SQLite process failed: ${e.message}`)));
    this.child.on('message', (res: Response) => {
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res);
      else p.reject(new Error(res.error));
    });
    // 'close': 프로세스가 끝나고 stdio도 닫힌 뒤라 stderr를 끝까지 읽었다
    this.child.on('close', (code, signal) => {
      this.lost(
        this.cancelled
          ? new Error('Query cancelled. The SQLite session was closed, so an open transaction was rolled back.')
          : new Error(`The SQLite process stopped (${signal ?? `exit code ${code}`}).${stderr.trim() ? ` ${stderr.trim()}` : ''}`),
      );
    });
  }

  /** 한 번만: 기다리던 요청을 실패시키고 세션을 잃었다고 알린다 */
  private lost(error: Error): void {
    if (this.exitError) return;
    this.exitError = error;
    running.delete(this);
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    for (const l of this.lostListeners) l(error);
  }

  request<T extends Request['op']>(op: T, body: Omit<Extract<Request, { op: T }>, 'id' | 'op'>): Promise<Ok> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ id, op, ...body } as Request, (err) => {
        if (err && this.pending.delete(id)) reject(err);
      });
    });
  }

  onLost(listener: (e: Error) => void): void {
    this.lostListeners.push(listener);
  }

  get alive(): boolean {
    return !this.exitError;
  }

  kill(asCancel = true): void {
    if (asCancel) this.cancelled = true;
    this.child.kill('SIGKILL');
  }

  async close(): Promise<void> {
    if (!this.alive) return;
    const gone = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) resolve();
      else this.child.once('exit', () => resolve());
    });
    // 쿼리가 돌고 있으면 자식은 close 요청을 그 쿼리가 끝난 뒤에야 읽는다(동기 실행) — 바로 끝낸다
    if (this.pending.size > 0) {
      this.child.kill('SIGKILL');
    } else {
      // 정상 종료를 잠깐 기다리고(타이머를 먼저 건다), 남아 있으면 끝낸다
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
      void this.request('close', {}).catch(() => {});
      await gone;
      clearTimeout(timer);
      return;
    }
    await gone;
  }
}

class SqliteSession implements Session {
  constructor(private readonly proc: SqliteProcess) {}

  onLost(listener: (error: Error) => void): void {
    this.proc.onLost(listener);
  }

  async execute(sql: string, params?: readonly unknown[]): Promise<QueryCursor> {
    const r = await this.proc.request('execute', { sql, params: [...(params ?? [])] });
    const columns = (r.columns ?? []).map((name) => ({ name }));
    if (r.cursor === undefined) return emptyCursor(r.affected);
    const cursor = r.cursor;
    let done = false;
    // BufferedCursor는 요청보다 적게 오면 끝으로 본다 — 끝이 아니면 n을 다 채울 때까지 쪽을 나눠 받는다
    const readMore = async (n: number) => {
      const out: unknown[][] = [];
      while (!done && out.length < n) {
        const page = await this.proc.request('fetch', { cursor, n: Math.min(Math.max(n - out.length, PAGE), MAX_PAGE) });
        done = !!page.done;
        out.push(...(page.rows ?? []));
      }
      return out;
    };
    return new BufferedCursor(
      columns,
      [],
      false,
      readMore,
      async () => {
        if (!done && this.proc.alive) await this.proc.request('closeCursor', { cursor }).catch(() => {});
        done = true;
      },
      r.affected,
    );
  }

  async cancel(): Promise<void> {
    // node:sqlite에는 sqlite3_interrupt가 없다 — 프로세스를 끝낸다. 세션은 잃고(onLost) 다음 실행 때 새로 연다
    if (this.proc.alive) this.proc.kill();
  }

  async close(): Promise<void> {
    await this.proc.close();
  }
}

export const sqliteDriver: Driver = {
  id: 'sqlite',
  label: 'SQLite',
  quote: '"',
  defaultSchema: () => 'main',

  async connect(cfg) {
    const file = resolveTarget(cfg, {}).cfg.file;
    if (!file) throw new Error('SQLite connection has no file.');
    const proc = new SqliteProcess();
    try {
      await proc.request('open', { file: resolvePath(cfg, file), readOnly: !!cfg.readOnly, timeout: BUSY_TIMEOUT });
    } catch (e) {
      await proc.close();
      throw e;
    }
    return new SqliteSession(proc);
  },

  async introspect(session, cfg) {
    const objects = await queryAll(
      session,
      `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`,
    );
    // main은 늘 현재 스키마. 1단계: 열 이름만(타입 · 기본키 없음)
    const level = levelsBySchema(cfg, objects.map(() => 'main'), 'main', () => false).get('main') ?? 3;
    const out: MetaTable[] = [];
    for (const [name, type] of objects) {
      const cols = await queryAll(session, `SELECT name, type, pk FROM pragma_table_info('${String(name).replace(/'/g, "''")}')`);
      out.push({
        schema: 'main',
        name: String(name),
        kind: type === 'view' ? 'view' : 'table',
        level,
        columns: cols.map(([n, t]) => ({ name: String(n), type: level > 1 && t ? String(t) : undefined })),
        // pk: 기본키 안의 순서(1부터), 0이면 기본키가 아니다
        primaryKey:
          level > 1
            ? cols
                .filter(([, , pk]) => Number(pk) > 0)
                .sort(([, , a], [, , b]) => Number(a) - Number(b))
                .map(([n]) => String(n))
            : [],
      });
    }
    return out;
  },
};
