import type { AuthMode, ConnectionConfig, DriverId, IsolationLevel, PasswordSave, SslMode } from '../drivers/types';
import { classifySql } from './classify';

/**
 * 연결 폼의 입력값 ↔ ConnectionConfig. vscode나 드라이버에 기대지 않아 테스트에서 바로 쓴다.
 * 폼은 모든 값을 문자열로 다룬다(빈 칸 = 지정 안 함).
 */
export interface ConnectionForm {
  name: string;
  comment: string;
  driver: DriverId;
  /** h2만: 떠 있는 서버에 붙을지, .mv.db 파일을 열지 */
  h2Mode: 'server' | 'file';
  host: string;
  port: string;
  database: string;
  user: string;
  file: string;
  ssl: SslMode;
  /** 초 */
  connectTimeout: string;
  readOnly: boolean;
  /** General 외 탭(Options · SSH/SSL · Schemas · Advanced)과 인증 · URL only */
  adv: AdvancedForm;
}

/** 폼 칸 그대로(숫자도 문자열). 체크박스로 켜고 끄는 칸은 *On 짝을 둔다(DataGrip처럼 값은 꺼도 남는다). */
export interface AdvancedForm {
  connectionType: 'default' | 'url';
  url: string;
  auth: AuthMode;
  passwordSave: PasswordSave;
  scope: 'global' | 'project';

  transactionControl: 'auto' | 'manual';
  /** '' = DB 기본값 */
  isolation: '' | IsolationLevel;
  switchSchema: 'automatic' | 'manual' | 'disable';
  timeZone: string;
  /** General · Create database (H2 Embedded) */
  createDatabase: boolean;
  keepAliveOn: boolean;
  keepAlive: string;
  keepAliveQuery: string;
  autoDisconnectOn: boolean;
  autoDisconnect: string;
  singleDatabase: boolean;
  sessionControl: 'single' | 'two' | 'dedicated';
  startupScript: string;

  autoSync: boolean;
  warnOutdatedDdl: boolean;
  loadSources: 'all' | 'nonSystem' | 'none';
  introspectOn: boolean;
  introspectInterval: string;
  trackSchemas: boolean;
  /** '' = 자동(스키마의 객체 수로) */
  introspectionLevel: '' | '1' | '2' | '3';
  /** 탐색기에서 스키마마다 지정한 수준(패널에서는 고치지 않고 그대로 저장한다) */
  schemaLevels: Record<string, 1 | 2 | 3>;
  preIntrospected: boolean;
  virtualObjectsFile: string;

  sslCaFile: string;
  sslCertFile: string;
  sslKeyFile: string;

  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshAuth: 'password' | 'key' | 'agent';
  sshKeyFile: string;
  sshLocalPort: string;
  /** 공유 SSH 설정 id. 빈 문자열 = 이 데이터 소스만의 설정 */
  sshConfigId: string;
  sshParseConfig: boolean;
  /** 초. 빈 문자열 = 끔 */
  sshKeepAlive: string;
  sshStrict: 'yes' | 'acceptNew' | 'no' | 'ask';
  sslTrustBundled: boolean;
  sslTrustSystem: boolean;

  schemaPattern: string;
  objectFilter: string;
  showSystemSchemas: boolean;
  showTemplateDatabases: boolean;

  /** readOnly: '' = 데이터 소스 값, on · off = 덮어씀. auth: '' = 데이터 소스 값 */
  sessionTemplates: { name: string; auth: '' | AuthMode; user: string; readOnly: '' | 'on' | 'off'; startupScript: string; driverFile: string }[];
  useSessionTemplate: string;
  /** 줄마다 작업 이름 하나 */
  beforeConnection: string;
  keywordCase: 'upper' | 'lower';
  quoteIdentifiers: 'always' | 'needed';
  color: string;

  kind: 'db' | 'ddl';
  ddlFolder: string;
  /** 맞출 DDL data source id. 빈 문자열 = 없음 */
  ddlMapping: string;
  /** 쉼표로 나눈 스키마 */
  ddlScope: string;

  driverOptions: { key: string; value: string }[];
  vmOptions: string;
  vmEnvironment: string;
  workingDirectory: string;
  /** Introspect using JDBC metadata(H2) */
  introspectJdbc: boolean;
}

