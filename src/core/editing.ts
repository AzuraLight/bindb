import { quoteIdent, sqlLiteral, type ExportCell, type SqlDialect } from '../shared/exportFormats';

/*
 * 그리드 편집 → SQL(DataGrip Data editor의 Submit · Revert · Preview Pending Changes).
 *  - 값은 SQL에 끼워 넣지 않고 매개변수로 보낸다(따옴표 · 백슬래시 · 유니코드가 섞여도 안전)
 *  - 행은 기본키로 찾는다. 기본키가 없으면 SQLite rowid, 그것도 없으면 편집할 수 없다
 *  - UPDATE · DELETE는 정확히 한 행이 바뀌어야 한다(아니면 Submit 전체를 되돌린다)
 */

/** 셀에 넣을 값: 문자열(그대로) · null(NULL) · { default: true }(새 행에서 기본값) */
export type EditValue = string | null | { default: true };

export interface TableTarget {
  dialect: SqlDialect;
  /** 인용된 테이블 이름 */
  table: string;
  columns: string[];
  /** 행을 찾는 열 이름들(기본키 또는 rowid) */
  key: string[];
}

export interface PendingChanges {
  /** 기존 행: 행 번호 → (열 번호 → 새 값) */
  updates: Map<number, Map<number, EditValue>>;
  /** 지울 기존 행 번호 */
  deletes: Set<number>;
  /** 새 행: 열 번호 → 값(없는 열은 기본값) */
  inserts: Map<number, EditValue>[];
}

export const emptyChanges = (): PendingChanges => ({ updates: new Map(), deletes: new Set(), inserts: [] });

export interface Statement {
  sql: string;
  params: unknown[];
  /** 정확히 한 행이 바뀌어야 하는가(UPDATE · DELETE) */
  expectOne: boolean;
  /** 사람이 읽는 판(Preview): 매개변수를 리터럴로 넣은 SQL */
  preview: string;
}

/** 드라이버별 매개변수 자리표시자: postgres는 $n, mysql · sqlite · h2(JDBC)는 ? */
const placeholder = (dialect: SqlDialect, n: number) => (dialect === 'postgres' ? `$${n}` : '?');

/** 기존 행의 키 값. 키 열이 NULL이면 그 행은 찾을 수 없다 */
function keyValues(target: TableTarget, row: readonly ExportCell[]): unknown[] | string {
  const vals: unknown[] = [];
  for (const k of target.key) {
    const i = target.columns.indexOf(k);
    if (i < 0) return `The key column ${k} is not in the result.`;
    const v = row[i];
    if (v === null || v === undefined) return `The key column ${k} is NULL, so the row cannot be found.`;
    if (typeof v === 'object') return `The key column ${k} is binary; editing by binary keys is not supported.`;
    vals.push(v);
  }
  return vals;
}

const valueParam = (v: EditValue): unknown => (v === null ? null : typeof v === 'string' ? v : undefined);

export type BuildEdits = { ok: true; statements: Statement[] } | { ok: false; error: string };

/**
 * 바뀐 내용 → 문장들. 순서: DELETE → UPDATE → INSERT (DataGrip과 같다).
 * 지울 행의 편집은 버리고, 새로 넣을 행 중 값이 하나도 없는 행은 기본값만으로 넣는다.
 */
export function buildEditStatements(target: TableTarget, rows: readonly (readonly ExportCell[])[], changes: PendingChanges): BuildEdits {
  const { dialect } = target;
  const q = (c: string) => quoteIdent(dialect, c);
  const out: Statement[] = [];
  /**
   * 같은 모양을 두 번 만든다: 실행용(자리표시자)과 미리 보기용(리터럴).
   * 이름에 ? 나 $가 들어 있어도 자리표시자만 바뀐다.
   */
  const emit = (make: (ph: (n: number) => string) => string, params: unknown[], expectOne: boolean) => {
    out.push({
      sql: make((n) => placeholder(dialect, n)),
      preview: make((n) => sqlLiteral(dialect, toCell(params[n - 1]))),
      params,
      expectOne,
    });
  };
  const where = (ph: (n: number) => string, start: number) => target.key.map((k, i) => `${q(k)} = ${ph(start + i)}`).join(' AND ');

  for (const r of [...changes.deletes].sort((a, b) => a - b)) {
    const keys = keyValues(target, rows[r]);
    if (typeof keys === 'string') return { ok: false, error: `Row ${r + 1}: ${keys}` };
    emit((ph) => `DELETE FROM ${target.table} WHERE ${where(ph, 1)}`, keys, true);
  }

  for (const [r, cells] of [...changes.updates].sort(([a], [b]) => a - b)) {
    if (changes.deletes.has(r)) continue;
    const sets = [...cells].filter(([, v]) => !(typeof v === 'object' && v !== null));
    if (!sets.length) continue;
    const keys = keyValues(target, rows[r]);
    if (typeof keys === 'string') return { ok: false, error: `Row ${r + 1}: ${keys}` };
    const params = [...sets.map(([, v]) => valueParam(v)), ...keys];
    emit(
      (ph) => `UPDATE ${target.table} SET ${sets.map(([c], i) => `${q(target.columns[c])} = ${ph(i + 1)}`).join(', ')} WHERE ${where(ph, sets.length + 1)}`,
      params,
      true,
    );
  }

  for (const cells of changes.inserts) {
    const given = [...cells].filter(([, v]) => !(typeof v === 'object' && v !== null)).sort(([a], [b]) => a - b);
    if (!given.length) {
      // 값을 하나도 주지 않은 행: 모두 기본값. MySQL은 DEFAULT VALUES를 모른다
      emit(() => (dialect === 'mysql' ? `INSERT INTO ${target.table} () VALUES ()` : `INSERT INTO ${target.table} DEFAULT VALUES`), [], false);
      continue;
    }
    emit(
      (ph) => `INSERT INTO ${target.table} (${given.map(([c]) => q(target.columns[c])).join(', ')}) VALUES (${given.map((_, i) => ph(i + 1)).join(', ')})`,
      given.map(([, v]) => valueParam(v)),
      false,
    );
  }
  return { ok: true, statements: out };
}

function toCell(v: unknown): ExportCell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

/** 바뀐 내용이 있는가 */
export function hasChanges(c: PendingChanges): boolean {
  return c.deletes.size > 0 || c.inserts.length > 0 || [...c.updates.values()].some((m) => m.size > 0);
}

/**
 * 셀 하나 편집을 반영한다. 원래 값과 같아지면 그 편집을 지운다(다시 원래대로 고친 경우).
 */
export function setCell(c: PendingChanges, row: number, col: number, value: EditValue, original: ExportCell): void {
  const same = (value === null && original === null) || (typeof value === 'string' && typeof original !== 'object' && original !== null && String(original) === value);
  const cells = c.updates.get(row) ?? new Map<number, EditValue>();
  if (same) cells.delete(col);
  else cells.set(col, value);
  if (cells.size) c.updates.set(row, cells);
  else c.updates.delete(row);
}
