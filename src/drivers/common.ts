import { readFileSync } from 'node:fs';
import * as nodeTls from 'node:tls';
import { rootCertificates } from 'node:tls';

/** OS 인증서 저장소(Node 22.15+의 tls.getCACertificates('system')) */
function systemCertificates(): string[] {
  const get = (nodeTls as unknown as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  if (!get) throw new Error('The system truststore needs a newer VS Code (Node.js 22.15 or later).');
  return get('system');
}
import { homedir } from 'node:os';
import * as path from 'node:path';
import { parseUrl } from '../core/connectionDraft';
import type { ConnectionConfig, ConnectOptions, SharedSshConfig, SslMode } from './types';

/** 공유 SSH 설정을 가리키면 그 값으로 채운다(사용 여부 · 로컬 포트는 데이터 소스 것) */
export function resolveSharedSsh(cfg: ConnectionConfig, shared: readonly SharedSshConfig[]): ConnectionConfig {
  const id = cfg.ssh?.configId;
  if (!id) return cfg;
  const s = shared.find((x) => x.id === id);
  if (!s) throw new Error(`SSH configuration ${id} no longer exists. Choose another one in the SSH/SSL tab.`);
  const { id: _id, name: _name, ...rest } = s;
  return { ...cfg, ssh: { ...rest, enabled: cfg.ssh!.enabled, localPort: cfg.ssh!.localPort, configId: id } };
}

/** SSH 비밀 값(비밀번호 · 키 암호)을 둔 키: 공유 설정이면 그 설정 id, 아니면 데이터 소스 id */
export const sshSecretOwner = (cfg: Pick<ConnectionConfig, 'id' | 'ssh'>) => cfg.ssh?.configId ?? cfg.id;

/**
 * 드라이버가 실제로 접속할 설정. Connection type이 URL only면 URL을 풀어 칸 값으로 바꾼다.
 * URL에 비밀번호가 있고 따로 받은 비밀번호가 없으면 URL의 것을 쓴다.
 */
export function resolveTarget(cfg: ConnectionConfig, opts: ConnectOptions): { cfg: ConnectionConfig; password?: string } {
  if (cfg.connectionType !== 'url' || !cfg.url) return { cfg, password: passwordFor(cfg, opts.password) };
  if (cfg.driver === 'sqlite' || (cfg.driver === 'h2' && /^(jdbc:)?h2:(?!tcp:|ssl:|mem:)/i.test(cfg.url))) {
    // jdbc:sqlite:x.db?mode=ro · jdbc:h2:~/db;MODE=… → 파일 경로만. ~는 홈 폴더로
    let file = cfg.url.replace(/^jdbc:/i, '').replace(/^(sqlite|h2):(file:)?/i, '').replace(/[?;].*$/, '');
    if (cfg.driver === 'h2' && !/\.mv\.db$/i.test(file)) file += '.mv.db';
    file = file.replace(/^~(?=\/|$)/, homedir());
    return { cfg: { ...cfg, file }, password: passwordFor(cfg, opts.password) };
  }
  // H2의 tcp · ssl · mem URL은 JDBC URL 그대로 쓴다(h2JdbcUrl) — PostgreSQL URL로 읽지 않는다
  if (cfg.driver === 'h2') return { cfg, password: passwordFor(cfg, opts.password) };
  const parsed = parseUrl(cfg.url, cfg.driver === 'mysql' ? 'mysql' : 'postgres');
  if (!parsed.ok) throw new Error(`Connection URL: ${parsed.error}`);
  const p = parsed.patch;
  return {
    cfg: {
      ...cfg,
      host: p.host || 'localhost',
      port: p.port ? Number(p.port) : undefined,
      database: p.database || undefined,
      user: p.user ?? cfg.user,
      ssl: p.ssl ?? cfg.ssl,
    },
    password: passwordFor(cfg, opts.password ?? parsed.password),
  };
}

/** Authentication: none이면 비밀번호를 보내지 않는다 */
function passwordFor(cfg: ConnectionConfig, password: string | undefined): string | undefined {
  return cfg.auth === 'none' ? undefined : password;
}

/** Working directory 기준으로 상대 경로를 푼다(DataGrip Advanced · Working directory) */
export function resolvePath(cfg: ConnectionConfig, file: string): string {
  return path.isAbsolute(file) || !cfg.workingDirectory ? file : path.resolve(cfg.workingDirectory, file);
}

/** 실제로 쓸 검사 수준. libpq처럼 require + CA 파일은 verify-ca다 */
export function effectiveSslMode(cfg: Pick<ConnectionConfig, 'ssl' | 'sslCaFile'>): SslMode {
  const mode = cfg.ssl ?? 'disable';
  return mode === 'require' && cfg.sslCaFile ? 'verify-ca' : mode;
}

/** prefer로 SSL을 시도했는데 서버가 SSL을 지원하지 않는다는 오류인가(그러면 평문으로 다시 붙는다) */
export function isSslUnsupported(e: unknown): boolean {
  // pg: "The server does not support SSL connections" · mysql2: "Server does not support secure connection"
  return /does not support (SSL|secure) connection/i.test(String((e as Error)?.message ?? e));
}

/** SSL 설정(인증서 · 키 파일 포함). 꺼져 있으면 undefined */
export function tlsOptions(cfg: ConnectionConfig, opts: ConnectOptions): Record<string, unknown> | undefined {
  if (!cfg.ssl || cfg.ssl === 'disable') return undefined;
  const read = (file?: string) => (file ? readFileSync(resolvePath(cfg, file)) : undefined);
  const ca = read(cfg.sslCaFile);
  const mode = effectiveSslMode(cfg);
  const tls: Record<string, unknown> = { rejectUnauthorized: mode === 'verify' || mode === 'verify-ca' };
  // verify-ca: 체인만 검사하고 호스트 이름은 보지 않는다
  if (mode === 'verify-ca') tls.checkServerIdentity = () => undefined;
  const cert = read(cfg.sslCertFile);
  const key = read(cfg.sslKeyFile);
  // Use truststore: CA 파일에 더해 Node 내장 목록 · OS 저장소를 믿는다. 기본(둘 다, CA 파일 없음)이면 Node 기본값 그대로
  const store = cfg.sslTruststore ?? { bundled: true, system: true };
  if (ca || !store.bundled || !store.system) {
    const list: (string | Buffer)[] = [];
    if (ca) list.push(ca);
    if (store.bundled) list.push(...rootCertificates);
    if (store.system) list.push(...systemCertificates());
    tls.ca = list;
  }
  if (cert) tls.cert = cert;
  if (key) tls.key = key;
  if (key && opts.sslKeyPassword) tls.passphrase = opts.sslKeyPassword;
  // 터널을 거치면 접속 대상이 127.0.0.1이 된다 — 인증서는 실제 호스트 이름으로 확인한다
  if (opts.realTarget) tls.servername = opts.realTarget.host;
  return tls;
}

/** Advanced · 드라이버 옵션. 숫자 · 참거짓으로 보이는 값은 그 형으로 넘긴다 */
export function driverOptionValues(cfg: ConnectionConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg.driverOptions ?? {})) {
    out[k] = v === 'true' ? true : v === 'false' ? false : v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
  }
  return out;
}
