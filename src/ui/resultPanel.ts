import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as vscode from 'vscode';
import { classifySql } from '../core/classify';
import { withSessionTemplate } from '../core/connectionDraft';
import { kw, withCodeStyle } from '../core/ddl';
import { buildEditStatements, emptyChanges, type EditValue, type PendingChanges } from '../core/editing';
import { buildFilteredSql, isWrappable } from '../core/gridQuery';
import type { HistoryStore } from '../core/history';
import type { RunContext, SessionManager } from '../core/sessions';
import type { ConnectionConfig, MetaTable, QueryCursor } from '../drivers';
import { EXPORT_FORMATS, quoteIdent, writerFor, type ExportCell, type ExportFormat } from '../shared/exportFormats';
import type { CellValue, Editability, HostToWebview, WebviewToHost, WireChanges } from '../shared/protocol';
import { errorText } from './explorer';

/** 테이블 데이터로 열었을 때의 정보(편집 · WHERE/ORDER BY가 테이블에 바로 붙는다) */
interface TableSource {
  table: MetaTable;
  /** 인용된 이름 */
  quoted: string;
  /** SELECT 목록(가상 컬럼 · SQLite rowid 포함) */
  select: string;
  /** 행을 찾는 열 */
  key: string[];
  /** 결과 열 중 테이블의 실제 열(편집할 수 있는 열) */
  realColumns: Set<string>;
}

interface Current {
  qid: string;
  cfg: ConnectionConfig;
  ctx: RunContext;
  /** 사용자가 실행한 원래 문장(쿼리 결과) */
  query?: string;
  source?: TableSource;
  where: string;
  orderBy: string;
  /** 지금 실행한 SQL(필터 적용 후) */
  sql: string;
  columns: string[];
  cursor?: QueryCursor;
  offset: number;
  started: number;
  fetching: boolean;
}

