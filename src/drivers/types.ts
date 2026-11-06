export type DriverId = 'postgres' | 'mysql' | 'sqlite' | 'h2';

/** disable: 평문 / require: 암호화만(인증서 검사 안 함) / verify: 암호화 + 인증서 검사 */
export type SslMode = 'disable' | 'require' | 'verify';

export interface ConnectionConfig {
  id: string;
  name: string;
  driver: DriverId;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  /** sqlite: DB 파일 / h2: 파일 모드에서 열 .mv.db 파일 */
  file?: string;
  readOnly?: boolean;
  /** postgres · mysql. 없으면 disable */
  ssl?: SslMode;
  /** 사람이 붙이는 메모(탐색기 툴팁) */
  comment?: string;
  /** 연결 대기 시간(초). 없으면 10 */
  connectTimeout?: number;

  // ── DataGrip Data Sources 창의 항목들 ──
  /** default = 칸으로 지정, url = URL만 */
  connectionType?: 'default' | 'url';
  /** connectionType이 url일 때의 연결 URL(비밀번호 제외) */
  url?: string;
  /** password = 사용자 + 비밀번호, none = 인증 없음, pgpass = ~/.pgpass (postgres) */
  auth?: AuthMode;
  /** 비밀번호 보관: never = 접속마다 묻기, restart = VS Code를 끌 때까지, session = 연결을 끊을 때까지, forever = 키체인. 없으면 forever */
  passwordSave?: PasswordSave;
  /** 프로젝트(워크스페이스) 설정에 둔 연결이면 project. 없으면 global */
  scope?: 'global' | 'project';

  /** Options · Connection */
  transactionControl?: 'auto' | 'manual';
  switchSchema?: 'automatic' | 'manual' | 'disable';
  timeZone?: string;
  /** 초. 없으면 끔 */
  keepAlive?: number;
  /** 초. 없으면 끔 */
  autoDisconnect?: number;
  singleDatabase?: boolean;
  sessionControl?: 'single' | 'two' | 'dedicated';
  startupScript?: string;

  /** Options · Introspection */
  autoSync?: boolean;
  loadSources?: 'all' | 'nonSystem' | 'none';
  /** 분. 없으면 끔 */
  introspectInterval?: number;
  trackSchemas?: boolean;
  /** Use pre-introspected objects for system catalogs that are not introspected. 없으면 켬 */
  preIntrospected?: boolean;
  /** Virtual objects and attributes: 가상 객체 파일. 없으면 확장 저장소의 external-data-<id>.json */
  virtualObjectsFile?: string;
  /** Default level: 1 = 이름만, 2 = 소스 코드 빼고 전부, 3 = 전부. 없으면 3 */
  introspectionLevel?: 1 | 2 | 3;

  /** SSH/SSL · SSL 파일 */
  sslCaFile?: string;
  sslCertFile?: string;
  sslKeyFile?: string;

  /** SSL · Use truststore: bundled = Node 내장 CA 목록(DataGrip의 JAVA 자리), system = OS 인증서 저장소. 없으면 둘 다 */
  sslTruststore?: { bundled: boolean; system: boolean };

  /** SSH/SSL · SSH 터널 */
  ssh?: SshConfig;

  /** Schemas */
  schemaPattern?: string;
  objectFilter?: string;
  showSystemSchemas?: boolean;
  showTemplateDatabases?: boolean;

  /** db = 실제 데이터베이스(기본), ddl = SQL 파일 폴더(DDL data source). driver는 SQL 방언 */
  kind?: 'db' | 'ddl';
  /** DDL data source의 폴더 */
  ddlFolder?: string;
  /** DDL Mapping: 이 데이터 소스와 맞출 DDL data source id와 범위(스키마) */
  ddlMapping?: { ddl: string; scope?: string[] };

  /** Options · Other · Session Templates: 세션 설정을 덮어쓰는 템플릿들 */
  sessionTemplates?: SessionTemplate[];
  /** Options · Introspection · Use session template: 이 데이터 소스의 세션이 쓸 템플릿 이름 */
  useSessionTemplate?: string;
  /** Options · Other · Before connection: 첫 접속 전에 실행할 VS Code 작업 이름들 */
  beforeConnection?: string[];
  /** Options · Other · Code style: 생성하는 SQL의 모양 */
  codeStyle?: CodeStyle;
  /** 데이터 소스 색(#rrggbb) */
  color?: string;

