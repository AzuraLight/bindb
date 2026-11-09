/*
 * 결과 내보내기 · 형식 복사(DataGrip의 data extractors 자리). 확장(파일로 내보내기)과
 * webview(선택 영역 복사)가 함께 쓴다 — vscode · Node에 기대지 않는다.
 *
 * 행 단위로 쓰는 모양(header → row … → footer)이라 큰 결과도 한 줄씩 파일에 흘려 쓸 수 있다.
 * 값은 그리드가 받는 CellValue: string | number | boolean | null | { $bin, hex? }.
 */

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'markdown' | 'sql-insert';

export const EXPORT_FORMATS: { id: ExportFormat; label: string; ext: string }[] = [
  { id: 'csv', label: 'CSV', ext: 'csv' },
  { id: 'tsv', label: 'TSV', ext: 'tsv' },
  { id: 'json', label: 'JSON', ext: 'json' },
  { id: 'markdown', label: 'Markdown table', ext: 'md' },
  { id: 'sql-insert', label: 'SQL INSERT statements', ext: 'sql' },
];

/** 바이너리는 길이와(받았으면) 16진 내용 */
export type BinaryCell = { $bin: number; hex?: string };
export type ExportCell = string | number | boolean | null | BinaryCell;

export type SqlDialect = 'postgres' | 'mysql' | 'sqlite' | 'h2';

export interface ExportOptions {
  /** sql-insert: 테이블 이름(이미 인용된 이름이면 그대로). 없으면 MY_TABLE */
  table?: string;
  dialect?: SqlDialect;
}

export interface RowWriter {
  header(columns: string[]): string;
  row(values: ExportCell[]): string;
  footer(): string;
}

const isBin = (v: ExportCell): v is BinaryCell => typeof v === 'object' && v !== null;
const binText = (v: BinaryCell) => (v.hex !== undefined ? `0x${v.hex}` : `<binary ${v.$bin} bytes>`);

/** CSV · TSV: RFC 4180. 구분자 · 따옴표 · 줄바꿈 · 앞뒤 공백이 있으면 따옴표로 감싼다. NULL은 빈 칸, 빈 문자열은 "" */
function dsv(sep: string): RowWriter {
  const field = (v: ExportCell): string => {
    if (v === null) return '';
    const s = isBin(v) ? binText(v) : String(v);
    if (s === '') return '""';
    return s.includes(sep) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return {
    header: (cols) => `${cols.map(field).join(sep)}\r\n`,
    row: (vals) => `${vals.map(field).join(sep)}\r\n`,
    footer: () => '',
  };
}

/** 같은 이름의 컬럼은 name, name_2, name_3 … */
export function uniqueNames(columns: string[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((c) => {
    const n = (seen.get(c) ?? 0) + 1;
    seen.set(c, n);
    let name = n === 1 ? c : `${c}_${n}`;
    while (n > 1 && columns.includes(name)) name = `${name}_`;
    return name;
  });
}

function json(): RowWriter {
  let keys: string[] = [];
  let first = true;
  const value = (v: ExportCell) => (isBin(v) ? (v.hex !== undefined ? `0x${v.hex}` : null) : v);
  return {
    header: (cols) => {
      keys = uniqueNames(cols);
      first = true;
      return '[\n';
    },
    row: (vals) => {
      const obj: Record<string, unknown> = {};
      keys.forEach((k, i) => (obj[k] = value(vals[i] ?? null)));
      const out = `${first ? '' : ',\n'}  ${JSON.stringify(obj)}`;
      first = false;
      return out;
    },
    footer: () => `${first ? '' : '\n'}]\n`,
  };
}

/** Markdown 표: | 는 \|, 줄바꿈은 <br>, NULL은 빈 칸 */
function markdown(): RowWriter {
  const cell = (v: ExportCell) => {
    if (v === null) return '';
    const s = isBin(v) ? binText(v) : String(v);
    return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
  };
  return {
    header: (cols) => `| ${cols.map(cell).join(' | ')} |\n|${cols.map(() => ' --- ').join('|')}|\n`,
    row: (vals) => `| ${vals.map(cell).join(' | ')} |\n`,
    footer: () => '',
  };
}

const QUOTE: Record<SqlDialect, string> = { postgres: '"', mysql: '`', sqlite: '"', h2: '"' };

export function quoteIdent(dialect: SqlDialect, name: string): string {
  const q = QUOTE[dialect];
  return q + name.split(q).join(q + q) + q;
}

/**
 * SQL 리터럴.
 * MySQL에서 \ 의 뜻은 sql_mode에 달렸다: 기본은 이스케이프 문자, NO_BACKSLASH_ESCAPES면 글자 그대로
 * (https://dev.mysql.com/doc/refman/8.0/en/string-literals.html). 어느 쪽에서 실행해도 같은 값이 되도록
 * \ 가 든 문자열은 UTF-8 16진 문자열(_utf8mb4 X'…')로 쓴다. 나머지는 '' 만 쓰면 두 모드에서 같다.
 */
export function sqlLiteral(dialect: SqlDialect, v: ExportCell): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : `'${v}'`;
  if (typeof v === 'boolean') return dialect === 'sqlite' ? (v ? '1' : '0') : v ? 'TRUE' : 'FALSE';
  if (isBin(v)) {
    if (v.hex === undefined) return 'NULL /* binary not loaded */';
    return dialect === 'postgres' ? `'\\x${v.hex}'::bytea` : `X'${v.hex}'`;
  }
  if (dialect === 'mysql' && v.includes('\\')) {
    const hex = Array.from(new TextEncoder().encode(v), (b) => b.toString(16).padStart(2, '0')).join('');
    return `_utf8mb4 X'${hex}'`;
  }
  return `'${v.replace(/'/g, "''")}'`;
}

function sqlInsert(opts: ExportOptions): RowWriter {
  const dialect = opts.dialect ?? 'postgres';
  let prefix = '';
  return {
    header: (cols) => {
      prefix = `INSERT INTO ${opts.table ?? 'MY_TABLE'} (${cols.map((c) => quoteIdent(dialect, c)).join(', ')}) VALUES `;
      return '';
    },
    row: (vals) => `${prefix}(${vals.map((v) => sqlLiteral(dialect, v)).join(', ')});\n`,
    footer: () => '',
  };
}

export function writerFor(format: ExportFormat, opts: ExportOptions = {}): RowWriter {
  switch (format) {
    case 'csv':
      return dsv(',');
    case 'tsv':
      return dsv('\t');
    case 'json':
      return json();
    case 'markdown':
      return markdown();
    case 'sql-insert':
      return sqlInsert(opts);
  }
}

/** 한 번에 문자열로(선택 영역 복사 등 작은 결과) */
export function formatRows(format: ExportFormat, columns: string[], rows: ExportCell[][], opts: ExportOptions = {}): string {
  const w = writerFor(format, opts);
  return w.header(columns) + rows.map((r) => w.row(r)).join('') + w.footer();
}
