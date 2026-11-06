/** 연결 관리 webview(Data Sources) ↔ 확장 호스트 메시지 */
import type { ConnectionForm, FormErrors } from '../core/connectionDraft';
import type { DriverId, SharedSshConfig } from '../drivers/types';

/** 키체인 등에 두는 비밀 값 종류(ConnectionStore의 SecretKind와 같다) */
export type SecretField = 'password' | 'sslKey' | 'ssh';

/** Data Source Template: 데이터 소스 설정 한 벌(이름 · 메모 · 자격 증명 빼고) */
export interface DataSourceTemplate {
  name: string;
  form: ConnectionForm;
}

export interface SavedItem {
  id: string;
  form: ConnectionForm;
  /** 비밀 값이 저장돼 있는가 */
  has: Record<SecretField, boolean>;
}

/** Drivers 탭에 보여 줄 드라이버 정보 */
export interface DriverInfo {
  id: DriverId;
  /** 이 드라이버가 쓰는 Node 모듈과 판(DataGrip의 Driver files · Class에 해당) */
  module: string;
  version: string;
  /** URL 형식(DataGrip의 URL templates) */
  urlTemplates: string[];
}

export interface PanelInit {
  items: SavedItem[];
  /** 처음 고를 연결 id */
  select?: string;
  /** 새 연결을 하나 만들어 고른 채로 연다 */
  addNew?: DriverId;
  /** 종류 목록(+ 메뉴)을 펼친 채로 연다. 고르면 그 종류로 새 연결을 만든다 */
  pickDriver?: boolean;
  /** select한 데이터 소스에 새 DDL data source를 만들어 매핑한다(탐색기 · Create DDL Mapping) */
  createDdlMapping?: boolean;
  /** bindb.h2.jarPath 현재 값 */
  h2Jar: string;
  drivers: DriverInfo[];
  /** 워크스페이스가 열려 있어 프로젝트 연결을 둘 수 있는가 */
  canUseProject: boolean;
  /** 공유 SSH 설정(bindb.ssh.configurations) */
  sshConfigs: SharedSshConfig[];
  /** Data Source Templates(bindb.dataSourceTemplates). 비밀 값은 담지 않는다 */
  templates: DataSourceTemplate[];
}

/** 비밀 값 칸: keep = 저장된 것 유지, clear = 지움, set = value로 바꿈 */
export type PasswordChange = { kind: 'keep' } | { kind: 'clear' } | { kind: 'set'; value: string };
export type SecretChanges = Record<SecretField, PasswordChange>;

/** 저장할 변경 하나. id가 없으면 새 연결 */
export interface Change {
  key: string;
  id?: string;
  form: ConnectionForm;
  secrets: SecretChanges;
}

/** 파일 · 폴더 고르기 대상 */
export type PickField = 'virtualObjectsFile' | 'ddlFolder' | 'file' | 'newFile' | 'h2Jar' | 'sslCaFile' | 'sslCertFile' | 'sslKeyFile' | 'sshKeyFile' | 'workingDirectory';

export type PanelHostToWebview =
  | { t: 'init'; init: PanelInit }
  /** 이미 열린 패널에서 다른 연결을 고르거나 새로 만들게 한다 */
  | { t: 'focus'; select?: string; addNew?: DriverId; pickDriver?: boolean; createDdlMapping?: boolean }
  | { t: 'picked'; key: string; field: PickField; path: string }
  | { t: 'tested'; key: string; ok: boolean; message: string; detail?: string }
  | { t: 'applyFailed'; message?: string; errors?: Record<string, FormErrors> }
  /** Schemas 탭: 접속해서 읽은 데이터베이스 · 스키마 목록 */
  | { t: 'h2Versions'; latest?: string; versions?: string[]; error?: string }
  | { t: 'h2Downloaded'; path?: string; error?: string }
  | { t: 'schemas'; key: string; ok: boolean; message?: string; tree?: { database?: string; schemas: string[] }[] };

export type PanelWebviewToHost =
  | { t: 'ready' }
  | { t: 'pick'; key: string; field: PickField; driver: DriverId }
  | { t: 'test'; key: string; id?: string; form: ConnectionForm; secrets: SecretChanges; h2Jar: string; sshConfigs: SharedSshConfig[] }
  | { t: 'apply'; changes: Change[]; removed: string[]; h2Jar: string; close: boolean; selectedKey?: string; sshConfigs?: SharedSshConfig[]; templates?: DataSourceTemplate[] }
  | { t: 'close'; dirty: boolean }
  | { t: 'h2Versions' }
  | { t: 'downloadH2'; version: string }
  | { t: 'listSchemas'; key: string; id?: string; form: ConnectionForm; secrets: SecretChanges; h2Jar: string; sshConfigs: SharedSshConfig[] };