export function emptyAdvanced(): AdvancedForm {
  return {
    connectionType: 'default',
    url: '',
    auth: 'password',
    passwordSave: 'forever',
    scope: 'global',
    transactionControl: 'auto',
    isolation: '',
    switchSchema: 'manual',
    timeZone: '',
    createDatabase: false,
    keepAliveOn: false,
    keepAlive: '60',
    keepAliveQuery: '',
    autoDisconnectOn: false,
    autoDisconnect: '300',
    singleDatabase: false,
    sessionControl: 'single',
    startupScript: '',
    autoSync: true,
    warnOutdatedDdl: true,
    loadSources: 'nonSystem',
    introspectOn: false,
    introspectInterval: '10',
    trackSchemas: true,
    introspectionLevel: '',
    schemaLevels: {},
    preIntrospected: true,
    virtualObjectsFile: '',
    sslCaFile: '',
    sslCertFile: '',
    sslKeyFile: '',
    sshEnabled: false,
    sshHost: '',
    sshPort: '22',
    sshUser: '',
    sshAuth: 'password',
    sshKeyFile: '',
    sshLocalPort: '',
    sshConfigId: '',
    sshParseConfig: false,
    sshKeepAlive: '',
    sshStrict: 'ask',
    sslTrustBundled: true,
    sslTrustSystem: true,
    schemaPattern: '',
    objectFilter: '',
    showSystemSchemas: false,
    showTemplateDatabases: false,
    sessionTemplates: [],
    useSessionTemplate: '',
    beforeConnection: '',
    keywordCase: 'upper',
    quoteIdentifiers: 'always',
    color: '',
    kind: 'db',
    ddlFolder: '',
    ddlMapping: '',
    ddlScope: '',
    driverOptions: [],
    vmOptions: '',
    vmEnvironment: '',
    workingDirectory: '',
    introspectJdbc: false,
  };
}

function advancedFromConfig(cfg: ConnectionConfig): AdvancedForm {
  const a = emptyAdvanced();
  const str = (n: number | undefined, fallback: string) => (n !== undefined ? String(n) : fallback);
  return {
    ...a,
    connectionType: cfg.connectionType ?? 'default',
    url: cfg.url ?? '',
    auth: cfg.auth ?? 'password',
    passwordSave: cfg.passwordSave ?? 'forever',
    scope: cfg.scope ?? 'global',
    transactionControl: cfg.transactionControl ?? 'auto',
    isolation: cfg.isolation ?? '',
    switchSchema: cfg.switchSchema ?? 'manual',
    timeZone: cfg.timeZone ?? '',
    createDatabase: !!cfg.createDatabase,
    keepAliveOn: cfg.keepAlive !== undefined,
    keepAlive: str(cfg.keepAlive, a.keepAlive),
    keepAliveQuery: cfg.keepAliveQuery ?? '',
    autoDisconnectOn: cfg.autoDisconnect !== undefined,
    autoDisconnect: str(cfg.autoDisconnect, a.autoDisconnect),
    singleDatabase: !!cfg.singleDatabase,
    sessionControl: cfg.sessionControl ?? 'single',
    startupScript: cfg.startupScript ?? '',
    autoSync: cfg.autoSync ?? true,
    warnOutdatedDdl: cfg.warnOutdatedDdl ?? true,
    loadSources: cfg.loadSources ?? 'nonSystem',
    introspectOn: cfg.introspectInterval !== undefined,
    introspectInterval: str(cfg.introspectInterval, a.introspectInterval),
    trackSchemas: cfg.trackSchemas ?? true,
    introspectionLevel: (cfg.introspectionLevel ? String(cfg.introspectionLevel) : '') as AdvancedForm['introspectionLevel'],
    schemaLevels: { ...(cfg.schemaLevels ?? {}) },
    preIntrospected: cfg.preIntrospected ?? true,
    virtualObjectsFile: cfg.virtualObjectsFile ?? '',
    sslCaFile: cfg.sslCaFile ?? '',
    sslCertFile: cfg.sslCertFile ?? '',
    sslKeyFile: cfg.sslKeyFile ?? '',
    sshEnabled: !!cfg.ssh?.enabled,
    sshHost: cfg.ssh?.host ?? '',
    sshPort: str(cfg.ssh?.port, a.sshPort),
    sshUser: cfg.ssh?.user ?? '',
    sshAuth: cfg.ssh?.auth ?? 'password',
    sshKeyFile: cfg.ssh?.keyFile ?? '',
    sshLocalPort: str(cfg.ssh?.localPort, ''),
    sshConfigId: cfg.ssh?.configId ?? '',
    sshParseConfig: !!cfg.ssh?.parseConfig,
    sshKeepAlive: str(cfg.ssh?.keepAlive, ''),
    sshStrict: cfg.ssh?.strictHostKey ?? 'ask',
    sslTrustBundled: cfg.sslTruststore?.bundled ?? true,
    sslTrustSystem: cfg.sslTruststore?.system ?? true,
    schemaPattern: cfg.schemaPattern ?? '',
    objectFilter: cfg.objectFilter ?? '',
    showSystemSchemas: !!cfg.showSystemSchemas,
    showTemplateDatabases: !!cfg.showTemplateDatabases,
    sessionTemplates: (cfg.sessionTemplates ?? []).map((t) => ({
      name: t.name,
      auth: t.auth ?? '',
      user: t.user ?? '',
      readOnly: t.readOnly === undefined ? '' : t.readOnly ? 'on' : 'off',
      startupScript: t.startupScript ?? '',
      driverFile: t.driverFile ?? '',
    })),
    useSessionTemplate: cfg.useSessionTemplate ?? '',
    beforeConnection: (cfg.beforeConnection ?? []).join('\n'),
    keywordCase: cfg.codeStyle?.keywordCase ?? 'upper',
    quoteIdentifiers: cfg.codeStyle?.quoteIdentifiers ?? 'always',
    color: cfg.color ?? '',
    kind: cfg.kind ?? 'db',
    ddlFolder: cfg.ddlFolder ?? '',
    ddlMapping: cfg.ddlMapping?.ddl ?? '',
    ddlScope: (cfg.ddlMapping?.scope ?? []).join(', '),
    driverOptions: Object.entries(cfg.driverOptions ?? {}).map(([key, value]) => ({ key, value })),
    vmOptions: cfg.vmOptions ?? '',
    vmEnvironment: cfg.vmEnvironment ?? '',
    workingDirectory: cfg.workingDirectory ?? '',
    introspectJdbc: !!cfg.introspectJdbc,
  };
}

