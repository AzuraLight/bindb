/** 결과 그리드 webview ↔ 확장 호스트 메시지. 양쪽 번들이 함께 쓴다. */

/** 셀 값. 직렬화 가능한 형태로 정규화된 것 */
export type CellValue = string | number | boolean | null | { $bin: number };

export interface GridColumn {
  name: string;
  type?: string;
}

export type HostToWebview =
  | { t: 'result/start'; qid: string; sql: string; connection: string; columns: GridColumn[] }
  | { t: 'result/rows'; qid: string; offset: number; rows: CellValue[][]; done: boolean }
  | { t: 'result/update'; qid: string; affectedRows: number | null; elapsedMs: number }
  | { t: 'result/stats'; qid: string; elapsedMs: number }
  | { t: 'result/error'; qid: string; message: string }
  | { t: 'running'; qid: string; sql: string; connection: string };

export type WebviewToHost =
  | { t: 'ready' }
  | { t: 'fetch'; qid: string }
  | { t: 'cancel'; qid: string };
