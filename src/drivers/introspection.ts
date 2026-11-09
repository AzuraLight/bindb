import type { ConnectionConfig } from './types';

export type IntrospectionLevel = 1 | 2 | 3;

/**
 * 스키마 하나의 구조 정보 읽기 수준(DataGrip Introspection levels).
 *  1: 이름만(열 이름까지, 타입은 모름) · 2: 소스 코드만 빼고 전부 · 3: 전부
 * 정하는 순서: 스키마마다 지정한 값 → 데이터 소스의 Default level → 자동(스키마의 객체 수 N):
 *   현재 스키마  N ≤ 1000 → 3, N ≤ 3000 → 2, 그 밖 1
 *   다른 스키마  N ≤ 3000 → 2, 그 밖 1
 *   시스템 스키마 N ≤ 100 → 2, 그 밖 1
 * https://www.jetbrains.com/help/datagrip/introspection-levels.html
 */
export function schemaLevel(
  cfg: Pick<ConnectionConfig, 'introspectionLevel' | 'schemaLevels'>,
  schema: string,
  objects: number,
  where: { current: boolean; system: boolean },
): IntrospectionLevel {
  const own = cfg.schemaLevels?.[schema];
  if (own) return own;
  if (cfg.introspectionLevel) return cfg.introspectionLevel;
  if (where.system) return objects <= 100 ? 2 : 1;
  if (where.current) return objects <= 1000 ? 3 : objects <= 3000 ? 2 : 1;
  return objects <= 3000 ? 2 : 1;
}

/** 스키마 이름 → 객체 수 → 수준. current는 대소문자 없이 비교한다 */
export function levelsBySchema(
  cfg: Pick<ConnectionConfig, 'introspectionLevel' | 'schemaLevels'>,
  schemas: readonly string[],
  current: string | undefined,
  isSystem: (schema: string) => boolean,
): Map<string, IntrospectionLevel> {
  const counts = new Map<string, number>();
  for (const s of schemas) counts.set(s, (counts.get(s) ?? 0) + 1);
  const out = new Map<string, IntrospectionLevel>();
  for (const [s, n] of counts) {
    out.set(s, schemaLevel(cfg, s, n, { current: !!current && s.toLowerCase() === current.toLowerCase(), system: isSystem(s) }));
  }
  return out;
}

/** Load sources for: 이 스키마의 소스 코드(뷰 정의)를 읽는가. 3단계에서만 */
export function loadsSources(cfg: Pick<ConnectionConfig, 'loadSources'>, level: IntrospectionLevel, system: boolean): boolean {
  if (level < 3) return false;
  const load = cfg.loadSources ?? 'nonSystem';
  return load === 'all' || (load === 'nonSystem' && !system);
}