export const DRIVER_LABELS: Record<DriverId, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL / MariaDB',
  sqlite: 'SQLite',
  h2: 'H2',
};

export const DEFAULT_PORT: Partial<Record<DriverId, number>> = { postgres: 5432, mysql: 3306, h2: 9092 };
export const DEFAULT_USER: Partial<Record<DriverId, string>> = { postgres: 'postgres', mysql: 'root', h2: 'sa' };
export const DEFAULT_TIMEOUT_SECONDS = 10;

/** 이 드라이버와 모드에서 보여 줄 칸 */
export function fieldsFor(driver: DriverId, h2Mode: ConnectionForm['h2Mode']) {
  const file = driver === 'sqlite' || (driver === 'h2' && h2Mode === 'file');
  return {
    file,
    server: !file,
    credentials: driver !== 'sqlite',
    ssl: driver === 'postgres' || driver === 'mysql',
    timeout: driver !== 'sqlite',
  };
}

export function emptyForm(driver: DriverId = 'postgres'): ConnectionForm {
  return {
    name: '',
    comment: '',
    driver,
    h2Mode: 'server',
    host: 'localhost',
    port: '',
    database: '',
    user: DEFAULT_USER[driver] ?? '',
    file: '',
    ssl: 'disable',
    connectTimeout: '',
    readOnly: false,
    adv: emptyAdvanced(),
  };
}

export function formFromConfig(cfg: ConnectionConfig): ConnectionForm {
  return {
    name: cfg.name,
    comment: cfg.comment ?? '',
    driver: cfg.driver,
    h2Mode: cfg.driver === 'h2' && cfg.file ? 'file' : 'server',
    host: cfg.host ?? '',
    port: cfg.port !== undefined ? String(cfg.port) : '',
    database: cfg.database ?? '',
    user: cfg.user ?? '',
    file: cfg.file ?? '',
    ssl: cfg.ssl ?? 'disable',
    connectTimeout: cfg.connectTimeout !== undefined ? String(cfg.connectTimeout) : '',
    readOnly: !!cfg.readOnly,
    adv: advancedFromConfig(cfg),
  };
}

