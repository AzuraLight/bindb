import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { MetaTable } from '../drivers/types';

/*
 * Virtual objects and attributes (DataGrip Options · Introspection). DB에는 저장하지 않고 BindB에만 있는 객체.
 *  - 가상 외래키: 탐색기의 테이블 아래에 보이고, JOIN 뒤 ON 완성에 쓰인다
 *  - 가상 뷰: 저장한 SQL. 탐색기의 스키마 아래에 보이고, 열면 그 SQL을 실행한다
 *  - 가상 컬럼: 식으로 만든 컬럼. 테이블 데이터를 열 때 함께 계산한다
 * 데이터 소스마다 JSON 파일 하나(DataGrip의 external-data-<name>.xml 자리).
 */

export interface VirtualForeignKey {
  /** schema.table */
  table: string;
  columns: string[];
  /** schema.table */
  refTable: string;
  refColumns: string[];
}

export interface VirtualView {
  schema: string;
  name: string;
  sql: string;
}

export interface VirtualColumn {
  /** schema.table */
  table: string;
  name: string;
  expression: string;
}

export interface VirtualObjects {
  foreignKeys: VirtualForeignKey[];
  views: VirtualView[];
  columns: VirtualColumn[];
}

export const emptyVirtual = (): VirtualObjects => ({ foreignKeys: [], views: [], columns: [] });

export async function loadVirtual(file: string): Promise<VirtualObjects> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return emptyVirtual();
  }
  const data = JSON.parse(text) as Partial<VirtualObjects>;
  return { foreignKeys: data.foreignKeys ?? [], views: data.views ?? [], columns: data.columns ?? [] };
}

export async function saveVirtual(file: string, data: VirtualObjects): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const tableKey = (schema: string, name: string) => `${schema}.${name}`;

/** 이 테이블에서 나가거나 들어오는 가상 외래키 */
export function foreignKeysOf(v: VirtualObjects, table: string): VirtualForeignKey[] {
  return v.foreignKeys.filter((k) => same(k.table, table) || same(k.refTable, table));
}

/** 메타데이터의 외래 키를 가상 외래 키와 같은 모양으로(JOIN 조건 만들기에 함께 쓴다) */
export function realForeignKeys(tables: readonly MetaTable[]): VirtualForeignKey[] {
  return tables.flatMap((t) =>
    (t.foreignKeys ?? []).map((k) => ({ table: tableKey(t.schema, t.name), columns: k.columns, refTable: tableKey(k.refSchema, k.refTable), refColumns: k.refColumns })),
  );
}

/** 두 테이블을 잇는 JOIN 조건들(외래 키마다 하나). a · b는 별칭 또는 이름 */
export function joinConditions(v: VirtualObjects, left: { table: string; alias: string }, right: { table: string; alias: string }): string[] {
  const out: string[] = [];
  for (const k of v.foreignKeys) {
    const pair = (from: typeof left, to: typeof right) =>
      k.columns.map((c, i) => `${from.alias}.${c} = ${to.alias}.${k.refColumns[i]}`).join(' AND ');
    if (same(k.table, left.table) && same(k.refTable, right.table)) out.push(pair(left, right));
    else if (same(k.table, right.table) && same(k.refTable, left.table)) out.push(pair(right, left));
  }
  return out;
}

/** 두 테이블을 잇는 첫 JOIN 조건(가상 외래키로) */
export function joinCondition(v: VirtualObjects, left: { table: string; alias: string }, right: { table: string; alias: string }): string | undefined {
  return joinConditions(v, left, right)[0];
}

/** 가상 컬럼을 더한 SELECT 목록(테이블 데이터 열기) */
export function selectList(v: VirtualObjects, table: string, quote: (s: string) => string): string {
  const extra = v.columns.filter((c) => same(c.table, table)).map((c) => `(${c.expression}) AS ${quote(c.name)}`);
  return ['*', ...extra].join(', ');
}
