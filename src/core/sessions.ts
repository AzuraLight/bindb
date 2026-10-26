import * as vscode from 'vscode';
import { drivers, type ConnectionConfig, type FetchResult, type MetaTable, type QueryCursor, type Session } from '../drivers';
import type { ConnectionStore } from './connections';

interface Live {
  session: Promise<Session>;
  meta?: Promise<MetaTable[]>;
  /** 결과 그리드가 아직 읽고 있는 커서 */
  cursor?: QueryCursor;
  /** 이 연결에서 직렬화해 실행하기 위한 꼬리 */
  tail: Promise<unknown>;
}

/**
 * 연결마다 세션 하나(M1). 처음 쓸 때 연결하고, 문장은 순서대로 실행한다.
 * 스키마 메타데이터도 연결 단위로 캐시한다.
 */
export class SessionManager implements vscode.Disposable {
  private readonly live = new Map<string, Live>();
  private readonly changed = new vscode.EventEmitter<string>();
  /** 연결 상태나 메타데이터가 바뀐 연결 id */
  readonly onDidChange = this.changed.event;

  constructor(private readonly store: ConnectionStore) {}

  isOpen(id: string): boolean {
    return this.live.has(id);
  }

  private open(cfg: ConnectionConfig): Live {
    let entry = this.live.get(cfg.id);
    if (!entry) {
      const session = this.connect(cfg);
      entry = { session, tail: session.catch(() => {}) };
      this.live.set(cfg.id, entry);
      session.then(
        () => this.changed.fire(cfg.id),
        () => {
          // 실패한 연결은 다음 시도에서 새로 연결하도록 버린다.
          if (this.live.get(cfg.id) === entry) this.live.delete(cfg.id);
          this.changed.fire(cfg.id);
        },
      );
    }
    return entry;
  }

  private async connect(cfg: ConnectionConfig): Promise<Session> {
    const password = await this.store.password(cfg.id);
    const h2Jar = vscode.workspace.getConfiguration('bindb').get<string>('h2.jarPath') || undefined;
    return drivers[cfg.driver].connect(cfg, { password, h2Jar });
  }

  private enqueue<T>(entry: Live, fn: (session: Session) => Promise<T>): Promise<T> {
    const result = entry.tail.then(async () => fn(await entry.session));
    entry.tail = result.catch(() => {});
    return result;
  }

  /**
   * 세션 위에서 fn을 실행한다. 같은 연결의 다른 작업이 끝날 때까지 기다린다.
   * 열린 커서가 있으면 먼저 닫는다 — pg는 커서가 열린 동안 다른 쿼리를 받지 않는다.
   */
  run<T>(cfg: ConnectionConfig, fn: (session: Session) => Promise<T>): Promise<T> {
    const entry = this.open(cfg);
    return this.enqueue(entry, async (session) => {
      const open = entry.cursor;
      if (open) {
        entry.cursor = undefined;
        await open.close().catch(() => {});
      }
      return fn(session);
    });
  }

  /** 문장을 실행하고 커서를 이 연결의 "열린 결과"로 등록한다. */
  async execute(cfg: ConnectionConfig, sql: string): Promise<QueryCursor> {
    const cursor = await this.run(cfg, (s) => s.execute(sql));
    const entry = this.live.get(cfg.id);
    if (entry) entry.cursor = cursor;
    return cursor;
  }

  /** 열린 결과에서 n행 더. 더 새 작업이 커서를 닫았으면 실패한다. */
  fetch(cfg: ConnectionConfig, cursor: QueryCursor, n: number): Promise<FetchResult> {
    const entry = this.live.get(cfg.id);
    if (!entry || entry.cursor !== cursor) return Promise.reject(new Error('This result was closed by a newer query.'));
    return this.enqueue(entry, async () => {
      if (entry.cursor !== cursor) throw new Error('This result was closed by a newer query.');
      const result = await cursor.fetch(n);
      if (result.done) entry.cursor = undefined;
      return result;
    });
  }

  /** 실행 중인 문장 취소. 직렬화 큐를 거치지 않는다. */
  async cancel(cfg: ConnectionConfig): Promise<void> {
    const entry = this.live.get(cfg.id);
    if (entry) await (await entry.session).cancel();
  }

  metadata(cfg: ConnectionConfig, refresh = false): Promise<MetaTable[]> {
    const entry = this.open(cfg);
    if (!entry.meta || refresh) {
      const meta = this.run(cfg, (s) => drivers[cfg.driver].introspect(s, cfg));
      entry.meta = meta;
      meta.then(
        () => this.changed.fire(cfg.id),
        () => {
          if (entry.meta === meta) entry.meta = undefined;
        },
      );
    }
    return entry.meta;
  }

  /** 이미 받아 둔 메타데이터만(자동완성용, 기다리지 않는다) */
  cachedMetadata(id: string): Promise<MetaTable[]> | undefined {
    return this.live.get(id)?.meta;
  }

  async disconnect(id: string): Promise<void> {
    const entry = this.live.get(id);
    if (!entry) return;
    this.live.delete(id);
    this.changed.fire(id);
    await entry.session.then((s) => s.close()).catch(() => {});
  }

  dispose(): void {
    for (const id of [...this.live.keys()]) void this.disconnect(id);
    this.changed.dispose();
  }
}
