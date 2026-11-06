import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/*
 * 실행 기록(DataGrip의 Query History: 데이터 소스마다 실행한 문장).
 *  - 연결마다 최근 MAX개. 바로 앞과 같은 문장이면 새로 쌓지 않고 시각 · 결과만 갱신한다
 *  - 아주 긴 문장은 MAX_SQL 글자에서 자른다
 *  - 파일이 깨져 있으면 옆에 남겨 두고(.corrupt) 빈 기록으로 시작한다
 *  - 쓰기는 한 줄로 세워 차례로(동시에 써도 섞이지 않게), 임시 파일에 쓴 뒤 이름을 바꾼다
 */

export interface HistoryEntry {
  sql: string;
  /** 실행한 시각(ms) */
  at: number;
  ms?: number;
  rows?: number;
  error?: string;
  /** 같은 문장을 연달아 실행한 횟수 */
  count?: number;
}

export const MAX_ENTRIES = 500;
export const MAX_SQL = 100_000;

export type HistoryData = Record<string, HistoryEntry[]>;

/** 기록 하나를 더한다(순수 함수). 최신이 앞 */
export function addEntry(list: readonly HistoryEntry[], entry: HistoryEntry, max = MAX_ENTRIES): HistoryEntry[] {
  const sql = entry.sql.length > MAX_SQL ? `${entry.sql.slice(0, MAX_SQL)}\n-- … truncated (${entry.sql.length} chars)` : entry.sql;
  const e = { ...entry, sql };
  if (list[0] && normalize(list[0].sql) === normalize(sql)) {
    return [{ ...e, count: (list[0].count ?? 1) + 1 }, ...list.slice(1)];
  }
  return [e, ...list].slice(0, max);
}

const normalize = (s: string) => s.trim().replace(/\s+/g, ' ');

/** 찾기: 모든 낱말이 들어 있는 기록(대소문자 무시) */
export function searchEntries(list: readonly HistoryEntry[], query: string): HistoryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? list.filter((e) => words.every((w) => e.sql.toLowerCase().includes(w))) : [...list];
}

export class HistoryStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  /**
   * 파일을 읽는다(캐시하지 않는다 — 다른 VS Code 창이 쓴 기록을 지우지 않게).
   * 없으면 빈 기록, 깨졌으면 옆에 남기고 빈 기록, 그 밖의 읽기 오류(권한 등)는 던진다(덮어쓰지 않게).
   */
  private async load(): Promise<HistoryData> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed as HistoryData;
    } catch {
      await rename(this.file, `${this.file}.corrupt`).catch(() => {});
      return {};
    }
  }

  async list(connectionId: string): Promise<HistoryEntry[]> {
    await this.chain;
    return (await this.load())[connectionId] ?? [];
  }

  /** 차례로: 새로 읽고 → 고치고 → 임시 파일에 써서 이름을 바꾼다 */
  private update(fn: (d: HistoryData) => void): Promise<void> {
    const next = this.chain.then(async () => {
      const d = await this.load();
      fn(d);
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(d), 'utf8');
      await rename(tmp, this.file);
    });
    this.chain = next.catch(() => {});
    return next;
  }

  add(connectionId: string, entry: HistoryEntry): Promise<void> {
    return this.update((d) => (d[connectionId] = addEntry(d[connectionId] ?? [], entry)));
  }

  /** 연결을 지우면 그 기록도 지운다 */
  remove(connectionId: string): Promise<void> {
    return this.update((d) => delete d[connectionId]);
  }

  clear(connectionId: string): Promise<void> {
    return this.update((d) => (d[connectionId] = []));
  }
}
