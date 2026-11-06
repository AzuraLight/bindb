import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import * as path from 'node:path';
import { Client } from 'pg';
import { arrayCursor, emptyCursor } from './cursor';
import { introspectInfoSchema } from './infoSchema';
import { classifySql } from '../core/classify';
import { resolvePath, resolveTarget } from './common';
import { pgClientConfig, rawDateTypes } from './postgres';
import type { ConnectionConfig, ConnectOptions, Driver, QueryCursor, Session } from './types';

/**
 * H2는 자바 DB라 Node 드라이버가 없다. 대신 H2가 내장한 PostgreSQL 와이어 프로토콜
 * 서버(-pg)에 pg 클라이언트로 붙는다.
 *  - 서버 모드: 이미 떠 있는 `org.h2.tools.Server -pg`에 접속(기본 포트 5435)
 *  - 파일 모드: cfg.file(.mv.db)을 열기 위해 h2 jar로 PG 서버를 직접 띄운다
 *
 * H2의 PG 서버는 포털을 나눠 읽는 확장 프로토콜을 제대로 지원하지 않아서
 * pg-cursor 대신 단순 쿼리로 전체 결과를 받는다.
 */
class H2Session implements Session {
  private lostListeners: ((e: Error) => void)[] = [];
  constructor(
    private readonly client: Client,
    private readonly readOnly: boolean,
    private readonly release?: () => void,
  ) {
    client.on('error', (e) => this.lostListeners.forEach((l) => l(e)));
    client.on('end', () => {
      // 연결이 끝나면(닫았든 끊겼든) 서버를 반납한다. release는 여러 번 불러도 한 번만 반영된다
      this.release?.();
      this.lostListeners.forEach((l) => l(new Error('The connection was closed.')));
    });
  }

  onLost(listener: (e: Error) => void): void {
    this.lostListeners.push(listener);
  }

  async execute(sql: string, params?: readonly unknown[]): Promise<QueryCursor> {
    // H2에는 세션 단위 읽기 전용 명령이 없다. 실행 전에 판정한다(여러 문장 · 파일 쓰기 함수 포함)
    if (this.readOnly) {
      const c = classifySql(sql, 'h2');
      if (c.kind === 'write') throw new Error(`Connection is read-only: ${c.reason ?? 'this statement may change data'}.`);
    }
    const result = await this.client.query({ text: sql, rowMode: 'array', types: rawDateTypes, ...(params?.length ? { values: [...params] } : {}) });
    if (!result.fields?.length) return emptyCursor(result.rowCount ?? undefined);
    return arrayCursor(
      result.fields.map((f) => ({ name: f.name })),
      result.rows as unknown[][],
    );
  }

  async cancel(): Promise<void> {
    // H2 PG 서버는 CancelRequest를 무시한다.
  }

  async close(): Promise<void> {
    try {
      await this.client.end();
    } finally {
      this.release?.();
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** h2 jar로 PG 서버를 띄우고, 포트가 열리면 돌려준다. */
/** VM options 문자열 → 인자 배열. 셸처럼 공백으로 나누고, 따옴표 안의 공백은 나누지 않으며 따옴표는 뺀다 */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  let has = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** VM environment(KEY=VALUE 줄) → 객체 */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

async function launchFileServer(
  jar: string,
  dbFile: string,
  cfg: ConnectionConfig,
): Promise<{ server: ChildProcess; port: number; database: string }> {
  const baseDir = path.dirname(dbFile);
  const database = path.basename(dbFile).replace(/\.mv\.db$/i, '');
  const port = await freePort();
  // Advanced 탭: VM options는 java 인자 앞에, VM environment는 환경 변수에, Working directory는 작업 폴더로
  const args = [...splitArgs(cfg.vmOptions ?? ''), '-cp', jar, 'org.h2.tools.Server', '-pg', '-pgPort', String(port), '-baseDir', baseDir];
  const server = spawn('java', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...parseEnv(cfg.vmEnvironment ?? '') },
    cwd: cfg.workingDirectory || undefined,
  });

  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => fail(new Error(`H2 server did not start in time.\n${output}`)), 15000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (/PG server running/i.test(output)) {
        clearTimeout(timer);
        // 뜬 뒤에는 출력을 모으지 않는다(계속 자라지 않게). 흘려 버려야 파이프가 막히지 않는다
        server.stdout!.off('data', onData);
        server.stderr!.off('data', onData);
        server.stdout!.resume();
        server.stderr!.resume();
        output = '';
        resolve();
      }
    };
    function fail(err: Error) {
      clearTimeout(timer);
      server.kill();
      reject(err);
    }
    server.stdout!.on('data', onData);
    server.stderr!.on('data', onData);
    server.once('error', (e) => fail(new Error(`Could not run java: ${e.message}`)));
    server.once('exit', (code) => fail(new Error(`H2 server exited (code ${code}).\n${output}`)));
  });
  return { server, port, database };
}

