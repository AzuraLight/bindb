import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import * as path from 'node:path';
import { classifySql } from '../core/classify';
import { resolvePath, resolveTarget } from './common';
import { introspectInfoSchema } from './infoSchema';
import { openJdbc, stopAllBridges, type JdbcSession } from './jdbc/bridge';
import type { ConnectionConfig, ConnectOptions, Driver, QueryCursor, Session } from './types';

/**
 * H2: JDBC 연동 모듈(필요할 때만 띄우는 JVM)로 H2 JDBC 드라이버에 직접 붙는다 — DataGrip · DBeaver와 같은 방식.
 *  - Embedded(파일): jdbc:h2:file:<경로>;IFEXISTS=TRUE (없는 파일을 새로 만들지 않는다). .h2.db는 MV_STORE=FALSE
 *  - Remote: H2 TCP 서버 jdbc:h2:tcp://host:port/db (기본 포트 9092)
 *  - URL only: JDBC URL 그대로(jdbc:h2:mem:… 포함)
 * 예전에는 H2의 PostgreSQL 프로토콜 서버(-pg)를 거쳤는데, 그 서버는 DATABASE_TO_LOWER=TRUE를 강제로 걸어서
 * Java 앱이 기본 설정으로 만든 DB(스키마 PUBLIC)를 아예 열지 못했다(설계 점검 3번).
 * Advanced 탭: VM options · VM environment · Working directory는 JVM에, 드라이버 옵션은 URL의 ;KEY=VALUE로.
 */

/** 기본 JVM 옵션: 적은 메모리로 도는 GC. 사용자의 VM options가 뒤에 붙어 이긴다 */
const DEFAULT_VM_ARGS = ['-XX:+UseSerialGC'];

class H2Session implements Session {
  constructor(
    private readonly jdbc: JdbcSession,
    private readonly readOnly: boolean,
  ) {}

  onLost(listener: (e: Error) => void): void {
    this.jdbc.onLost(listener);
  }

  async execute(sql: string, params?: readonly unknown[]): Promise<QueryCursor> {
    // H2에는 세션 단위 읽기 전용 명령이 없다. 실행 전에 판정한다(여러 문장 · 파일 쓰기 함수 포함)
    if (this.readOnly) {
      const c = classifySql(sql, 'h2');
      if (c.kind === 'write') throw new Error(`Connection is read-only: ${c.reason ?? 'this statement may change data'}.`);
    }
    return this.jdbc.execute(sql, params);
  }

  cancel(): Promise<void> {
    return this.jdbc.cancel();
  }

  close(): Promise<void> {
    return this.jdbc.close();
  }
}

/** 연결 설정 → JDBC URL */
export function h2JdbcUrl(cfg: ConnectionConfig, opts: ConnectOptions = {}): string {
  const settings = Object.entries(cfg.driverOptions ?? {})
    .filter(([k]) => k.trim())
    .map(([k, v]) => `;${k.trim()}=${v}`)
    .join('');
  if (cfg.connectionType === 'url' && cfg.url) {
    const url = cfg.url.trim();
    return (/^jdbc:/i.test(url) ? url : `jdbc:${url}`) + settings;
  }
  const file = resolveTarget(cfg, opts).cfg.file;
  if (file) {
    const full = resolvePath(cfg, file);
    // .h2.db = H2 1.3/1.4 PageStore(DataGrip의 Embedded 템플릿과 같은 MV_STORE=FALSE)
    if (/\.h2\.db$/i.test(full)) return `jdbc:h2:file:${full.replace(/\.h2\.db$/i, '')};MV_STORE=FALSE;IFEXISTS=TRUE${settings}`;
    return `jdbc:h2:file:${full.replace(/\.mv\.db$/i, '')};IFEXISTS=TRUE${settings}`;
  }
  const db = (cfg.database ?? '').trim();
  if (!db) throw new Error('Set the H2 database (for example ~/test) for a remote connection.');
  return `jdbc:h2:tcp://${cfg.host || 'localhost'}:${cfg.port ?? 9092}/${db}${settings}`;
}

/**
 * H2 jar와 DB 파일의 형식이 맞는가. jar는 자기 형식만 연다(H2 1.4.200 · 2.1.214 · 2.3.232로 확인):
 *   H2 1.4.x → format:1 · 2.0–2.1 → format:2 · 2.2 이상 → format:3 (.mv.db 첫 줄의 format:N)
 * .h2.db는 H2 1.3/1.4의 PageStore 파일이다. 맞지 않으면 사람이 읽을 이유를, 맞거나 알 수 없으면 undefined.
 */
