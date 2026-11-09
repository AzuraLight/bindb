import type { ConnectionConfig } from '../drivers/types';
import { drivers } from '../drivers';
import { tokenize } from '../language/tokenizer';

/* 세션에 보내는 SQL을 만드는 함수들(VS Code와 상관없어 단독으로 테스트한다) */

/**
 * Switch schema 문장.
 * postgres는 search_path를 그 스키마 하나로 바꾸면 public 등에 설치된 확장(PostGIS · uuid-ossp …)의
 * 함수 · 타입을 못 찾는다. base(세션의 원래 search_path) 앞에 붙이고, 이미 들어 있던 같은 스키마는 뺀다.
 * https://www.postgresql.org/docs/current/ddl-schemas.html#DDL-SCHEMAS-PATH
 */
export function switchSchemaSql(cfg: ConnectionConfig, schema: string, base?: string): string | undefined {
  const q = drivers[cfg.driver].quote;
  const ident = q + schema.split(q).join(q + q) + q;
  switch (cfg.driver) {
    case 'postgres': {
      const rest = splitSearchPath(base ?? '').filter((p) => p !== ident && p !== schema);
      return `SET search_path TO ${[ident, ...rest].join(', ')}`;
    }
    case 'mysql':
      return `USE ${ident}`;
    case 'h2':
      return `SET SCHEMA ${ident}`;
    default:
      return undefined;
  }
}

/**
 * 트랜잭션 블록 안에서 실행할 수 없는 문장(Manual 모드에서 앞에 BEGIN을 붙이면 실패한다).
 *  - postgres: 각 명령 문서의 "cannot be executed inside a transaction block"
 *    VACUUM · CREATE/DROP DATABASE · CREATE/DROP TABLESPACE · ALTER SYSTEM · CREATE/DROP INDEX CONCURRENTLY ·
 *    REINDEX … CONCURRENTLY · REINDEX SYSTEM/DATABASE · 인자 없는 CLUSTER · DISCARD ALL ·
 *    CREATE SUBSCRIPTION(슬롯을 만들 때) · ALTER/DROP SUBSCRIPTION
 *  - sqlite: VACUUM (https://www.sqlite.org/lang_vacuum.html)
 */
export function cannotRunInTransaction(sql: string, driver: ConnectionConfig['driver']): boolean {
  const words = tokenize(sql, driver)
    .filter((t) => t.type === 'word')
    .map((t) => t.text.toUpperCase());
  const [a, b, c] = words;
  if (a === 'VACUUM') return driver === 'postgres' || driver === 'sqlite';
  if (driver !== 'postgres') return false;
  if ((a === 'CREATE' || a === 'DROP') && (b === 'DATABASE' || b === 'TABLESPACE')) return true;
  if ((a === 'CREATE' || a === 'ALTER' || a === 'DROP') && b === 'SUBSCRIPTION') return true;
  if (a === 'ALTER' && b === 'SYSTEM') return true;
  if (a === 'CREATE' && (b === 'INDEX' || (b === 'UNIQUE' && c === 'INDEX'))) return words.slice(0, 4).includes('CONCURRENTLY');
  if (a === 'DROP' && b === 'INDEX') return c === 'CONCURRENTLY';
  if (a === 'REINDEX') return words.includes('CONCURRENTLY') || b === 'SYSTEM' || b === 'DATABASE';
  if (a === 'CLUSTER') return words.length === 1 || (words.length === 2 && b === 'VERBOSE');
  if (a === 'DISCARD') return b === 'ALL';
  return false;
}

/** SHOW search_path 결과("$user", public, "My Schema") → 항목들(인용은 그대로). 쉼표는 인용 안의 것은 넘긴다 */
function splitSearchPath(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
