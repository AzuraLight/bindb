import type { DriverId } from '../drivers/types';
import { splitStatements } from '../language/splitter';
import { identName, tokenize, type Token } from '../language/tokenizer';

/*
 * 문장 판정: 실행하기 전에 "읽기만 하는가"를 정한다. 읽기 전용 연결 · AI 조회 도구가 쓴다.
 * 실행한 뒤에 확인하면 이미 늦다(DDL은 암묵적으로 커밋되는 DB가 있다 — H2 · MySQL).
 *
 * 보수적으로 본다: 확실히 읽기인 것만 read. 모르는 모양은 write로 본다.
 *  - 문장이 둘 이상이면 거부(H2 · MySQL은 한 번에 여러 문장을 보낼 수 있다)
 *  - SELECT · WITH · VALUES · TABLE · SHOW · DESCRIBE · EXPLAIN(ANALYZE는 대상이 읽기일 때만)
 *  - WITH 안의 INSERT · UPDATE · DELETE · MERGE, SELECT … INTO(테이블 · 파일을 만든다)는 쓰기
 *  - 부수 효과가 있는 함수(파일 쓰기 · 다른 연결로 실행 · 설정 변경 · 시퀀스 증가 등)는 쓰기
 *  - SQLite PRAGMA는 값을 주지 않는 것(PRAGMA x, PRAGMA x(y))만 읽기
 */

export type StatementKind = 'read' | 'write' | 'transaction' | 'empty';

export interface Classification {
  kind: StatementKind;
  /** 왜 쓰기로 보았는가(사용자에게 보여 준다) */
  reason?: string;
}

const READ_START = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN']);
const TX = new Set(['BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'END', 'SAVEPOINT', 'RELEASE']);
const DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'REPLACE', 'TRUNCATE', 'CREATE', 'DROP', 'ALTER', 'GRANT', 'REVOKE', 'CALL', 'COPY', 'LOAD', 'HANDLER', 'DO']);

/** 읽기 문장 안에 있으면 쓰기로 보는 함수(대소문자 무시) */
const SIDE_EFFECT_FUNCTIONS: Record<DriverId, string[]> = {
  postgres: [
    'dblink_exec', 'dblink', 'dblink_send_query', 'lo_import', 'lo_export', 'lo_unlink', 'lo_create', 'lo_put',
    'set_config', 'nextval', 'setval', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf',
    'pg_rotate_logfile', 'pg_switch_wal', 'pg_create_restore_point', 'pg_advisory_lock', 'pg_advisory_xact_lock',
    'pg_notify', 'pg_promote', 'pg_logical_emit_message', 'txid_current', 'pg_current_xact_id', 'pg_file_write',
    'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'query_to_xml',
  ],
  mysql: ['load_file', 'get_lock', 'release_lock', 'sleep', 'benchmark', 'sys_exec', 'sys_eval'],
  sqlite: ['load_extension', 'writefile', 'edit', 'fts3_tokenizer', 'readfile'],
  h2: [
    'file_write', 'csvwrite', 'file_read', 'csvread', 'link_schema', 'set', 'nextval', 'next value',
    'cancel_session', 'abort_session', 'disk_space_used', 'lock_mode', 'memory_free', 'session_id', 'transaction_id',
  ],
};

const word = (t: Token | undefined) => (t && t.type === 'word' ? t.text.toUpperCase() : undefined);
/** 함수 이름으로 쓰일 수 있는 토큰의 이름: 낱말 또는 인용 식별자("FILE_WRITE"(…)도 같은 함수다) */
const callee = (t: Token | undefined) => (t && (t.type === 'word' || t.type === 'quoted') ? identName(t).toLowerCase() : undefined);

/**
 * SQLite에서 괄호로 인자를 받아도 값을 읽기만 하는 PRAGMA(테이블 · 인덱스 이름을 받는다).
 * 그 밖의 PRAGMA x(값)은 PRAGMA x = 값과 같다 — https://www.sqlite.org/pragma.html
 */
const SQLITE_READ_PRAGMAS = new Set([
  'TABLE_INFO', 'TABLE_XINFO', 'TABLE_LIST', 'INDEX_LIST', 'INDEX_INFO', 'INDEX_XINFO', 'FOREIGN_KEY_LIST',
  'FOREIGN_KEY_CHECK', 'INTEGRITY_CHECK', 'QUICK_CHECK',
]);
/** 인자 없이도 파일을 바꾸는 PRAGMA(ANALYZE · freelist 정리 · 체크포인트) — https://www.sqlite.org/pragma.html */
const SQLITE_WRITE_PRAGMAS = new Set(['OPTIMIZE', 'INCREMENTAL_VACUUM', 'WAL_CHECKPOINT']);