/** 결과 그리드. 패널 하나를 재사용한다. */
export class ResultPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private queue: HostToWebview[] = [];
  private current?: Current;
  private seq = 0;
  /** 내보낼 파일 고르기. 통합 테스트에서만 바꾼다(저장 창은 테스트가 누를 수 없다) */
  pickExportFile = async (title: string, defaultName: string, filters: Record<string, string[]>) =>
    vscode.window.showSaveDialog({ title, defaultUri: vscode.Uri.file(defaultName), filters });

  /** 통합 테스트가 그리드로 간 메시지를 확인하는 데 쓴다 */
  readonly trace: HostToWebview[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessions: SessionManager,
    private readonly history?: HistoryStore,
  ) {}

  /** 문장을 실행하고 결과를 그리드로 보여 준다(실행 기록에 남긴다). */
  async run(cfg: ConnectionConfig, sql: string, ctx: RunContext = {}): Promise<void> {
    await this.start({ cfg, ctx, query: sql, where: '', orderBy: '' }, true);
  }

  /** 테이블 데이터를 연다(편집 · 필터는 테이블에 바로). select: 가상 컬럼을 더한 SELECT 목록 */
  async openTable(cfg: ConnectionConfig, table: MetaTable, ctx: RunContext = {}, select = '*'): Promise<void> {
    const q = (s: string) => quoteIdent(cfg.driver, s);
    const quoted = cfg.driver === 'sqlite' ? q(table.name) : `${q(table.schema)}.${q(table.name)}`;
    let key = table.primaryKey ?? [];
    let sel = select;
    const names = new Set(table.columns.map((c) => c.name.toLowerCase()));
    // SQLite: 기본키가 없으면 rowid로 행을 찾는다(사용자 열 이름이 rowid면 쓸 수 없다)
    if (!key.length && cfg.driver === 'sqlite' && table.kind === 'table' && !names.has('rowid')) {
      key = ['rowid'];
      sel = `rowid, ${select}`;
    }
    const realColumns = new Set([...table.columns.map((c) => c.name), ...(key[0] === 'rowid' ? ['rowid'] : [])]);
    await this.start({ cfg, ctx, source: { table, quoted, select: sel, key, realColumns }, where: '', orderBy: '' }, false);
  }

  private async start(base: Omit<Current, 'qid' | 'sql' | 'columns' | 'offset' | 'started' | 'fetching'>, record: boolean): Promise<void> {
    this.ensurePanel();
    const built = withCodeStyle(base.cfg.codeStyle, () =>
      base.source
        ? buildFilteredSql({ table: base.source.quoted, select: base.source.select }, base, kw, base.cfg.driver)
        : buildFilteredSql({ query: base.query!, columns: this.current?.columns }, base, kw, base.cfg.driver),
    );
    const qid = `q${++this.seq}`;
    // 필터가 거부돼도 이 실행을 "지금 것"으로 삼는다 — 웹뷰가 이 qid로 고친 필터를 다시 보낸다
    const cur: Current = { ...base, qid, sql: built.ok ? built.sql : '', columns: this.current?.columns ?? [], offset: 0, started: Date.now(), fetching: false };
    this.current = cur;
    if (!built.ok) {
      this.post({ t: 'running', qid, sql: base.query ?? '', connection: base.cfg.name });
      this.post({ t: 'result/error', qid, message: built.error });
      return;
    }
    this.post({ t: 'running', qid, sql: base.query ?? built.sql, connection: base.cfg.name });

    let cursor: QueryCursor;
    try {
      cursor = await this.sessions.execute(base.cfg, built.sql, base.ctx);
    } catch (e) {
      if (record) await this.record(cur, { error: errorText(e) });
      this.post({ t: 'result/error', qid, message: errorText(e) });
      return;
    }
    if (this.current !== cur) {
      // 실행 중에 다른 문장이 시작됐다. 이 결과는 버린다(다음 실행이 커서를 닫는다).
      return;
    }
    if (cursor.columns.length === 0) {
      if (record) await this.record(cur, { rows: cursor.affectedRows });
      this.post({ t: 'result/update', qid, affectedRows: cursor.affectedRows ?? null, elapsedMs: Date.now() - cur.started });
      await cursor.close();
      return;
    }
    cur.cursor = cursor;
    cur.columns = cursor.columns.map((c) => c.name);
    const filterable: true | string = base.source || (base.query && isWrappable(base.query, base.cfg.driver)) ? true : 'Filtering and sorting work on SELECT queries only.';
    this.post({
      t: 'result/start',
      qid,
      sql: base.query ?? built.sql,
      connection: base.cfg.name,
      columns: cursor.columns,
      table: base.source ? `${base.source.table.schema}.${base.source.table.name}` : undefined,
      dialect: base.cfg.driver,
      quotedTable: base.source?.quoted,
      exportable: this.exportable(cur),
      filterable,
      filter: { where: base.where, orderBy: base.orderBy },
      edit: this.editability(cur),
    });
    await this.fetchMore(cur);
    if (record) await this.record(cur, {});
    this.post({ t: 'result/stats', qid, elapsedMs: Date.now() - cur.started });
  }

  /** 내보내기는 같은 SQL을 다시 실행한다 — 읽기 문장일 때만 */
  private exportable(cur: Current): true | string {
    if (cur.source) return true;
    const c = classifySql(cur.sql, cur.cfg.driver);
    return c.kind === 'read' ? true : `Export runs the statement again, and this one is not read-only (${c.reason ?? c.kind}). Copy the loaded rows instead.`;
  }

  private editability(cur: Current): Editability {
    const s = cur.source;
    if (!s) return { editable: false, reason: 'Query results are read-only. Open the table (Open Table Data) to edit rows.' };
    if (withSessionTemplate(cur.cfg).readOnly) return { editable: false, reason: `${cur.cfg.name} is read-only.` };
    if (cur.cfg.kind === 'ddl') return { editable: false, reason: 'DDL data sources have no data.' };
    if (s.table.kind === 'view') return { editable: false, reason: 'Views are read-only here.' };
    if (!s.key.length) return { editable: false, reason: `${s.table.name} has no primary key, so rows cannot be identified.` };
    const missing = s.key.find((k) => !cur.columns.includes(k));
    if (missing) return { editable: false, reason: `The key column ${missing} is not in the result.` };
    // H2 배열은 H2가 주는 글자([a, b])로 보인다. 그 글자를 다시 보내면 원소 하나짜리 배열 [[a, b]]이 된다 — 편집하지 않는다
    const arrays = new Set(cur.cfg.driver === 'h2' ? s.table.columns.filter((c) => /ARRAY/i.test(c.type ?? '')).map((c) => c.name) : []);
    return { editable: true, key: s.key, columns: cur.columns.map((c) => s.realColumns.has(c) && c !== 'rowid' && !arrays.has(c)) };
  }

  private async record(cur: Current, extra: { rows?: number; error?: string }): Promise<void> {
    if (!this.history || !cur.query) return;
    await this.history
      .add(cur.cfg.id, { sql: cur.query.trim(), at: cur.started, ms: Date.now() - cur.started, ...(extra.rows !== undefined ? { rows: extra.rows } : {}), ...(extra.error ? { error: extra.error } : {}) })
      .catch(() => {});
  }

  async cancel(): Promise<void> {
    const cur = this.current;
    if (cur) await this.sessions.cancel(cur.cfg, cur.ctx).catch(() => {});
  }

  private async fetchMore(cur: Current): Promise<void> {
    if (!cur.cursor || cur.fetching) return;
    cur.fetching = true;
    const pageSize = vscode.workspace.getConfiguration('bindb').get<number>('grid.pageSize', 500);
    try {
      const { rows, done } = await this.sessions.fetch(cur.cursor, pageSize);
      this.post({ t: 'result/rows', qid: cur.qid, offset: cur.offset, rows: rows.map((r) => r.map(toCell)), done });
      cur.offset += rows.length;
      if (done) cur.cursor = undefined;
    } catch (e) {
      cur.cursor = undefined;
      this.post({ t: 'result/error', qid: cur.qid, message: errorText(e) });
    } finally {
      cur.fetching = false;
    }
  }

  private changesOf(cur: Current, w: WireChanges): { rows: ExportCell[][]; changes: PendingChanges } {
    const rows: ExportCell[][] = [];
    const changes = emptyChanges();
    for (const u of w.updates) {
      rows[u.row] = u.original;
      changes.updates.set(u.row, new Map(u.cells as [number, EditValue][]));
    }
    for (const d of w.deletes) {
      rows[d.row] = d.original;
      changes.deletes.add(d.row);
    }
    changes.inserts = w.inserts.map((cells) => new Map(cells as [number, EditValue][]));
    return { rows, changes };
  }

  private build(cur: Current, w: WireChanges) {
    const e = this.editability(cur);
    if (!e.editable) return { ok: false as const, error: e.reason };
    const { rows, changes } = this.changesOf(cur, w);
    // 편집할 수 없는 열(가상 컬럼 · rowid)을 고친 경우 거부한다
    for (const [, cells] of changes.updates) for (const [c] of cells) if (!e.columns[c]) return { ok: false as const, error: `${cur.columns[c]} cannot be edited.` };
    for (const cells of changes.inserts) for (const [c] of cells) if (!e.columns[c]) return { ok: false as const, error: `${cur.columns[c]} cannot be edited.` };
    return buildEditStatements({ dialect: cur.cfg.driver, table: cur.source!.quoted, columns: cur.columns, key: e.key }, rows, changes);
  }

  private async submit(cur: Current, w: WireChanges): Promise<void> {
    const built = this.build(cur, w);
    if (!built.ok) {
      this.post({ t: 'edit/result', qid: cur.qid, ok: false, message: built.error });
      return;
    }
    try {
      const { committed } = await this.sessions.applyEdits(cur.cfg, built.statements, cur.ctx);
      const n = built.statements.length;
      this.post({
        t: 'edit/result',
        qid: cur.qid,
        ok: true,
        message: committed ? `${n} change(s) saved.` : `${n} change(s) applied in the open transaction — Commit to keep them.`,
      });
      // 저장한 뒤 다시 읽는다(기본값 · 트리거가 바꾼 값이 보이게)
      await this.start({ cfg: cur.cfg, ctx: cur.ctx, query: cur.query, source: cur.source, where: cur.where, orderBy: cur.orderBy }, false);
    } catch (e) {
      this.post({ t: 'edit/result', qid: cur.qid, ok: false, message: `Nothing was saved. ${errorText(e)}` });
    }
  }

  /** 결과 전체를 파일로. 같은 SQL을 다시 실행해 한 페이지씩 흘려 쓴다 */
  private async exportAll(cur: Current, format: ExportFormat): Promise<void> {
    const allowed = this.exportable(cur);
    if (allowed !== true) {
      this.post({ t: 'notice', message: allowed, error: true });
      return;
    }
    const fmt = EXPORT_FORMATS.find((f) => f.id === format)!;
    const base = cur.source ? cur.source.table.name : 'result';
    const uri = await this.pickExportFile(`Export ${fmt.label}`, `${base}.${fmt.ext}`, { [fmt.label]: [fmt.ext] });
    if (!uri) return;
    const writer = writerFor(format, { dialect: cur.cfg.driver, table: cur.source?.quoted });
    const out = createWriteStream(uri.fsPath, { encoding: 'utf8' });
    const write = (s: string) => (s ? new Promise<void>((res, rej) => out.write(s, (e) => (e ? rej(e) : res()))) : Promise.resolve());
    let count = 0;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Exporting to ${uri.fsPath}`, cancellable: true },
        async (progress, token) => {
          const cursor = await this.sessions.execute(cur.cfg, cur.sql, cur.ctx);
          try {
            await write(writer.header(cursor.columns.map((c) => c.name)));
            for (;;) {
              if (token.isCancellationRequested) throw new Error('Export cancelled.');
              const { rows, done } = await this.sessions.fetch(cursor, 2000);
              for (const r of rows) await write(writer.row(r.map(toExportCell)));
              count += rows.length;
              progress.report({ message: `${count} rows` });
              if (done) break;
            }
            await write(writer.footer());
          } finally {
            await cursor.close().catch(() => {});
          }
        },
      );
      await new Promise<void>((res) => out.end(() => res()));
      this.post({ t: 'notice', message: `Exported ${count} rows to ${uri.fsPath}.` });
    } catch (e) {
      out.destroy();
      this.post({ t: 'notice', message: `Export failed: ${errorText(e)}`, error: true });
    }
  }

  private onMessage(msg: WebviewToHost): void {
    if (msg.t === 'ready') {
      this.ready = true;
      for (const m of this.queue.splice(0)) void this.panel?.webview.postMessage(m);
      return;
    }
    const cur = this.current;
    if (!cur || cur.qid !== msg.qid) return;
    switch (msg.t) {
      case 'fetch':
        void this.fetchMore(cur);
        break;
      case 'cancel':
        void this.cancel();
        break;
      case 'filter':
      case 'refresh':
        void this.start(
          {
            cfg: cur.cfg,
            ctx: cur.ctx,
            query: cur.query,
            source: cur.source,
            where: msg.t === 'filter' ? msg.where : cur.where,
            orderBy: msg.t === 'filter' ? msg.orderBy : cur.orderBy,
          },
          false,
        );
        break;
      case 'export':
        void this.exportAll(cur, msg.format);
        break;
      case 'edit/preview': {
        const built = this.build(cur, msg.changes);
        this.post(built.ok ? { t: 'edit/preview', qid: cur.qid, statements: built.statements.map((s) => s.preview) } : { t: 'edit/preview', qid: cur.qid, error: built.error });
        break;
      }
      case 'edit/submit':
        void this.submit(cur, msg.changes);
        break;
    }
  }

  private post(msg: HostToWebview): void {
    this.trace.push(msg);
    if (this.trace.length > 200) this.trace.splice(0, this.trace.length - 200);
    if (this.ready) void this.panel?.webview.postMessage(msg);
    else this.queue.push(msg);
  }

  /** 통합 테스트: 그리드가 보낸 것처럼 메시지를 넣는다 */
  receive(msg: WebviewToHost): void {
    this.onMessage(msg);
  }

  get currentQid(): string | undefined {
    return this.current?.qid;
  }

  private ensurePanel(): void {
    if (this.panel) {
      if (!this.panel.visible) this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    const outUri = vscode.Uri.joinPath(this.extensionUri, 'out', 'webview');
    const panel = vscode.window.createWebviewPanel(
      'bindb.results',
      'BindB Results',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [outUri] },
    );
    const nonce = randomBytes(16).toString('base64');
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(outUri, 'grid.js'));
    const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(outUri, 'grid.css'));
    panel.webview.html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data:; style-src ${panel.webview.cspSource} 'unsafe-inline'; font-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
</head><body><div id="root"></div><div id="portal" style="position:fixed;left:0;top:0;z-index:9999"></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
    panel.webview.onDidReceiveMessage((m: WebviewToHost) => this.onMessage(m));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
      this.queue = [];
      this.current = undefined;
    });
    this.panel = panel;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

/** 드라이버가 돌려준 값을 webview로 보낼 수 있는 형태로 */
export function toCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) ? v : String(v);
    case 'bigint':
      return v.toString();
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (v instanceof Uint8Array) return v.byteLength <= 4096 ? { $bin: v.byteLength, hex: Buffer.from(v).toString('hex') } : { $bin: v.byteLength };
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 내보내기: 바이너리는 전체를 16진으로 */
function toExportCell(v: unknown): ExportCell {
  if (v instanceof Uint8Array) return { $bin: v.byteLength, hex: Buffer.from(v).toString('hex') };
  return toCell(v);
}

