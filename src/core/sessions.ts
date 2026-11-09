import * as vscode from 'vscode';
import { drivers, type ConnectionConfig, type FetchResult, type MetaTable, type QueryCursor, type Session } from '../drivers';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveSharedSsh, sshSecretOwner } from '../drivers/common';
import { queryAll } from '../drivers/cursor';
import { connectDriver } from '../drivers/tunnel';
import type { SharedSshConfig } from '../drivers/types';
import { withSessionTemplate } from './connectionDraft';
import { classifySql } from './classify';
import { cannotRunInTransaction, switchSchemaSql } from './sessionSql';
import { parseDdl } from './ddl';
import { splitStatements } from '../language/splitter';
import type { ConnectionStore } from './connections';

/** 문장을 어디서 실행하는가. client = 콘솔 문서 URI(Session control · Dedicated sessions에서 콘솔마다 세션) */
export interface RunContext {
  client?: string;
  /** 콘솔의 `-- @schema:` (Switch schema) */
  schema?: string;
  /** 연결의 기본이 아닌 데이터베이스(탐색기에서 다른 데이터베이스의 테이블을 열 때) */
  database?: string;
}

interface Live {
  key: string;
  cfg: ConnectionConfig;
  session: Promise<Session>;
  /** 결과 그리드가 아직 읽고 있는 커서 */
  cursor?: QueryCursor;
  /** 이 세션에서 직렬화해 실행하기 위한 꼬리 */
  tail: Promise<unknown>;
  /** Transaction control: Manual에서 BEGIN을 보낸 뒤인가(postgres · sqlite) */
  inTx: boolean;
  /** 이 세션에 지금 걸린 스키마(Switch schema) */
  currentSchema?: string;
  /** postgres: 스키마를 바꾸기 전의 search_path(SHOW search_path) */
  baseSearchPath?: string;
  keepAlive?: ReturnType<typeof setInterval>;
}

/** 연결(id) 단위 타이머 */
interface ConnTimers {
  idle?: ReturnType<typeof setTimeout>;
  introspect?: ReturnType<typeof setInterval>;
}

const DDL = /^\s*(create|alter|drop|rename|truncate|comment\s+on)\b/i;
const TX_CONTROL = /^\s*(begin|start\s+transaction|commit|rollback|end|savepoint|release)\b/i;
const TX_END = /^\s*(commit|rollback|end)\b(?!\s+to\b)/i;
const SYSTEM_SCHEMA = /^(pg_catalog|information_schema|pg_toast.*|pg_temp.*|mysql|performance_schema|sys|INFORMATION_SCHEMA)$/i;

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * 연결의 세션들. Options 탭 설정을 여기서 지킨다.
 *  - Session control: single = 세션 하나, two = 공유 + 스키마 조회용, dedicated = 콘솔마다 따로
 *  - 접속 직후: Time zone, Transaction control(Manual), Startup script
 *  - Run keep-alive query, Auto-disconnect, Auto sync, Automatic introspection interval
 *  - Switch schema
 * 메타데이터는 연결(과 데이터베이스) 단위로 캐시한다.
 */
export class SessionManager implements vscode.Disposable {
  private readonly live = new Map<string, Live>();
  private readonly meta = new Map<string, Promise<MetaTable[]>>();
  private readonly timers = new Map<string, ConnTimers>();
  /** 같은 연결에서 비밀번호를 한 번만 묻도록 */
  private readonly asking = new Map<string, Promise<string | undefined>>();
  private readonly changed = new vscode.EventEmitter<string>();
  /** 연결 상태나 메타데이터가 바뀐 연결 id */
  readonly onDidChange = this.changed.event;

  constructor(private readonly store: ConnectionStore) {}

  isOpen(id: string): boolean {
    return [...this.live.values()].some((l) => l.cfg.id === id);
  }

  /** Session control에 따라 이 작업이 쓸 세션 이름 */
  private channel(cfg: ConnectionConfig, purpose: 'query' | 'introspect', ctx: RunContext = {}, database?: string): string {
    const db = database && database !== cfg.database ? `db:${database}:` : '';
    const mode = cfg.sessionControl ?? 'single';
    if (mode === 'single') return `${cfg.id}#${db}shared`;
    if (purpose === 'introspect') return `${cfg.id}#${db}introspect`;
    if (mode === 'dedicated' && ctx.client) return `${cfg.id}#${db}client:${ctx.client}`;
    return `${cfg.id}#${db}shared`;
  }

