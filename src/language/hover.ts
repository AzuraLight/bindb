import type { MetaTable } from '../drivers/types';
import { collectTableRefs, type TableRef } from './context';
import type { Statement } from './splitter';
import { identName, isIdent, type Token } from './tokenizer';

/*
 * 마우스를 올린 이름의 정보(DataGrip Quick Documentation에 해당).
 * 테이블 · 뷰 · 별칭 · 열 · 스키마를 메타데이터로 풀어 마크다운으로 만든다.
 */

export interface HoverInfo {
  start: number;
  end: number;
  markdown: string;
}

export interface HoverScope {
  tables: readonly MetaTable[];
  /** 한정하지 않은 이름을 먼저 찾을 스키마 */
  schema?: string;
}

const MAX_COLUMNS = 30;
const MAX_REFERENCED_BY = 10;

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
/** 마크다운 코드 조각 안에서 깨지지 않게 */
const code = (s: string) => '`' + s.replace(/`/g, "'") + '`';
/** 주석은 사용자 글이라 마크다운 · HTML로 해석되지 않게 이스케이프한다 */
const plain = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&').replace(/\r?\n/g, ' ');

function findTable(scope: HoverScope, name: string, schema?: string): MetaTable | undefined {
  const candidates = scope.tables.filter((t) => same(t.name, name) && (!schema || same(t.schema, schema)));
  return candidates.find((t) => same(t.schema, scope.schema)) ?? candidates[0];
}

const resolveRef = (scope: HoverScope, r: TableRef) => findTable(scope, r.name, r.schema);

/** 한정자(별칭 · 테이블 이름)가 가리키는 테이블 */
function byQualifier(scope: HoverScope, refs: TableRef[], q: string): MetaTable | undefined {
  const ref = refs.find((r) => same(r.alias, q)) ?? refs.find((r) => !r.alias && same(r.name, q));
  return ref ? resolveRef(scope, ref) : undefined;
}

/** 이 테이블을 가리키는 다른 테이블의 외래 키 */
function referencedBy(scope: HoverScope, t: MetaTable, column?: string) {
  const out: string[] = [];
  for (const other of scope.tables) {
    for (const k of other.foreignKeys ?? []) {
      if (!same(k.refTable, t.name) || !same(k.refSchema, t.schema)) continue;
      if (column && !k.refColumns.some((c) => same(c, column))) continue;
      out.push(`${code(`${other.schema}.${other.name}`)}(${k.columns.map(code).join(', ')})`);
    }
  }
  return out;
}

const fkText = (k: NonNullable<MetaTable['foreignKeys']>[number]) =>
  `${k.columns.map(code).join(', ')} → ${code(`${k.refSchema}.${k.refTable}`)}(${k.refColumns.map(code).join(', ')})`;

export function tableMarkdown(scope: HoverScope, t: MetaTable, alias?: string): string {
  const lines = [`**${t.kind}** ${code(`${t.schema}.${t.name}`)}${alias ? ` — alias ${code(alias)}` : ''}`, ''];
  if (t.comment) lines.push(plain(t.comment), '');
  const pk = t.primaryKey ?? [];
  if (t.columns.length) {
    for (const c of t.columns.slice(0, MAX_COLUMNS)) {
      const key = pk.some((p) => same(p, c.name)) ? ' · primary key' : '';
      lines.push(`- ${code(c.name)}${c.type ? ` ${c.type.toLowerCase()}` : ''}${key}${c.comment ? ` — ${plain(c.comment)}` : ''}`);
    }
    if (t.columns.length > MAX_COLUMNS) lines.push(`- … ${t.columns.length - MAX_COLUMNS} more`);
    lines.push('');
  }
  if (t.foreignKeys?.length) lines.push(`Foreign keys: ${t.foreignKeys.map(fkText).join('; ')}`, '');
  const by = referencedBy(scope, t);
  if (by.length) lines.push(`Referenced by: ${by.slice(0, MAX_REFERENCED_BY).join(', ')}${by.length > MAX_REFERENCED_BY ? `, … ${by.length - MAX_REFERENCED_BY} more` : ''}`, '');
  if (t.level === 1) lines.push('_Introspection level 1: names only._');
  return lines.join('\n').trim();
}

export function columnMarkdown(scope: HoverScope, t: MetaTable, column: string): string | undefined {
  const c = t.columns.find((x) => same(x.name, column));
  if (!c) return undefined;
  const lines = [`**column** ${code(`${t.name}.${c.name}`)}${c.type ? ` ${c.type.toLowerCase()}` : ''}`, ''];
  if (c.comment) lines.push(plain(c.comment), '');
  lines.push(`in ${t.kind} ${code(`${t.schema}.${t.name}`)}`);
  if ((t.primaryKey ?? []).some((p) => same(p, c.name))) lines.push('', 'Primary key');
  const fks = (t.foreignKeys ?? []).filter((k) => k.columns.some((x) => same(x, c.name)));
  if (fks.length) lines.push('', `Foreign key: ${fks.map(fkText).join('; ')}`);
  const by = referencedBy(scope, t, c.name);
  if (by.length) lines.push('', `Referenced by: ${by.slice(0, MAX_REFERENCED_BY).join(', ')}${by.length > MAX_REFERENCED_BY ? `, … ${by.length - MAX_REFERENCED_BY} more` : ''}`);
  return lines.join('\n');
}

function schemaMarkdown(scope: HoverScope, schema: string): string | undefined {
  const tables = scope.tables.filter((t) => same(t.schema, schema));
  if (!tables.length) return undefined;
  const views = tables.filter((t) => t.kind === 'view').length;
  return `**schema** ${code(tables[0].schema)}\n\n${tables.length - views} tables, ${views} views`;
}

/** offset(문서 기준)에 있는 이름의 정보 */
export function hoverAt(statement: Statement | undefined, offset: number, scope: HoverScope): HoverInfo | undefined {
  if (!statement) return undefined;
  const tokens = statement.tokens.filter((t) => t.type !== 'comment');
  const k = tokens.findIndex((t) => t.start <= offset && offset < t.end);
  const tok = tokens[k];
  if (!isIdent(tok) || tok.open) return undefined;
  const refs = collectTableRefs(statement.tokens);
  const name = identName(tok);
  const at = (markdown: string | undefined) => (markdown ? { start: tok.start, end: tok.end, markdown } : undefined);

  const prev: Token | undefined = tokens[k - 1]?.text === '.' && isIdent(tokens[k - 2]) ? tokens[k - 2] : undefined;
  const next: Token | undefined = tokens[k + 1]?.text === '.' && isIdent(tokens[k + 2]) ? tokens[k + 2] : undefined;
  // 뒤에 ( 가 오면 함수 호출(count(…), schema.fn(…)) — INSERT INTO t (…) 의 t만 테이블이다
  if (tokens[k + 1]?.text === '(') {
    const before = tokens[k - (prev ? 3 : 1)];
    const t = before?.type === 'word' && /^into$/i.test(before.text) ? findTable(scope, name, prev && identName(prev)) : undefined;
    return t ? at(tableMarkdown(scope, t)) : undefined;
  }

  if (prev) {
    // q.name — q가 별칭 · 테이블이면 열, 스키마면 테이블
    const q = identName(prev);
    if (tokens[k - 3]?.text === '.' && isIdent(tokens[k - 4])) {
      // s.t.col
      const t = findTable(scope, q, identName(tokens[k - 4]));
      return t ? at(columnMarkdown(scope, t, name)) : undefined;
    }
    const t = byQualifier(scope, refs, q);
    if (t) return at(columnMarkdown(scope, t, name));
    const inSchema = findTable(scope, name, q);
    if (inSchema) {
      const ref = refs.find((r) => same(r.schema, q) && same(r.name, name));
      return at(tableMarkdown(scope, inSchema, ref?.alias));
    }
    const direct = findTable(scope, q);
    return direct ? at(columnMarkdown(scope, direct, name)) : undefined;
  }

  if (next) {
    // name.x — 별칭 · 테이블 · 스키마
    const t = byQualifier(scope, refs, name);
    if (t) return at(tableMarkdown(scope, t, refs.some((r) => same(r.alias, name)) ? name : undefined));
    if (scope.tables.some((x) => same(x.schema, name) && same(x.name, identName(next)))) return at(schemaMarkdown(scope, name));
    const direct = findTable(scope, name);
    return direct ? at(tableMarkdown(scope, direct)) : at(schemaMarkdown(scope, name));
  }

  // 별칭
  const aliased = refs.find((r) => same(r.alias, name));
  if (aliased) {
    const t = resolveRef(scope, aliased);
    return t ? at(tableMarkdown(scope, t, aliased.alias)) : undefined;
  }
  // FROM 등에 쓴 테이블 이름
  const ref = refs.find((r) => !r.schema && same(r.name, name));
  if (ref) {
    const t = resolveRef(scope, ref);
    if (t) return at(tableMarkdown(scope, t, ref.alias));
  }
  // 열: 이 문장의 테이블들에서 찾는다
  const owners = refs.map((r) => resolveRef(scope, r)).filter((t): t is MetaTable => !!t && t.columns.some((c) => same(c.name, name)));
  const unique = [...new Set(owners)];
  if (unique.length) return at(unique.map((t) => columnMarkdown(scope, t, name)!).join('\n\n---\n\n'));
  // 그 밖의 자리(ALTER TABLE x, 문장에 없는 테이블)
  const t = findTable(scope, name);
  return t ? at(tableMarkdown(scope, t)) : undefined;
}