/** 파일 이름이나 db@host로 이름을 제안한다 */
export function suggestName(form: ConnectionForm): string {
  if (form.adv.kind === 'ddl') return `${(form.adv.ddlFolder.split(/[\\/]/).filter(Boolean).pop() ?? 'ddl')} (DDL)`;
  const f = fieldsFor(form.driver, form.h2Mode);
  if (f.file) {
    const base = form.file.split(/[\\/]/).pop() ?? '';
    return base.replace(/\.(mv\.db|sqlite3?|db3?)$/i, '');
  }
  return `${form.database.trim() || form.driver}@${form.host.trim() || 'localhost'}`;
}

/** 칸 이름 → 오류. 기본 칸(keyof ConnectionForm)과 adv 칸(keyof AdvancedForm) 이름을 같이 쓴다 */
export type FormErrors = Partial<Record<keyof ConnectionForm | keyof AdvancedForm, string>>;

export type BuildResult =
  /** urlPassword: URL only의 URL에 들어 있던 비밀번호(설정에 남기지 않고 키체인으로 옮긴다) */
  | { ok: true; config: Omit<ConnectionConfig, 'id'>; urlPassword?: string }
  | { ok: false; errors: FormErrors };

/**
 * 폼을 검사해 저장할 설정을 만든다.
 * @param others 이름 중복 검사용 다른 연결들(편집 중인 연결은 빼고 넘긴다)
 */
export function buildConfig(form: ConnectionForm, others: readonly { name: string }[]): BuildResult {
  const errors: FormErrors = {};
  const f = fieldsFor(form.driver, form.h2Mode);
  const name = form.name.trim();

  if (!name) errors.name = 'Enter a name.';
  else if (others.some((o) => o.name.trim().toLowerCase() === name.toLowerCase())) {
    errors.name = `A connection named "${name}" already exists.`;
  }

  const config: Omit<ConnectionConfig, 'id'> = { name, driver: form.driver };
  let urlPassword: string | undefined;
  const a = form.adv;
  if (a.kind === 'ddl') {
    // DDL data source: SQL 파일 폴더와 방언(driver)만
    if (!a.ddlFolder.trim()) errors.ddlFolder = 'Choose the folder with the DDL files.';
    config.kind = 'ddl';
    config.ddlFolder = a.ddlFolder.trim();
    if (form.comment.trim()) config.comment = form.comment.trim();
    if (a.scope === 'project') config.scope = 'project';
    return Object.keys(errors).length ? { ok: false, errors } : { ok: true, config };
  }
  const urlOnly = a.connectionType === 'url';

  if (urlOnly) {
    const url = a.url.trim();
    if (!url) errors.url = 'Enter a URL.';
    else if (form.driver === 'postgres' || form.driver === 'mysql') {
      const r = parseUrl(url, form.driver);
      if (!r.ok) errors.url = r.error;
    }
    config.connectionType = 'url';
    // 비밀번호가 든 URL은 설정 파일(저장소에 커밋될 수 있다)에 그대로 두지 않는다
    const stripped = stripUrlPassword(url);
    config.url = stripped.url;
    if (stripped.password !== undefined) urlPassword = stripped.password;
  } else if (f.file) {
    const file = form.file.trim();
    if (!file) errors.file = 'Choose a database file.';
    else if (form.driver === 'h2' && !/\.(mv|h2)\.db$/i.test(file)) errors.file = 'Choose an H2 .mv.db (or 1.4 .h2.db) file.';
    config.file = file;
  } else {
    const host = form.host.trim();
    if (!host) errors.host = 'Enter a host.';
    config.host = host;
    const port = form.port.trim();
    if (port) {
      const n = Number(port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) errors.port = 'Port must be a whole number from 1 to 65535.';
      else config.port = n;
    }
    if (form.database.trim()) config.database = form.database.trim();
  }

  if (f.credentials && a.auth !== 'none' && form.user.trim()) config.user = form.user.trim();
  if (f.credentials) {
    if (a.auth !== 'password') config.auth = a.auth;
    if (a.auth === 'password' && a.passwordSave !== 'forever') config.passwordSave = a.passwordSave;
  }
  if (f.ssl && form.ssl !== 'disable') config.ssl = form.ssl;

  if (f.timeout) {
    const t = form.connectTimeout.trim();
    if (t) {
      const n = Number(t);
      if (!Number.isInteger(n) || n < 1 || n > 600) errors.connectTimeout = 'Timeout must be 1–600 seconds.';
      else config.connectTimeout = n;
    }
  }

  if (form.readOnly) config.readOnly = true;
  if (form.comment.trim()) config.comment = form.comment.trim();
  if (a.ddlMapping) {
    const scope = a.ddlScope.split(',').map((s) => s.trim()).filter(Boolean);
    config.ddlMapping = { ddl: a.ddlMapping, ...(scope.length ? { scope } : {}) };
  }
  buildAdvanced(form, config, errors);

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, config, ...(urlPassword !== undefined ? { urlPassword } : {}) };
}