/** 실행 중인 H2 서버(파일 · jar · VM 설정이 같으면 함께 쓴다). 마지막 세션이 놓으면 끈다 */
const servers = new Map<string, { started: Promise<{ server: ChildProcess; port: number; database: string }>; refs: number }>();
/** 띄운 H2 서버 전부(확장 프로세스가 끝날 때 끈다 — 남겨 두면 VS Code를 꺼도 java가 돈다) */
const launchedServers = new Set<ChildProcess>();
process.once('exit', () => {
  for (const s of launchedServers) s.kill();
});

/** 확장을 끌 때(deactivate) 부른다 */
export function stopAllH2Servers(): void {
  for (const s of launchedServers) s.kill();
  launchedServers.clear();
  servers.clear();
}

async function acquireServer(jar: string, file: string, cfg: ConnectionConfig): Promise<{ port: number; database: string; release: () => void }> {
  const key = JSON.stringify([jar, file, cfg.vmOptions ?? '', cfg.vmEnvironment ?? '', cfg.workingDirectory ?? '']);
  let entry = servers.get(key);
  if (!entry) {
    const started = launchFileServer(jar, file, cfg);
    const created = { started, refs: 0 };
    entry = created;
    servers.set(key, created);
    started.then(
      ({ server }) => {
        launchedServers.add(server);
        server.once('exit', () => {
          launchedServers.delete(server);
          if (servers.get(key) === created) servers.delete(key);
        });
      },
      () => servers.get(key) === created && servers.delete(key),
    );
  }
  entry.refs++;
  let launched;
  try {
    launched = await entry.started;
  } catch (e) {
    entry.refs--;
    throw e;
  }
  const e = entry;
  let released = false;
  return {
    port: launched.port,
    database: launched.database,
    release: () => {
      if (released) return;
      released = true;
      if (--e.refs <= 0) {
        if (servers.get(key) === e) servers.delete(key);
        launched.server.kill();
      }
    },
  };
}

export const h2Driver: Driver = {
  id: 'h2',
  label: 'H2',
  defaultPort: 5435,
  quote: '"',
  defaultSchema: () => 'PUBLIC',

  async connect(cfg: ConnectionConfig, opts: ConnectOptions) {
    let release: (() => void) | undefined;
    let target = cfg;
    const resolved = resolveTarget(cfg, opts).cfg;
    if (resolved.file) {
      if (!opts.h2Jar) throw new Error('Set "bindb.h2.jarPath" to an h2-*.jar to open H2 database files.');
      // 없는 파일이면 빈 DB를 새로 만들지 않고 알린다(경로를 잘못 쓴 경우)
      if (!existsSync(resolvePath(cfg, resolved.file))) throw new Error(`H2 database file not found: ${resolvePath(cfg, resolved.file)}`);
      // 같은 파일은 H2 서버 하나를 함께 쓴다 — 파일을 두 서버가 열면 잠금에 걸린다
      const shared = await acquireServer(opts.h2Jar, resolvePath(cfg, resolved.file), cfg);
      release = shared.release;
      target = { ...cfg, host: '127.0.0.1', port: shared.port, database: shared.database };
    }
    const client = new Client({ ...pgClientConfig(target, opts), port: target.port ?? 5435 });
    try {
      await client.connect();
    } catch (e) {
      release?.();
      throw e;
    }
    return new H2Session(client, !!cfg.readOnly, release);
  },

  introspect(session, cfg) {
    // H2의 PG 서버는 이름을 소문자로 돌려주고 pg_catalog도 흉내 낸다. 대소문자 없이 거른다.
    return introspectInfoSchema(
      session,
      cfg.showSystemSchemas ? '1 = 1' : `UPPER(table_schema) NOT IN ('INFORMATION_SCHEMA', 'PG_CATALOG')`,
      cfg,
      (s) => /^(information_schema|pg_catalog)$/i.test(s),
    );
  },
};
