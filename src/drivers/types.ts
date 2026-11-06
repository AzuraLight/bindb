export type DriverId = 'postgres' | 'mysql' | 'sqlite' | 'h2';

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
}

export interface ConnectOptions {
  password?: string;
  /** h2 파일 모드에서 띄울 h2-*.jar */
  h2Jar?: string;
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
  execute(sql: string): Promise<QueryCursor>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface MetaTable {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  columns: ColumnMeta[];
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