/** URL 칸을 보여 줄 드라이버(서버형만) */
export function hasUrl(form: ConnectionForm): boolean {
  return fieldsFor(form.driver, form.h2Mode).server;
}

/** 폼 → 연결 URL(비밀번호는 넣지 않는다) */
/** URL의 sslmode(libpq) · ssl-mode(MySQL) ↔ BindB SSL 모드. allow(평문 먼저, 안 되면 SSL)는 둘 다 시도하는 prefer로 */
const PG_SSLMODE: Record<Exclude<SslMode, 'disable'>, string> = { prefer: 'prefer', require: 'require', 'verify-ca': 'verify-ca', verify: 'verify-full' };
const MYSQL_SSLMODE: Record<Exclude<SslMode, 'disable'>, string> = { prefer: 'PREFERRED', require: 'REQUIRED', 'verify-ca': 'VERIFY_CA', verify: 'VERIFY_IDENTITY' };
const SSLMODE_FROM_URL: Record<string, SslMode> = {
  disable: 'disable',
  disabled: 'disable',
  allow: 'prefer',
  prefer: 'prefer',
  preferred: 'prefer',
  require: 'require',
  required: 'require',
  'verify-ca': 'verify-ca',
  verify_ca: 'verify-ca',
  'verify-full': 'verify',
  verify_identity: 'verify',
};

export function toUrl(form: ConnectionForm): string {
  const scheme = form.driver === 'mysql' ? 'mysql' : 'postgresql';
  const user = form.user.trim() ? `${encodeURIComponent(form.user.trim())}@` : '';
  const host = form.host.trim() || 'localhost';
  const port = form.port.trim() || String(DEFAULT_PORT[form.driver] ?? '');
  const db = form.database.trim() ? `/${encodeURIComponent(form.database.trim())}` : '';
  const ssl =
    form.ssl === 'disable' || (form.driver !== 'postgres' && form.driver !== 'mysql')
      ? ''
      : form.driver === 'postgres'
        ? `?sslmode=${PG_SSLMODE[form.ssl]}`
        : `?ssl-mode=${MYSQL_SSLMODE[form.ssl]}`;
  return `${scheme}://${user}${host}${port ? `:${port}` : ''}${db}${ssl}`;
}

export type ParsedUrl =
  | { ok: true; patch: Partial<Pick<ConnectionForm, 'host' | 'port' | 'database' | 'user' | 'ssl'>>; password?: string }
  | { ok: false; error: string };

/**
 * 붙여 넣은 URL → 폼 칸. postgres(ql):// · mysql:// 과 앞에 붙은 jdbc: 를 받는다.
 * 지금 드라이버와 다른 스킴이면 거절한다(드라이버는 사용자가 고른다).
 */
export function parseUrl(text: string, driver: DriverId): ParsedUrl {
  const raw = text.trim().replace(/^jdbc:/i, '');
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (!m) return { ok: false, error: 'Expected a URL like postgresql://user@host:5432/db.' };
  const scheme = m[1].toLowerCase();
  const isPg = scheme === 'postgres' || scheme === 'postgresql';
  const isMy = scheme === 'mysql' || scheme === 'mariadb';
  if (!isPg && !isMy) return { ok: false, error: `Unsupported URL scheme "${scheme}".` };
  if (isMy !== (driver === 'mysql')) {
    return { ok: false, error: `This is a ${isMy ? 'MySQL' : 'PostgreSQL'} URL; the connection is ${DRIVER_LABELS[driver]}.` };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'This URL could not be read.' };
  }
  const patch: Extract<ParsedUrl, { ok: true }>['patch'] = {};
  if (url.hostname) patch.host = decodeURIComponent(url.hostname.replace(/^\[|\]$/g, ''));
  patch.port = url.port;
  patch.database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (url.username) patch.user = decodeURIComponent(url.username);
  const mode = (url.searchParams.get('sslmode') ?? url.searchParams.get('ssl-mode') ?? '').toLowerCase();
  if (mode) patch.ssl = SSLMODE_FROM_URL[mode] ?? 'disable';
  return { ok: true, patch, password: url.password ? decodeURIComponent(url.password) : undefined };
}