export function h2FileProblem(file: string, jar: string, header = readHeader(file)): string | undefined {
  const v = /h2-(\d+)\.(\d+)\.(\d+)/i.exec(path.basename(jar));
  if (/\.h2\.db$/i.test(file)) {
    // 1.4 jar는 MV_STORE=FALSE로 PageStore를 연다(h2JdbcUrl). 2.x는 못 연다
    if (!v || Number(v[1]) < 2) return undefined;
    return `${path.basename(file)} is an H2 1.3/1.4 PageStore file. Open it with an H2 1.4.x jar (1.4.200), or migrate it to a .mv.db file with H2's SCRIPT / RUNSCRIPT.`;
  }
  const format = Number(/format:(\d+)/.exec(header)?.[1]);
  if (!format || !v) return undefined;
  const [major, minor] = [Number(v[1]), Number(v[2])];
  const jarFormat = major < 2 ? 1 : minor < 2 ? 2 : 3;
  if (format === jarFormat) return undefined;
  const need = format === 1 ? '1.4.200' : format === 2 ? '2.1.214' : '2.2 or later (for example 2.3.232)';
  return `${path.basename(file)} uses H2 file format ${format}, but ${path.basename(jar)} only opens format ${jarFormat}. Use an H2 ${need} jar (Drivers → H2 → Download), or migrate the file with SCRIPT / RUNSCRIPT.`;
}

function readHeader(file: string): string {
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(256);
      return buf.subarray(0, readSync(fd, buf, 0, 256, 0)).toString('latin1');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

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

/** 확장을 끌 때(deactivate) 부른다 */
export function stopAllH2Servers(): void {
  stopAllBridges();
}

export const h2Driver: Driver = {
  id: 'h2',
  label: 'H2',
  defaultPort: 9092,
  quote: '"',
  defaultSchema: () => 'PUBLIC',

  async connect(cfg: ConnectionConfig, opts: ConnectOptions) {
    if (!opts.h2Jar) throw new Error('Set the H2 driver jar (Drivers → H2, or "bindb.h2.jarPath") to connect to H2.');
    const { cfg: resolved, password } = resolveTarget(cfg, opts);
    if (resolved.file) {
      const file = resolvePath(cfg, resolved.file);
      const exists = existsSync(file);
      // Embedded: 없는 파일이면 빈 DB를 새로 만들지 않고 알린다(경로를 잘못 쓴 경우). URL only는 URL을 따른다(IFEXISTS)
      if (!exists && cfg.connectionType !== 'url') throw new Error(`H2 database file not found: ${file}`);
      // jar가 그 파일 형식을 못 열면 H2 오류가 알아보기 어렵다 — 먼저 알린다
      const problem = exists ? h2FileProblem(file, opts.h2Jar) : undefined;
      if (problem) throw new Error(problem);
    }
    const open = (url: string) =>
      openJdbc(
        {
          vmArgs: [...DEFAULT_VM_ARGS, ...splitArgs(cfg.vmOptions ?? '')],
          env: parseEnv(cfg.vmEnvironment ?? ''),
          cwd: cfg.workingDirectory || undefined,
        },
        {
          jars: [opts.h2Jar!],
          driver: 'org.h2.Driver',
          url,
          props: { user: resolved.user ?? cfg.user ?? '', password: password ?? '' },
          readOnly: !!cfg.readOnly,
        },
      );
    const url = h2JdbcUrl(cfg, opts);
    let jdbc: JdbcSession;
    try {
      jdbc = await open(url);
    } catch (e) {
      // 다른 프로그램(앱)이 Embedded로 연 파일 — 함께 쓰는 방법을 알려 준다
      if (/already in use/i.test((e as Error).message) && !/AUTO_SERVER/i.test(url)) {
        throw new Error(`${(e as Error).message.split('\n')[0]}\nAnother program has this H2 file open. To use it from both, add AUTO_SERVER=TRUE to that program's URL and to this data source (Advanced → driver options).`);
      }
      // PostgreSQL 모드(이름을 소문자로)로 만든 DB — 예전 BindB가 H2 PG 서버로 만든 파일이 이렇다.
      // 기본 설정으로 열면 스키마 public을 못 찾는다. 그 서버가 걸던 설정 그대로 다시 연다
      if (!resolved.file || /DATABASE_TO_LOWER/i.test(url) || !/Schema "public" not found/.test((e as Error).message)) throw e;
      jdbc = await open(`${url};MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DEFAULT_NULL_ORDERING=HIGH`);
    }
    return new H2Session(jdbc, !!cfg.readOnly);
  },

  introspect(session, cfg) {
    // PG 모드로 만든 DB에는 pg_catalog도 있다. 대소문자 없이 거른다.
    return introspectInfoSchema(
      session,
      cfg.showSystemSchemas ? '1 = 1' : `UPPER(table_schema) NOT IN ('INFORMATION_SCHEMA', 'PG_CATALOG')`,
      cfg,
      (s) => /^(information_schema|pg_catalog)$/i.test(s),
    );
  },
};
