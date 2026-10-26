import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as path from 'node:path';
import { Client } from 'pg';
import { arrayCursor, emptyCursor } from './cursor';
import { introspectInfoSchema } from './infoSchema';
import { pgClientConfig } from './postgres';
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
  constructor(
    private readonly client: Client,
    private readonly readOnly: boolean,
    private readonly server?: ChildProcess,
  ) {}

  async execute(sql: string): Promise<QueryCursor> {
    // H2에는 세션 단위 읽기 전용 명령이 없다.
    if (this.readOnly && !/^\s*(select|with|explain|values|show)\b/i.test(sql)) {
      throw new Error('Connection is read-only.');
    }
    const result = await this.client.query({ text: sql, rowMode: 'array' });
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
      this.server?.kill();
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
async function launchFileServer(jar: string, dbFile: string): Promise<{ server: ChildProcess; port: number; database: string }> {
  const baseDir = path.dirname(dbFile);
  const database = path.basename(dbFile).replace(/\.mv\.db$/i, '');
  const port = await freePort();
  const server = spawn('java', ['-cp', jar, 'org.h2.tools.Server', '-pg', '-pgPort', String(port), '-baseDir', baseDir, '-ifNotExists'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => fail(new Error(`H2 server did not start in time.\n${output}`)), 15000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (/PG server running/i.test(output)) {
        clearTimeout(timer);
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

export const h2Driver: Driver = {
  id: 'h2',
  label: 'H2',
  defaultPort: 5435,
  quote: '"',
  defaultSchema: () => 'PUBLIC',

  async connect(cfg: ConnectionConfig, opts: ConnectOptions) {
    let server: ChildProcess | undefined;
    let target = cfg;
    if (cfg.file) {
      if (!opts.h2Jar) throw new Error('Set "bindb.h2.jarPath" to an h2-*.jar to open H2 database files.');
      const launched = await launchFileServer(opts.h2Jar, cfg.file);
      server = launched.server;
      target = { ...cfg, host: '127.0.0.1', port: launched.port, database: launched.database };
    }
    const client = new Client({ ...pgClientConfig(target, opts), port: target.port ?? 5435 });
    try {
      await client.connect();
    } catch (e) {
      server?.kill();
      throw e;
    }
    return new H2Session(client, !!cfg.readOnly, server);
  },

  introspect(session) {
    return introspectInfoSchema(session, `table_schema <> 'INFORMATION_SCHEMA'`);
  },
};