function int(text: string, min: number, max: number): number | undefined {
  const n = Number(text.trim());
  return text.trim() && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/** Options · SSH/SSL · Schemas · Advanced 칸 → 설정. 기본값과 같으면 저장하지 않는다. */
function buildAdvanced(form: ConnectionForm, config: Omit<ConnectionConfig, 'id'>, errors: FormErrors): void {
  const a = form.adv;
  if (a.scope === 'project') config.scope = 'project';

  if (form.driver !== 'sqlite' || a.transactionControl === 'manual') {
    if (a.transactionControl === 'manual') config.transactionControl = 'manual';
  }
  // SQLite는 격리 수준을 고를 수 없다(늘 SERIALIZABLE)
  if (a.isolation && form.driver !== 'sqlite') config.isolation = a.isolation;
  if (a.createDatabase && form.driver === 'h2' && config.file) config.createDatabase = true;
  if (a.switchSchema !== 'manual') config.switchSchema = a.switchSchema;
  if (a.timeZone.trim()) config.timeZone = a.timeZone.trim();
  if (a.keepAliveOn) {
    const n = int(a.keepAlive, 1, 86400);
    if (n === undefined) errors.keepAlive = 'Keep-alive must be 1–86400 seconds.';
    else config.keepAlive = n;
  }
  // keep-alive 쿼리는 읽기 전용 연결에서도 주기적으로 돈다 — 읽기 문장 하나만
  if (a.keepAliveQuery.trim()) {
    if (classifySql(a.keepAliveQuery, form.driver).kind !== 'read') errors.keepAliveQuery = 'The keep-alive query must be one read-only statement.';
    else config.keepAliveQuery = a.keepAliveQuery.trim();
  }
  if (a.autoDisconnectOn) {
    const n = int(a.autoDisconnect, 1, 86400);
    if (n === undefined) errors.autoDisconnect = 'Auto-disconnect must be 1–86400 seconds.';
    else config.autoDisconnect = n;
  }
  if (a.singleDatabase) config.singleDatabase = true;
  if (a.sessionControl !== 'single') config.sessionControl = a.sessionControl;
  if (a.startupScript.trim()) config.startupScript = a.startupScript;

  if (!a.autoSync) config.autoSync = false;
  if (!a.warnOutdatedDdl) config.warnOutdatedDdl = false;
  if (a.loadSources !== 'nonSystem') config.loadSources = a.loadSources;
  if (a.introspectOn) {
    const n = int(a.introspectInterval, 1, 1440);
    if (n === undefined) errors.introspectInterval = 'Interval must be 1–1440 minutes.';
    else config.introspectInterval = n;
  }
  if (!a.trackSchemas) config.trackSchemas = false;
  if (!a.preIntrospected) config.preIntrospected = false;
  if (a.virtualObjectsFile.trim()) config.virtualObjectsFile = a.virtualObjectsFile.trim();
  if (a.introspectionLevel) config.introspectionLevel = Number(a.introspectionLevel) as 1 | 2 | 3;
  if (Object.keys(a.schemaLevels).length) config.schemaLevels = { ...a.schemaLevels };

  if (config.ssl) {
    if (!a.sslTrustBundled || !a.sslTrustSystem) config.sslTruststore = { bundled: a.sslTrustBundled, system: a.sslTrustSystem };
    if (a.sslCaFile.trim()) config.sslCaFile = a.sslCaFile.trim();
    if (a.sslCertFile.trim()) config.sslCertFile = a.sslCertFile.trim();
    if (a.sslKeyFile.trim()) config.sslKeyFile = a.sslKeyFile.trim();
  }

  if (a.sshEnabled && a.sshConfigId) {
    // 공유 SSH 설정: 값은 그 설정에 있다
    const local = a.sshLocalPort.trim() ? int(a.sshLocalPort, 1, 65535) : undefined;
    if (a.sshLocalPort.trim() && local === undefined) errors.sshLocalPort = 'Port must be 1–65535.';
    config.ssh = { enabled: true, host: '', user: '', auth: 'password', configId: a.sshConfigId, ...(local !== undefined ? { localPort: local } : {}) };
  } else if (a.sshEnabled) {
    if (!a.sshHost.trim()) errors.sshHost = 'Enter the SSH host.';
    if (!a.sshUser.trim()) errors.sshUser = 'Enter the SSH user.';
    const port = a.sshPort.trim() ? int(a.sshPort, 1, 65535) : 22;
    if (port === undefined) errors.sshPort = 'Port must be 1–65535.';
    const local = a.sshLocalPort.trim() ? int(a.sshLocalPort, 1, 65535) : undefined;
    if (a.sshLocalPort.trim() && local === undefined) errors.sshLocalPort = 'Port must be 1–65535.';
    if (a.sshAuth === 'key' && !a.sshKeyFile.trim()) errors.sshKeyFile = 'Choose a private key file.';
    config.ssh = {
      enabled: true,
      host: a.sshHost.trim(),
      port: port ?? 22,
      user: a.sshUser.trim(),
      auth: a.sshAuth,
      ...(a.sshAuth === 'key' ? { keyFile: a.sshKeyFile.trim() } : {}),
      ...(local !== undefined ? { localPort: local } : {}),
      ...(a.sshParseConfig ? { parseConfig: true } : {}),
      ...(a.sshStrict !== 'ask' ? { strictHostKey: a.sshStrict } : {}),
    };
    if (a.sshKeepAlive.trim()) {
      const k = int(a.sshKeepAlive, 1, 3600);
      if (k === undefined) errors.sshKeepAlive = 'Keep-alive must be 1–3600 seconds.';
      else config.ssh.keepAlive = k;
    }
    if (a.sshParseConfig && !a.sshUser.trim()) delete errors.sshUser;
  }

  if (a.schemaPattern.trim()) config.schemaPattern = a.schemaPattern.trim();
  if (a.objectFilter.trim()) {
    const bad = parseObjectFilter(a.objectFilter).find((r) => r.error);
    if (bad) errors.objectFilter = bad.error;
    config.objectFilter = a.objectFilter.trim();
  }
  if (a.showSystemSchemas) config.showSystemSchemas = true;
  if (a.showTemplateDatabases) config.showTemplateDatabases = true;

  const opts: Record<string, string> = {};
  for (const { key, value } of a.driverOptions) if (key.trim()) opts[key.trim()] = value;
  if (Object.keys(opts).length) config.driverOptions = opts;
  if (a.vmOptions.trim()) config.vmOptions = a.vmOptions.trim();
  if (a.vmEnvironment.trim()) {
    const bad = a.vmEnvironment.split('\n').find((l) => l.trim() && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(l.trim()));
    if (bad) errors.vmEnvironment = `Expected KEY=VALUE, got "${bad.trim()}".`;
    config.vmEnvironment = a.vmEnvironment.trim();
  }
  if (a.workingDirectory.trim()) config.workingDirectory = a.workingDirectory.trim();
  if (a.introspectJdbc && form.driver === 'h2') config.introspectJdbc = true;

  const templates = a.sessionTemplates.filter((t) => t.name.trim());
  if (templates.length) {
    config.sessionTemplates = templates.map((t) => ({
      name: t.name.trim(),
      ...(t.auth ? { auth: t.auth } : {}),
      ...(t.user.trim() ? { user: t.user.trim() } : {}),
      ...(t.readOnly ? { readOnly: t.readOnly === 'on' } : {}),
      ...(t.startupScript.trim() ? { startupScript: t.startupScript } : {}),
      ...(t.driverFile.trim() ? { driverFile: t.driverFile.trim() } : {}),
    }));
  }
  if (a.useSessionTemplate) {
    if (!templates.some((t) => t.name.trim() === a.useSessionTemplate)) errors.useSessionTemplate = `No session template named "${a.useSessionTemplate}".`;
    config.useSessionTemplate = a.useSessionTemplate;
  }
  const tasks = a.beforeConnection.split('\n').map((x) => x.trim()).filter(Boolean);
  if (tasks.length) config.beforeConnection = tasks;
  if (a.keywordCase !== 'upper' || a.quoteIdentifiers !== 'always') config.codeStyle = { keywordCase: a.keywordCase, quoteIdentifiers: a.quoteIdentifiers };
  if (a.color) {
    if (!/^#[0-9a-f]{6}$/i.test(a.color)) errors.color = 'Color must be #rrggbb.';
    config.color = a.color;
  }
}

/** Session template을 적용한 설정(Use session template). 템플릿 값이 데이터 소스 설정을 덮어쓴다 */
export function withSessionTemplate(cfg: ConnectionConfig): ConnectionConfig {
  const t = cfg.useSessionTemplate ? cfg.sessionTemplates?.find((x) => x.name === cfg.useSessionTemplate) : undefined;
  if (!t) return cfg;
  // 템플릿에 값이 있는 칸만 덮어쓴다(DataGrip: 템플릿 설정이 데이터 소스 설정을 덮어쓴다)
  return {
    ...cfg,
    ...(t.auth ? { auth: t.auth } : {}),
    ...(t.user ? { user: t.user } : {}),
    ...(t.readOnly !== undefined ? { readOnly: t.readOnly } : {}),
    ...(t.startupScript?.trim() ? { startupScript: t.startupScript } : {}),
    ...(t.driverFile ? { driverFile: t.driverFile } : {}),
  };
}

/** Object filter 한 줄 = `<type>:[-]<정규식>` (DataGrip 문서 형식). 여러 줄 또는 공백으로 나눈다. */
export interface ObjectFilterRule {
  type: string;
  exclude: boolean;
  pattern?: RegExp;
  error?: string;
}

export function parseObjectFilter(text: string): ObjectFilterRule[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((item) => {
      const m = /^([a-z]+):(-?)(.+)$/i.exec(item);
      if (!m) return { type: '', exclude: false, error: `"${item}" is not <type>:[-]<pattern>.` };
      try {
        return { type: m[1].toLowerCase(), exclude: m[2] === '-', pattern: new RegExp(`^(?:${m[3]})$`, 'i') };
      } catch {
        return { type: m[1].toLowerCase(), exclude: m[2] === '-', error: `"${m[3]}" is not a valid regular expression.` };
      }
    });
}

/** 이 객체를 탐색기에 보일까. 같은 종류의 포함 규칙이 하나라도 있으면 그중 하나와 맞아야 한다. */
export function objectVisible(rules: readonly ObjectFilterRule[], type: string, name: string): boolean {
  const mine = rules.filter((r) => r.type === type && r.pattern);
  if (mine.some((r) => r.exclude && r.pattern!.test(name))) return false;
  const includes = mine.filter((r) => !r.exclude);
  return includes.length === 0 || includes.some((r) => r.pattern!.test(name));
}

/**
 * Schema pattern(DataGrip 문서 형식): `db:schema` 항목을 `|`로 잇는다. 각 부분은 이름, `@`(현재), `*`(전부),
 * 쉼표로 나눈 이름 목록. db 부분이 없으면 스키마로 본다.
 */
export function schemaVisible(pattern: string, ctx: { database?: string; currentSchema?: string }, schema: string): boolean {
  const p = pattern.trim();
  if (!p) return true;
  return p.split('|').some((item) => {
    const [dbPart, schemaPart] = item.includes(':') ? item.split(':', 2) : [undefined, item];
    const matches = (part: string, value: string | undefined, current: string | undefined) =>
      part
        .split(',')
        .map((x) => x.trim())
        .some((x) => x === '*' || (x === '@' ? value !== undefined && value === current : x.toLowerCase() === (value ?? '').toLowerCase()));
    // db 부분이 없거나, 데이터베이스 개념이 없는 드라이버(SQLite)면 db 조건은 본다고 치지 않는다.
    const dbOk = dbPart === undefined || ctx.database === undefined || matches(dbPart, ctx.database, ctx.database);
    return dbOk && matches(schemaPart, schema, ctx.currentSchema ?? schema);
  });
}

/** URL에서 비밀번호를 뗀다(scheme://user:password@host → scheme://user@host) */
export function stripUrlPassword(url: string): { url: string; password?: string } {
  const m = /^((?:jdbc:)?[a-z][a-z0-9+.-]*:\/\/)([^/@?#]*)@/i.exec(url);
  if (!m) return { url };
  const userinfo = m[2];
  const i = userinfo.indexOf(':');
  if (i < 0) return { url };
  let password = userinfo.slice(i + 1);
  try {
    password = decodeURIComponent(password);
  } catch {
    // 그대로 둔다
  }
  return { url: `${m[1]}${userinfo.slice(0, i)}@${url.slice(m[0].length)}`, password };
}
