import type { MetaTable } from '../drivers/types';

/** 이름 비교(대소문자 무시). 한쪽이라도 없으면 false */
export const same = (a: string | undefined, b: string | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * 이름(과 스키마)으로 메타데이터의 테이블을 찾는다. 스키마를 안 쓴 이름이 여러 스키마에 있으면
 * prefer 스키마(@schema 바인딩 · 연결의 기본 스키마)의 것을, 없으면 첫 번째를 고른다.
 */
export function findTable(tables: readonly MetaTable[], name: string, schema?: string, prefer?: string): MetaTable | undefined {
  const candidates = tables.filter((t) => same(t.name, name) && (!schema || same(t.schema, schema)));
  return candidates.find((t) => same(t.schema, prefer)) ?? candidates[0];
}
