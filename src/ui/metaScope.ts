import type { SessionManager } from '../core/sessions';
import { drivers, type ConnectionConfig, type MetaTable } from '../drivers';
import { systemCatalog } from '../language/systemCatalog';

/** 메타데이터에 미리 만든 시스템 카탈로그를 더한다(Use pre-introspected objects, 기본 켬) */
export function withCatalog(cfg: ConnectionConfig, tables: MetaTable[]): MetaTable[] {
  return cfg.preIntrospected === false ? tables : [...tables, ...systemCatalog(cfg.driver, tables)];
}

/**
 * 이미 받아 둔 메타데이터로 만든 이름 풀이 범위(접속하지 않는다). 받아 둔 것이 없으면 undefined.
 * schema: @schema 바인딩. 없으면 연결의 기본 스키마
 */
export async function cachedScope(
  sessions: SessionManager,
  cfg: ConnectionConfig,
  schema: string | undefined,
): Promise<{ tables: MetaTable[]; schema?: string } | undefined> {
  const meta = sessions.cachedMetadata(cfg.id);
  const tables = meta ? await meta.catch(() => undefined) : undefined;
  if (!tables) return undefined;
  return { tables: withCatalog(cfg, tables), schema: schema ?? drivers[cfg.driver].defaultSchema(cfg) };
}