  /** Advanced */
  driverOptions?: Record<string, string>;
  vmOptions?: string;
  /** KEY=VALUE 줄들 */
  vmEnvironment?: string;
  workingDirectory?: string;
}

export interface SessionTemplate {
  name: string;
  user?: string;
  readOnly?: boolean;
  startupScript?: string;
}

export interface CodeStyle {
  keywordCase: 'upper' | 'lower';
  /** always = 늘 따옴표, needed = 필요할 때만 */
  quoteIdentifiers: 'always' | 'needed';
}

export type AuthMode = 'password' | 'none' | 'pgpass';
export type PasswordSave = 'never' | 'restart' | 'session' | 'forever';

export interface SshConfig {
  enabled: boolean;
  host: string;
  port?: number;
  user: string;
  auth: 'password' | 'key' | 'agent';
  keyFile?: string;
  /** 없으면 비어 있는 포트를 고른다 */
  localPort?: number;
  /** Parse config file ~/.ssh/config: host를 별칭으로 보고 HostName · User · Port · IdentityFile을 채운다 */
  parseConfig?: boolean;
  /** Send keep-alive messages every N seconds */
  keepAlive?: number;
  /** Strict host key checking. 없으면 ask */
  strictHostKey?: 'yes' | 'acceptNew' | 'no' | 'ask';
  /** 공유 SSH 설정(bindb.ssh.configurations)의 id. 있으면 위 값 대신 그 설정을 쓴다(localPort · enabled는 데이터 소스 것) */
  configId?: string;
}

/** 공유 SSH 설정 하나(bindb.ssh.configurations) */
export interface SharedSshConfig extends Omit<SshConfig, 'enabled' | 'localPort' | 'configId'> {
  id: string;
  name: string;
}

export interface ConnectOptions {
  password?: string;
  /** h2 파일 모드에서 띄울 h2-*.jar */
  h2Jar?: string;
  /** SSL 클라이언트 키 비밀번호 */
  sslKeyPassword?: string;
  /** SSH 터널을 거칠 때 실제 DB 호스트 · 포트(SSL 인증서 확인 · pgpass 조회에 쓴다) */
  realTarget?: { host: string; port: number };
  /** 처음 보는 SSH 호스트 키를 믿을지 묻는다(Strict host key checking · Ask) */
  askHostKey?: (host: string, fingerprint: string) => Promise<boolean>;
  /** known_hosts 파일(테스트용). 없으면 ~/.ssh/known_hosts */
  knownHostsFile?: string;
  /** ~/.ssh/config 파일(테스트용) */
  sshConfigFile?: string;
}

export interface ColumnMeta {
  name: string;
  type?: string;
}

export interface FetchResult {
  rows: unknown[][];
  done: boolean;
}

export interface QueryCursor {
  /** 결과셋이 없는 문장(DDL/DML)이면 빈 배열 */
  readonly columns: ColumnMeta[];
  readonly affectedRows?: number;
  fetch(n: number): Promise<FetchResult>;
  close(): Promise<void>;
}

/** 한 연결 위의 세션. 문장은 한 번에 하나씩만 실행한다. */
export interface Session {
  /** 서버가 연결을 끊었을 때(네트워크 · 서버 종료). 이후 이 세션은 쓸 수 없다 */
  onLost?(listener: (error: Error) => void): void;
  /** params: 매개변수 값(postgres · h2는 $1…, mysql · sqlite는 ?) */
  execute(sql: string, params?: readonly unknown[]): Promise<QueryCursor>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface MetaTable {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  columns: ColumnMeta[];
  /** 기본키 열(순서대로). 없으면 빈 배열 · undefined */
  primaryKey?: string[];
  /** 뷰 정의(Load sources for) */
  definition?: string;
}

export interface Driver {
  readonly id: DriverId;
  readonly label: string;
  readonly defaultPort?: number;
  /** 식별자 인용 문자 */
  readonly quote: '"' | '`';
  /** 이름 없이 쓴 테이블이 속하는 스키마 */
  defaultSchema(cfg: ConnectionConfig): string | undefined;
  connect(cfg: ConnectionConfig, opts: ConnectOptions): Promise<Session>;
  introspect(session: Session, cfg: ConnectionConfig): Promise<MetaTable[]>;
}