  private open(cfg: ConnectionConfig, key: string): Live {
    let entry = this.live.get(key);
    if (!entry) {
      const session = this.connect(cfg);
      const created: Live = { key, cfg, session, tail: session.catch(() => {}), inTx: false };
      entry = created;
      this.live.set(key, created);
      session.then(
        (s) => {
          // 서버가 연결을 끊으면 이 세션을 버린다 — 다음 사용 때 새로 연결한다
          s.onLost?.(() => {
            // 끊긴 세션도 닫는다(H2 서버 같은 공유 자원을 반납한다)
            void s.close().catch(() => {});
            if (this.live.get(key) !== created) return;
            if (created.keepAlive) clearInterval(created.keepAlive);
            this.live.delete(key);
            this.changed.fire(cfg.id);
          });
          this.startTimers(cfg, created);
          this.changed.fire(cfg.id);
        },
        () => {
          // 실패한 연결은 다음 시도에서 새로 연결하도록 버린다.
          if (this.live.get(key) === created) this.live.delete(key);
          this.changed.fire(cfg.id);
        },
      );
    }
    this.touch(cfg);
    return entry;
  }

  private async password(cfg: ConnectionConfig): Promise<string | undefined> {
    if (cfg.auth === 'none' || cfg.auth === 'pgpass' || cfg.driver === 'sqlite') return undefined;
    const saved = await this.store.password(cfg.id);
    if (saved !== undefined || (cfg.passwordSave ?? 'forever') === 'forever') return saved;
    // Never · Until restart · For session: 보관된 게 없으면 묻는다
    let pending = this.asking.get(cfg.id);
    if (!pending) {
      pending = Promise.resolve(
        vscode.window.showInputBox({ prompt: `Password for ${cfg.name}`, password: true, ignoreFocusOut: true }),
      ).finally(() => this.asking.delete(cfg.id));
      this.asking.set(cfg.id, pending);
    }
    const typed = await pending;
    if (typed === undefined) throw new Error('Password entry was cancelled.');
    this.store.remember(cfg, typed);
    return typed;
  }

  /** Before connection을 이미 돌린 연결(끊으면 다시 돌린다) */
  private readonly prepared = new Map<string, Promise<void>>();

  /** Options · Other · Before connection: 첫 접속 전에 VS Code 작업을 차례로 실행한다 */
  private beforeConnection(cfg: ConnectionConfig): Promise<void> {
    if (!cfg.beforeConnection?.length) return Promise.resolve();
    let p = this.prepared.get(cfg.id);
    if (!p) {
      p = runTasks(cfg.beforeConnection).catch((e) => {
        this.prepared.delete(cfg.id);
        throw e;
      });
      this.prepared.set(cfg.id, p);
    }
    return p;
  }