/** 문장 하나를 판정한다 */
function classifyOne(tokens: Token[], driver: DriverId): Classification {
  const code = tokens.filter((t) => t.type !== 'comment');
  const first = word(code[0]);
  if (!first) return { kind: 'empty' };
  if (TX.has(first)) {
    // BEGIN · START TRANSACTION은 읽기/쓰기 모드를 바꿀 수 있다 — READ WRITE는 쓰기로 본다
    if (code.some((t, i) => word(t) === 'READ' && word(code[i + 1]) === 'WRITE')) return { kind: 'write', reason: 'it opens a read-write transaction' };
    return { kind: 'transaction' };
  }

  if (driver === 'sqlite' && first === 'PRAGMA') {
    if (code.some((t) => t.type === 'punct' && t.text === '=')) return { kind: 'write', reason: 'PRAGMA … = sets a value' };
    // PRAGMA [schema.]name(arg)
    const nameAt = code[2]?.type === 'punct' && code[2].text === '.' ? 3 : 1;
    const hasArg = code.some((t) => t.type === 'punct' && t.text === '(');
    if (SQLITE_WRITE_PRAGMAS.has(word(code[nameAt]) ?? '')) return { kind: 'write', reason: `PRAGMA ${word(code[nameAt])!.toLowerCase()} changes the file` };
    if (hasArg && !SQLITE_READ_PRAGMAS.has(word(code[nameAt]) ?? '')) return { kind: 'write', reason: 'PRAGMA … (value) sets a value' };
    return { kind: 'read' };
  }

  if (!READ_START.has(first)) return { kind: 'write', reason: `${first} statements change data or settings` };

  for (let i = 0; i < code.length; i++) {
    const next = code[i + 1];
    const fn = callee(code[i]);
    if (fn && next?.type === 'punct' && next.text === '(' && SIDE_EFFECT_FUNCTIONS[driver].includes(fn)) {
      return { kind: 'write', reason: `${fn}() has side effects` };
    }
    const w = word(code[i]);
    if (!w) continue;
    if (DML.has(w)) {
      // 함수 이름 · 열 이름이 아니라 키워드로 쓰였을 때만(다음이 "(" 이면 함수 · 표현식)
      const prev = code[i - 1];
      const asName = (next?.type === 'punct' && next.text === '(' && w !== 'INSERT') || (prev?.type === 'punct' && prev.text === '.');
      if (!asName) return { kind: 'write', reason: `it contains ${w}` };
    }
    // EXPLAIN ANALYZE는 문장을 실제로 실행한다
    const analyzes = first === 'EXPLAIN' && code.some((t) => word(t) === 'ANALYZE' || word(t) === 'ANALYSE');
    if (w === 'INTO' && (first !== 'EXPLAIN' || analyzes)) return { kind: 'write', reason: 'SELECT … INTO creates a table or file' };
    if (w === 'OUTFILE' || w === 'DUMPFILE') return { kind: 'write', reason: 'it writes a file' };
    // 행 잠금: FOR UPDATE · FOR SHARE · FOR NO KEY UPDATE · FOR KEY SHARE(postgres), LOCK IN SHARE MODE(mysql)
    if (w === 'FOR' && ['UPDATE', 'SHARE', 'NO', 'KEY'].includes(word(code[i + 1]) ?? '')) return { kind: 'write', reason: 'SELECT … FOR UPDATE/SHARE locks rows' };
    if (w === 'LOCK' && word(code[i + 1]) === 'IN' && word(code[i + 2]) === 'SHARE') return { kind: 'write', reason: 'LOCK IN SHARE MODE locks rows' };
    if (driver === 'h2' && w === 'NEXT' && word(code[i + 1]) === 'VALUE') return { kind: 'write', reason: 'NEXT VALUE FOR advances a sequence' };
  }
  return { kind: 'read' };
}

/** SQL 전체를 판정한다. 문장이 둘 이상이면 write(한 번에 하나만 허용) */
export function classifySql(sql: string, driver: DriverId): Classification {
  const statements = splitStatements(sql, driver).filter((s) => s.text.trim());
  if (statements.length === 0) return { kind: 'empty' };
  if (statements.length > 1) return { kind: 'write', reason: 'it contains more than one statement' };
  // 문장 끝 세미콜론 뒤에 다른 것이 붙어 있지 않은지는 splitStatements가 이미 나눴다
  return classifyOne(tokenize(statements[0].text, driver), driver);
}

/** 읽기만 하는가 */
export const isReadOnlySql = (sql: string, driver: DriverId) => classifySql(sql, driver).kind === 'read';
