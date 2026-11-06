/** 결과 그리드 webview ↔ 확장 호스트 메시지. 양쪽 번들이 함께 쓴다. */
import type { ExportFormat } from './exportFormats';

/** 셀 값. 직렬화 가능한 형태로 정규화된 것 */
export type CellValue = string | number | boolean | null | { $bin: number; hex?: string };

export interface GridColumn {
  name: string;
  type?: string;
}

/** 편집 값: 문자열 · NULL · 새 행의 기본값 */
export type WireEditValue = string | null | { default: true };

/** Submit · Preview로 보내는 바뀐 내용. 기존 행은 원래 값을 함께 보낸다(호스트가 행을 찾을 키를 읽는다) */
export interface WireChanges {
  updates: { row: number; original: CellValue[]; cells: [number, WireEditValue][] }[];
  deletes: { row: number; original: CellValue[] }[];
  inserts: [number, WireEditValue][][];
}

/** 편집할 수 있는가. 못 하면 그 이유 */
export type Editability = { editable: true; key: string[]; columns: boolean[] } | { editable: false; reason: string };

export type HostToWebview =
  | {
      t: 'result/start';
      qid: string;
      sql: string;
      connection: string;
      columns: GridColumn[];
      /** 테이블 데이터면 테이블 이름(사람이 읽는 schema.table) */
      table?: string;
      /** SQL INSERT 복사용: 연결의 방언과 인용된 테이블 이름 */
      dialect: 'postgres' | 'mysql' | 'sqlite' | 'h2';
      quotedTable?: string;
      /** 결과 전체 내보내기를 할 수 있는가(아니면 그 이유) */
      exportable: true | string;
      /** WHERE / ORDER BY 줄을 쓸 수 있는가(아니면 그 이유) */
      filterable: true | string;
      filter: { where: string; orderBy: string };
      edit: Editability;
    }
  | { t: 'result/rows'; qid: string; offset: number; rows: CellValue[][]; done: boolean }
  | { t: 'result/update'; qid: string; affectedRows: number | null; elapsedMs: number }
  | { t: 'result/stats'; qid: string; elapsedMs: number }
  | { t: 'result/error'; qid: string; message: string }
  | { t: 'running'; qid: string; sql: string; connection: string }
  | { t: 'edit/preview'; qid: string; statements?: string[]; error?: string }
  | { t: 'edit/result'; qid: string; ok: boolean; message: string }
  | { t: 'notice'; message: string; error?: boolean };

export type WebviewToHost =
  | { t: 'ready' }
  | { t: 'fetch'; qid: string }
  | { t: 'cancel'; qid: string }
  /** WHERE / ORDER BY를 바꿔 다시 실행 */
  | { t: 'filter'; qid: string; where: string; orderBy: string }
  /** 다시 실행(편집 버리기 · 새로 고침) */
  | { t: 'refresh'; qid: string }
  /** 결과 전체를 파일로 */
  | { t: 'export'; qid: string; format: ExportFormat }
  | { t: 'edit/preview'; qid: string; changes: WireChanges }
  | { t: 'edit/submit'; qid: string; changes: WireChanges };