  private async connect(original: ConnectionConfig): Promise<Session> {
    // Use session template: 템플릿 값(User · Read-only · Startup script)이 덮어쓴다
    const cfg = resolveSharedSsh(withSessionTemplate(original), sharedSshConfigs());
    await this.beforeConnection(cfg);
    const password = await this.password(cfg);
    const h2Jar = vscode.workspace.getConfiguration('bindb').get<string>('h2.jarPath') || undefined;
    const sslKeyPassword = cfg.sslKeyFile ? await this.store.secret('sslKey', cfg.id) : undefined;
    const sshSecret = cfg.ssh?.enabled && cfg.ssh.auth !== 'agent' ? await this.store.secret('ssh', sshSecretOwner(cfg)) : undefined;
    const session = await connectDriver(drivers[cfg.driver], cfg, { password, h2Jar, sslKeyPassword, sshSecret, askHostKey, askKeyboard });
    try {
      for (const sql of setupStatements(cfg)) await (await session.execute(sql)).close();
    } catch (e) {
      await session.close().catch(() => {});
      throw new Error(`Connected, but the session setup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return session;
  }

  /** 실행 중인 작업 수(자동 끊기가 실행 중인 쿼리를 끊지 않게) */
  private busy = new Map<string, number>();

  private enqueue<T>(entry: Live, fn: (session: Session) => Promise<T>, activity = true): Promise<T> {
    if (!activity) {
      const r = entry.tail.then(async () => fn(await entry.session));
      entry.tail = r.catch(() => {});
      return r;
    }
    const id = entry.cfg.id;
    this.busy.set(id, (this.busy.get(id) ?? 0) + 1);
    const result = entry.tail
      .then(async () => fn(await entry.session))
      .finally(() => {
        this.busy.set(id, (this.busy.get(id) ?? 1) - 1);
        this.touch(entry.cfg);
      });
    entry.tail = result.catch(() => {});
    return result;
  }

  /**
   * 세션 위에서 fn을 실행한다. 같은 세션의 다른 작업이 끝날 때까지 기다린다.
   * 열린 커서가 있으면 먼저 닫는다 — pg는 커서가 열린 동안 다른 쿼리를 받지 않는다.
   */
  private runOn<T>(entry: Live, fn: (session: Session) => Promise<T>): Promise<T> {
    return this.enqueue(entry, async (session) => {
      const open = entry.cursor;
      if (open) {
        entry.cursor = undefined;
        await open.close().catch(() => {});
      }
      return fn(session);
    });
  }

  /** 문장을 실행하고 커서를 이 세션의 "열린 결과"로 등록한다. */
  async execute(cfg: ConnectionConfig, sql: string, ctx: RunContext = {}): Promise<QueryCursor> {
    if (cfg.kind === 'ddl') throw new Error(`${cfg.name} is a DDL data source (SQL files); it cannot run statements.`);
    // 읽기 전용 연결: 실행 전에 판정한다. 세션 설정(SET … READ ONLY)만으로는 SET … READ WRITE 한 줄로 풀린다
    if (withSessionTemplate(cfg).readOnly) {
      const c = classifySql(sql, cfg.driver);
      if (c.kind === 'write') throw new Error(`${cfg.name} is read-only: this statement was not run because ${c.reason ?? 'it may change data'}.`);
    }
    const target = ctx.database && ctx.database !== cfg.database ? { ...cfg, database: ctx.database } : cfg;
    const entry = this.open(target, this.channel(cfg, 'query', ctx, ctx.database));
    const cursor = await this.runOn(entry, async (session) => {
      await this.applySchema(cfg, entry, session, ctx.schema, false);
      // Transaction control · Manual: postgres · sqlite는 자동 커밋을 끌 수 없어 첫 문장 앞에 BEGIN을 보낸다
      if (cfg.transactionControl === 'manual' && (cfg.driver === 'postgres' || cfg.driver === 'sqlite')) {
        // 트랜잭션 블록 안에서 실행할 수 없는 문장(VACUUM · CREATE INDEX CONCURRENTLY …)은 BEGIN 없이 보낸다
        if (!entry.inTx && !TX_CONTROL.test(sql) && !cannotRunInTransaction(sql, cfg.driver)) {
          await (await session.execute('BEGIN')).close();
          entry.inTx = true;
        }
      }
      const c = await session.execute(sql);
      if (TX_END.test(sql)) entry.inTx = false;
      else if (/^\s*(begin|start\s+transaction)\b/i.test(sql)) entry.inTx = true;
      return c;
    });
    entry.cursor = cursor;
    // 닫히면 "열린 결과"에서 뺀다(keep-alive가 결과를 읽는 중으로 보고 건너뛰지 않게)
    const close = cursor.close.bind(cursor);
    cursor.close = async () => {
      if (entry.cursor === cursor) entry.cursor = undefined;
      await close();
    };
    // Introspection · Auto sync: DDL을 실행하면 탐색기를 새로 고친다
    if (cfg.autoSync !== false && DDL.test(sql) && cursor.columns.length === 0) {
      void this.metadata(cfg, true).catch(() => {});
    }
    return cursor;
  }

  /**
   * AI 도구용 읽기 전용 조회. 사용자 콘솔과 따로인 세션(ai)에서 실행하고, 무엇을 실행했든 끝에 되돌린다.
   *  - postgres · mysql: DB의 읽기 전용 트랜잭션 안에서 실행(쓰기는 DB가 거부)
   *  - sqlite: 파일을 읽기 전용으로 연 세션에서 실행(쓰기는 SQLite가 거부)
   *  - h2: 판정만(DB 차원의 보호는 H2 접속 방식을 바꿀 때 넣는다 — docs/audit-2026-11-06.md)
   * 행은 limit까지만 읽는다.
   */
  async readOnlyQuery(cfg: ConnectionConfig, sql: string, limit: number): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> {
    if (cfg.kind === 'ddl') throw new Error(`${cfg.name} is a DDL data source; it cannot run queries.`);
    // 실행하기 전에 판정한다 — 실행한 뒤에 확인하면 늦다(H2 · MySQL은 DDL을 즉시 커밋한다)
    const c = classifySql(sql, cfg.driver);
    if (c.kind !== 'read') throw new Error(`Only read-only queries can run here; nothing was executed (${c.reason ?? c.kind}).`);
    // SQLite: AI 세션은 파일을 읽기 전용(SQLITE_OPEN_READONLY)으로 연다 — 판정이 놓쳐도 SQLite가 쓰기를 거부한다
    const entry = this.open(cfg.driver === 'sqlite' ? { ...cfg, readOnly: true } : cfg, `${cfg.id}#ai`);
    return this.runOn(entry, async (session) => {
      const read = async () => {
        const cursor = await session.execute(sql);
        try {
          const { rows, done } = await cursor.fetch(limit);
          return { columns: cursor.columns.map((col) => col.name), rows, truncated: !done };
        } finally {
          await cursor.close();
        }
      };
      // PostgreSQL · MySQL은 판정에 더해 DB의 읽기 전용 트랜잭션으로 한 번 더 막는다(판정이 놓친 것 대비)
      if (cfg.driver !== 'postgres' && cfg.driver !== 'mysql') return read();
      await (await session.execute(cfg.driver === 'postgres' ? 'BEGIN READ ONLY' : 'START TRANSACTION READ ONLY')).close();
      try {
        return await read();
      } finally {
        await (await session.execute('ROLLBACK')).close().catch(() => {});
      }
    });
  }

  /**
   * 그리드 편집 적용(Submit).
   *  - 자동 커밋: 한 트랜잭션으로 묶고, UPDATE · DELETE가 정확히 한 행을 바꾸지 않거나 하나라도 실패하면 모두 되돌린다
   *  - Transaction control · Manual: 지금 트랜잭션 안에서 실행만 하고 COMMIT은 사용자에게 맡긴다
   */
  async applyEdits(
    cfg: ConnectionConfig,
    statements: readonly { sql: string; params: unknown[]; expectOne: boolean }[],
    ctx: RunContext = {},
  ): Promise<{ committed: boolean }> {
    if (cfg.readOnly) throw new Error(`${cfg.name} is read-only.`);
    const target = ctx.database && ctx.database !== cfg.database ? { ...cfg, database: ctx.database } : cfg;
    const entry = this.open(target, this.channel(cfg, 'query', ctx, ctx.database));
    const manual = cfg.transactionControl === 'manual';
    return this.runOn(entry, async (session) => {
      const exec = async (sql: string, params?: unknown[]) => {
        const c = await session.execute(sql, params);
        const n = c.affectedRows;
        await c.close();
        return n;
      };
      const begin = cfg.driver === 'mysql' ? 'START TRANSACTION' : cfg.driver === 'h2' ? 'SET AUTOCOMMIT FALSE' : 'BEGIN';
      const own = !manual;
      if (own) await exec(begin);
      else if ((cfg.driver === 'postgres' || cfg.driver === 'sqlite') && !entry.inTx) {
        await exec('BEGIN');
        entry.inTx = true;
      }
      try {
        for (let i = 0; i < statements.length; i++) {
          const st = statements[i];
          let n: number | undefined;
          try {
            n = await exec(st.sql, st.params);
          } catch (e) {
            throw new Error(`Change ${i + 1} of ${statements.length} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (st.expectOne && n !== undefined && n !== 1) {
            throw new Error(
              `Change ${i + 1} of ${statements.length} affected ${n} rows instead of 1 — the row was changed or deleted by someone else, or the key is not unique.`,
            );
          }
        }
        if (own) await exec('COMMIT');
      } catch (e) {
        if (own) await exec('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        if (own && cfg.driver === 'h2') await exec('SET AUTOCOMMIT TRUE').catch(() => {});
      }
      return { committed: own };
    });
  }

  /** Manual 트랜잭션 확정 · 되돌리기 */
  async endTransaction(cfg: ConnectionConfig, how: 'COMMIT' | 'ROLLBACK', ctx: RunContext = {}): Promise<void> {
    const entry = this.live.get(this.channel(cfg, 'query', ctx, ctx.database));
    if (!entry) throw new Error(`${cfg.name} is not connected.`);
    await this.runOn(entry, async (session) => {
      await (await session.execute(how)).close();
      entry.inTx = false;
    });
  }

  /** 지금 진행 중인 수동 트랜잭션이 있는가(postgres · sqlite만 알 수 있다) */
  inTransaction(cfg: ConnectionConfig, ctx: RunContext = {}): boolean {
    return !!this.live.get(this.channel(cfg, 'query', ctx, ctx.database))?.inTx;
  }

  /** Switch schema. explicit = 사용자가 명령으로 바꿈(Manual에서도 적용) */
  async switchSchema(cfg: ConnectionConfig, schema: string, ctx: RunContext = {}): Promise<void> {
    if ((cfg.switchSchema ?? 'manual') === 'disable') throw new Error(`Schema switching is disabled for ${cfg.name}.`);
    const target = ctx.database && ctx.database !== cfg.database ? { ...cfg, database: ctx.database } : cfg;
    const entry = this.open(target, this.channel(cfg, 'query', ctx, ctx.database));
    await this.runOn(entry, (session) => this.applySchema(cfg, entry, session, schema, true));
  }

  private async applySchema(cfg: ConnectionConfig, entry: Live, session: Session, schema: string | undefined, explicit: boolean) {
    if (!schema || entry.currentSchema === schema) return;
    const mode = cfg.switchSchema ?? 'manual';
    // Automatic: 콘솔의 @schema를 실행할 때마다(다시 접속한 뒤에도) 되살린다. Manual: 사용자가 바꿀 때만.
    if (mode === 'disable' || (mode === 'manual' && !explicit)) return;
    // postgres: 세션이 처음 가진 search_path를 기억해 두고 고른 스키마를 그 앞에 붙인다
    if (cfg.driver === 'postgres' && entry.baseSearchPath === undefined) {
      entry.baseSearchPath = String((await queryAll(session, 'SHOW search_path'))[0]?.[0] ?? '');
    }
    const sql = switchSchemaSql(cfg, schema, entry.baseSearchPath);
    if (!sql) return;
    await (await session.execute(sql)).close();
    entry.currentSchema = schema;
  }

  /** 열린 결과에서 n행 더. 더 새 작업이 커서를 닫았으면 실패한다. */
  fetch(cursor: QueryCursor, n: number): Promise<FetchResult> {
    const entry = [...this.live.values()].find((l) => l.cursor === cursor);
    if (!entry) return Promise.reject(new Error('This result was closed by a newer query.'));
    this.touch(entry.cfg);
    return this.enqueue(entry, async () => {
      if (entry.cursor !== cursor) throw new Error('This result was closed by a newer query.');
      const result = await cursor.fetch(n);
      if (result.done) entry.cursor = undefined;
      return result;
    });
  }

  /** 실행 중인 문장 취소. 직렬화 큐를 거치지 않는다. */
  async cancel(cfg: ConnectionConfig, ctx: RunContext = {}): Promise<void> {
    const entry = this.live.get(this.channel(cfg, 'query', ctx, ctx.database));
    if (entry) await (await entry.session).cancel();
  }

  private metaKey(cfg: ConnectionConfig, database?: string) {
    return database && database !== cfg.database ? `${cfg.id}@${database}` : cfg.id;
  }

  /** 스키마 메타데이터. database를 주면 그 데이터베이스로 따로 접속해 읽는다(Single database mode 끔) */
  metadata(cfg: ConnectionConfig, refresh = false, database?: string): Promise<MetaTable[]> {
    const key = this.metaKey(cfg, database);
    let meta = this.meta.get(key);
    if (cfg.kind === 'ddl') {
      // DDL data source: 폴더의 .sql 파일을 읽어 만든다(접속 없음)
      if (!meta || refresh) {
        const next = readDdlFolder(cfg);
        this.meta.set(key, next);
        next.then(() => this.changed.fire(cfg.id), () => this.meta.delete(key));
        meta = next;
      }
      return meta;
    }
    if (!meta || refresh) {
      const target = database ? { ...cfg, database } : cfg;
      const entry = this.open(target, this.channel(cfg, 'introspect', {}, database));
      const before = this.meta.get(key);
      const next: Promise<MetaTable[]> = this.runOn(entry, (s) => drivers[cfg.driver].introspect(s, target)).then(async (tables) => {
        // Track databases/schemas creation and deletion을 끄면 처음 본 스키마 목록을 유지한다
        if (cfg.trackSchemas === false && before) {
          const known = new Set((await before.catch(() => [] as MetaTable[])).map((t) => t.schema));
          if (known.size) return tables.filter((t) => known.has(t.schema));
        }
        return tables;
      });
      meta = next;
      this.meta.set(key, next);
      next.then(
        () => this.changed.fire(cfg.id),
        () => {
          if (this.meta.get(key) === next) this.meta.delete(key);
        },
      );
    }
    return meta;
  }

  /** 이미 받아 둔 메타데이터만(자동완성용, 기다리지 않는다) */
  cachedMetadata(id: string): Promise<MetaTable[]> | undefined {
    return this.meta.get(id);
  }

  /** postgres: 이 서버의 데이터베이스 목록(Show template databases 반영) */
  async databases(cfg: ConnectionConfig): Promise<string[]> {
    if (cfg.driver !== 'postgres') return cfg.database ? [cfg.database] : [];
    const entry = this.open(cfg, this.channel(cfg, 'introspect'));
    const rows = await this.runOn(entry, async (s) => {
      const c = await s.execute(
        `SELECT datname FROM pg_database WHERE datallowconn ${cfg.showTemplateDatabases ? '' : 'AND NOT datistemplate'} ORDER BY datname`,
      );
      try {
        return (await c.fetch(10000)).rows;
      } finally {
        await c.close();
      }
    });
    return rows.map((r) => String(r[0]));
  }

  /** 시스템 스키마인가(Show internal system schemas · Load sources for) */
  static isSystemSchema(name: string): boolean {
    return SYSTEM_SCHEMA.test(name);
  }

  private startTimers(cfg: ConnectionConfig, entry: Live): void {
    // Run keep-alive query each N sec. 결과를 읽는 중(커서가 열림)에는 건너뛴다
    if (cfg.keepAlive && !entry.keepAlive) {
      entry.keepAlive = setInterval(() => {
        if (entry.cursor || !this.live.has(entry.key)) return;
        // keep-alive는 사용으로 치지 않는다(자동 끊기 시계를 되돌리지 않게)
        void this.enqueue(entry, async (s) => (await s.execute('SELECT 1')).close(), false).catch(() => {});
      }, cfg.keepAlive * 1000);
    }
    const t = this.timers.get(cfg.id) ?? {};
    // Automatic introspection interval N minutes
    if (cfg.introspectInterval && !t.introspect) {
      t.introspect = setInterval(() => void this.metadata(cfg, true).catch(() => {}), cfg.introspectInterval * 60_000);
    }
    this.timers.set(cfg.id, t);
  }

  /** Auto-disconnect after N sec: 마지막 사용부터 센다 */
  private touch(cfg: ConnectionConfig): void {
    if (!cfg.autoDisconnect) return;
    const t = this.timers.get(cfg.id) ?? {};
    if (t.idle) clearTimeout(t.idle);
    t.idle = setTimeout(() => {
      // 실행 중인 쿼리 · 열린 트랜잭션 · 읽는 중인 결과가 있으면 끊지 않고 다시 잰다
      const entries = [...this.live.values()].filter((l) => l.cfg.id === cfg.id);
      if ((this.busy.get(cfg.id) ?? 0) > 0 || entries.some((l) => l.inTx || l.cursor)) return this.touch(cfg);
      void this.disconnect(cfg.id);
    }, cfg.autoDisconnect * 1000);
    this.timers.set(cfg.id, t);
  }

  async disconnect(id: string): Promise<void> {
    const entries = [...this.live.values()].filter((l) => l.cfg.id === id);
    const t = this.timers.get(id);
    if (t?.idle) clearTimeout(t.idle);
    if (t?.introspect) clearInterval(t.introspect);
    this.timers.delete(id);
    this.prepared.delete(id);
    for (const key of [...this.meta.keys()]) if (key === id || key.startsWith(`${id}@`)) this.meta.delete(key);
    if (!entries.length) return;
    for (const e of entries) {
      if (e.keepAlive) clearInterval(e.keepAlive);
      this.live.delete(e.key);
    }
    const cfg = this.store.get(id) ?? entries[0].cfg;
    this.store.forgetSession(cfg);
    this.changed.fire(id);
    await Promise.all(entries.map((e) => e.session.then((s) => s.close()).catch(() => {})));
  }

  dispose(): void {
    for (const id of new Set([...this.live.values()].map((l) => l.cfg.id))) void this.disconnect(id);
    this.changed.dispose();
  }
}

/** 접속 직후 보낼 문장: Time zone · Transaction control(Manual) · Startup script */
export function setupStatements(cfg: ConnectionConfig): string[] {
  const out: string[] = [];
  const tz = cfg.timeZone?.trim();
  if (tz) {
    if (cfg.driver === 'mysql') out.push(`SET time_zone = ${lit(tz)}`);
    else if (cfg.driver === 'postgres' || cfg.driver === 'h2') out.push(`SET TIME ZONE ${lit(tz)}`);
  }
  if (cfg.transactionControl === 'manual') {
    if (cfg.driver === 'mysql') out.push('SET autocommit = 0');
    else if (cfg.driver === 'h2') out.push('SET AUTOCOMMIT FALSE');
  }
  if (cfg.startupScript?.trim()) out.push(...splitStatements(cfg.startupScript, cfg.driver).map((s) => s.text));
  return out;
}

/** DDL data source: 폴더(하위 폴더 포함)의 .sql 파일 → 메타데이터. 하위 폴더 이름은 스키마로 본다 */
export async function readDdlFolder(cfg: ConnectionConfig): Promise<MetaTable[]> {
  const root = cfg.ddlFolder;
  if (!root) throw new Error('This DDL data source has no folder.');
  const fallback = drivers[cfg.driver].defaultSchema(cfg) ?? 'public';
  const out: MetaTable[] = [];
  const walk = async (dir: string, schema: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, e.name);
      else if (/\.sql$/i.test(e.name)) out.push(...parseDdl(await readFile(full, 'utf8'), schema, cfg.driver));
    }
  };
  await walk(root, fallback);
  return out;
}

/** VS Code 작업(tasks.json · 확장이 주는 작업)을 이름으로 찾아 차례로 실행한다. 종료 코드가 0이 아니면 실패 */
async function runTasks(names: string[]): Promise<void> {
  const all = await vscode.tasks.fetchTasks();
  for (const name of names) {
    const task = all.find((t) => t.name === name || `${t.source}: ${t.name}` === name);
    if (!task) throw new Error(`Before connection: no task named "${name}".`);
    const execution = await vscode.tasks.executeTask(task);
    const limit = 5 * 60_000;
    const code = await new Promise<number | undefined>((resolve, reject) => {
      // 끝나지 않는 작업(watch 등)이면 접속이 영원히 멈추지 않게 시간을 둔다
      const timer = setTimeout(() => {
        sub.dispose();
        execution.terminate();
        reject(new Error(`Before connection: task "${name}" did not finish within ${limit / 60_000} minutes.`));
      }, limit);
      const sub = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution === execution) {
          clearTimeout(timer);
          sub.dispose();
          resolve(e.exitCode);
        }
      });
    });
    if (code !== 0 && code !== undefined) throw new Error(`Before connection: task "${name}" exited with code ${code}.`);
  }
}

/**
 * 공유 SSH 설정(사용자 설정 bindb.ssh.configurations). 사용자(전역) 설정에서만 읽는다 —
 * 작업 공간 설정이 같은 id로 다른 호스트를 넣으면 그 id에 저장된 SSH 비밀 값이 그 호스트로 간다.
 */
export function sharedSshConfigs(): SharedSshConfig[] {
  return vscode.workspace.getConfiguration('bindb').inspect<SharedSshConfig[]>('ssh.configurations')?.globalValue ?? [];
}

/** SSH keyboard-interactive: 서버가 묻는 것(OTP · PAM 질문)을 하나씩 묻는다. 하나라도 취소하면 undefined */
export async function askKeyboard(title: string, prompts: { prompt: string; echo: boolean }[]): Promise<string[] | undefined> {
  const answers: string[] = [];
  for (const p of prompts) {
    const a = await vscode.window.showInputBox({ title, prompt: p.prompt.trim(), password: !p.echo, ignoreFocusOut: true });
    if (a === undefined) return undefined;
    answers.push(a);
  }
  return answers;
}

/** Strict host key checking · Ask: 처음 보는 호스트 키를 믿을지 묻는다 */
export async function askHostKey(host: string, fp: string): Promise<boolean> {
  const trust = 'Trust and Connect';
  const ok = await vscode.window.showWarningMessage(
    `The authenticity of SSH host ${host} can't be established.`,
    { modal: true, detail: `Key fingerprint: ${fp}\n\nTrust it only if it matches the server's key. It will be added to ~/.ssh/known_hosts.` },
    trust,
  );
  return ok === trust;
}
