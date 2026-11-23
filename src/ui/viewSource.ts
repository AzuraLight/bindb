import * as vscode from 'vscode';
import type { ConnectionStore } from '../core/connections';
import { withCodeStyle } from '../core/ddl';
import type { SessionManager } from '../core/sessions';
import { readViewSource, sameDefinition, sameSource, splitViewText, viewDdlText, viewMigration, type ViewName, type ViewSource } from '../core/viewSource';
import type { CodeStyle, ConnectionConfig, DriverId, MetaTable } from '../drivers/types';
import { errorText } from './explorer';

/** 뷰 DDL 문서의 URI scheme */
export const DDL_SCHEME = 'bindb-ddl';

/** 이미 열려 있는 문서(없으면 undefined) */
function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
}

interface Entry {
  cfgId: string;
  /** 연결의 기본이 아닌 데이터베이스(postgres, Single database mode 끔) */
  database?: string;
  view: ViewName;
  driver: DriverId;
  /** 편집을 시작한 정의(이 값과 DB의 지금 정의가 다르면 Submit 때 충돌로 본다) */
  base: ViewSource;
  /** base의 머리 · 꼬리를 만들 때 쓴 코드 스타일(Submit 때 같은 스타일로 다시 읽어 비교한다 — 스타일만 바뀐 것은 충돌이 아니다) */
  style?: CodeStyle;
  /** 저장했지만 Submit하지 않은 DDL(DataGrip처럼 Submit 전까지 남는다) */
  local?: string;
  mtime: number;
}

/**
 * 뷰 DDL 편집기(DataGrip: Go to DDL → 고쳐서 Submit).
 *  - 열 때: 캐시한 정의(Load sources)를 보여 주고, DB의 지금 정의와 다르면 알린다(Warn when editing outdated DDL)
 *  - Submit: DB의 지금 정의가 편집을 시작한 정의와 다르면 Force Refactoring / Abort Refactoring and Synchronize를 묻는다
 *  - 저장(Cmd+S)은 DB에 보내지 않고 Submit 전까지 보관만 한다
 * 출처: https://www.jetbrains.com/help/datagrip/modifying-source-code-of-database-objects.html
 */
export class ViewSourceEditor implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly subs: vscode.Disposable[];

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
  ) {
    this.subs = [
      vscode.workspace.registerFileSystemProvider(DDL_SCHEME, this, { isCaseSensitive: true }),
      // 저장한 편집이 없으면 닫을 때 잊는다(다시 열면 새로 읽는다)
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme !== DDL_SCHEME || doc.uri.query === 'db') return;
        const e = this.entries.get(doc.uri.path);
        if (e && e.local === undefined) this.entries.delete(doc.uri.path);
      }),
    ];
  }

  /**
   * 뷰 하나의 DDL 문서 URI. 편집기 상태는 path로 찾는다.
   * @param side 'db'면 비교(Merge)에 쓰는 DB 쪽 읽기 전용 문서
   */
  static uriOf(cfgId: string, database: string | undefined, view: ViewName, side?: 'db'): vscode.Uri {
    const seg = (s: string) => encodeURIComponent(s);
    return vscode.Uri.from({
      scheme: DDL_SCHEME,
      path: `/${seg(cfgId)}/${seg(database ?? '-')}/${seg(view.schema)}/${seg(view.name)}.sql`,
      query: side ?? '',
    });
  }

  // ── 탐색기: Go to DDL ──

  /**
   * 뷰의 DDL 편집기를 연다. 이미 열어 둔 편집(저장한 DDL)이 있으면 그것을 다시 보여 준다.
   * @param database 연결의 기본이 아닌 데이터베이스
   */
  async open(cfg: ConnectionConfig, table: MetaTable, database?: string): Promise<void> {
    if (table.kind !== 'view') throw new Error(`${table.schema}.${table.name} is a table; only view DDL can be edited.`);
    const view = { schema: table.schema, name: table.name };
    const uri = ViewSourceEditor.uriOf(cfg.id, database, view);
    // 속성(머리 · 꼬리)은 늘 DB에서 읽는다 — 캐시한 본문만으로 열면 Submit이 속성을 지운다
    let fresh: ViewSource | undefined;
    try {
      fresh = await this.fetch(cfg, view, database);
    } catch (e) {
      throw new Error(`Could not read the definition of ${view.schema}.${view.name}: ${errorText(e)}`);
    }
    if (!fresh) {
      throw new Error(`The definition of ${view.schema}.${view.name} is not available (PostgreSQL shows it only to the view's owner; MySQL needs SHOW VIEW).`);
    }
    let entry = this.entries.get(uri.path);
    if (!entry) {
      // DataGrip처럼 캐시한 본문(Load sources)을 연다. 캐시가 없으면(Load sources 끔 · 2단계 · SQLite) DB에서 읽은 것.
      // 캐시가 CREATE 문 전체면(H2 1.x) 본문만 쓴다
      const cached = table.definition === undefined ? undefined : (splitViewText(cfg.driver, table.definition)?.body ?? table.definition);
      entry = { cfgId: cfg.id, database, view, driver: cfg.driver, base: fresh, mtime: 0 };
      this.rebase(entry, { ...fresh, definition: cached ?? fresh.definition }, cfg.codeStyle);
      this.entries.set(uri.path, entry);
    }
    await vscode.window.showTextDocument(uri, { preview: false });
    if (cfg.warnOutdatedDdl !== false && !sameDefinition(entry.base.definition, fresh.definition, cfg.driver)) {
      void this.warnOutdated(cfg, uri, entry, fresh);
    }
  }

  private async warnOutdated(cfg: ConnectionConfig, uri: vscode.Uri, entry: Entry, fresh: ViewSource): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      `The cached DDL of ${entry.view.schema}.${entry.view.name} differs from the database.`,
      'Synchronize',
      'Disable check',
    );
    if (pick === 'Synchronize') await this.synchronize(cfg, uri, entry, fresh, cfg.codeStyle);
    else if (pick === 'Disable check') {
      const current = this.store.get(cfg.id);
      if (!current) return;
      const { id, ...rest } = current;
      await this.store.update(id, { ...rest, warnOutdatedDdl: false });
      vscode.window.showInformationMessage(`Outdated DDL warnings are off for ${current.name} (Options → Introspection in the data source).`);
    }
  }

  /**
   * DB의 정의로 맞춘다. 저장한 편집이 있으면 되돌릴지 · 둘지 · 비교할지 묻는다
   * @param style fresh를 읽을 때 쓴 코드 스타일
   */
  private async synchronize(cfg: ConnectionConfig, uri: vscode.Uri, entry: Entry, fresh: ViewSource, style: CodeStyle | undefined): Promise<void> {
    // 저장하지 않은 편집은 먼저 보관한다 — 정의를 바꾼 뒤에 저장하면 VS Code가 "파일이 더 새롭다" 충돌로 거부한다
    const doc = openDocument(uri);
    if (doc?.isDirty) await doc.save();
    this.rebase(entry, fresh, style);
    // 탐색기 · 자동 완성의 캐시도 새로 읽는다
    void this.sessions.metadata(cfg, true, entry.database).catch(() => {});
    if (entry.local === undefined) {
      this.changed(uri);
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      `${entry.view.schema}.${entry.view.name} was synchronized with the database, and you have local changes.`,
      'Revert local changes',
      'Keep local changes',
      'Merge',
    );
    if (pick === 'Revert local changes') {
      entry.local = undefined;
      entry.mtime = Date.now();
      this.changed(uri);
    } else if (pick === 'Merge') {
      this.changed(uri);
      await vscode.commands.executeCommand(
        'vscode.diff',
        ViewSourceEditor.uriOf(entry.cfgId, entry.database, entry.view, 'db'),
        uri,
        `${entry.view.name}.sql (Database ↔ Local)`,
      );
    } else {
      this.changed(uri);
    }
  }

  // ── 편집기 제목줄: Submit ──

  /**
   * 저장한 DDL을 DB에 마이그레이션으로 보낸다. 보내지 못한 이유는 메시지로 알린다.
   * @param target 보낼 DDL 문서(없으면 활성 편집기)
   */
  async submit(target?: vscode.Uri): Promise<void> {
    const uri = target ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== DDL_SCHEME || uri.query === 'db') {
      vscode.window.showInformationMessage('Open a view DDL (Go to DDL in the BindB explorer) to submit it.');
      return;
    }
    const entry = this.entries.get(uri.path);
    const cfg = entry && this.store.get(entry.cfgId);
    if (!entry || !cfg) {
      vscode.window.showErrorMessage('This DDL editor is no longer attached to a data source. Open it again from the explorer.');
      return;
    }
    const doc = openDocument(uri);
    if (doc?.isDirty) await doc.save();
    if (entry.local === undefined) {
      vscode.window.showInformationMessage('No changes to submit.');
      return;
    }
    const name = `${entry.view.schema}.${entry.view.name}`;
    // 충돌 확인: 편집을 시작한 뒤 DB에서 바뀌었는가(속성까지 비교한다)
    let fresh: ViewSource | undefined;
    try {
      fresh = await this.fetch(cfg, entry.view, entry.database, entry.style);
    } catch (e) {
      vscode.window.showErrorMessage(`Not submitted: could not read the current definition of ${name}: ${errorText(e)}`);
      return;
    }
    if (entry.base.materialized || fresh?.materialized) {
      vscode.window.showErrorMessage(`Not submitted: ${name} is a materialized view. Changing one means dropping it, which loses its data and indexes.`);
      return;
    }
    // SQLite: DROP VIEW가 지우는 트리거는 지금 DB에 있는 것으로 다시 만든다
    const migration = withCodeStyle(cfg.codeStyle, () => viewMigration(cfg.driver, entry.local!, entry.view, fresh?.triggers ?? []));
    if ('error' in migration) {
      vscode.window.showErrorMessage(`Not submitted: ${migration.error}`);
      return;
    }
    if (!fresh || !sameSource(fresh, entry.base, cfg.driver)) {
      const pick = await vscode.window.showWarningMessage(
        fresh ? `${name} was changed in the database after you started editing.` : `${name} no longer exists in the database, or its definition cannot be read.`,
        {
          modal: true,
          detail: fresh
            ? 'Force Refactoring replaces it with your DDL. Abort Refactoring and Synchronize loads the database version first.'
            : 'Force Refactoring creates it from your DDL.',
        },
        'Force Refactoring',
        ...(fresh ? ['Abort Refactoring and Synchronize'] : []),
      );
      if (!pick) return;
      if (pick !== 'Force Refactoring') {
        await this.synchronize(cfg, uri, entry, fresh!, entry.style);
        return;
      }
    }

    // Show preview of valid script when updating source text(DataGrip 기본: 끔)
    const script = migration.statements.map((s) => `${s};`).join('\n\n');
    if (vscode.workspace.getConfiguration('bindb').get<boolean>('ddl.showPreviewOfValidScript', false)) {
      const ok = await vscode.window.showInformationMessage(`Run this migration on ${cfg.name}?`, { modal: true, detail: script }, 'Execute');
      if (ok !== 'Execute') return;
    }
    let committed: boolean;
    try {
      // SQLite는 DROP + CREATE라 한 트랜잭션으로 묶는다(실패하면 되돌린다)
      ({ committed } = await this.sessions.applyEdits(
        cfg,
        migration.statements.map((sql) => ({ sql, params: [], expectOne: false })),
        { database: entry.database },
      ));
    } catch (e) {
      vscode.window.showErrorMessage(`Submit failed: ${errorText(e)}`);
      return;
    }
    await this.sessions.metadata(cfg, true, entry.database).catch(() => {});
    const after = await this.fetch(cfg, entry.view, entry.database).catch(() => undefined);
    if (after) this.rebase(entry, after, cfg.codeStyle);
    entry.local = undefined;
    entry.mtime = Date.now();
    this.changed(uri);
    // MySQL · H2는 DDL을 실행하면 열린 트랜잭션을 바로 커밋한다(되돌릴 수 없다)
    const implicitCommit = cfg.driver === 'mysql' || cfg.driver === 'h2';
    vscode.window.showInformationMessage(
      committed
        ? `Submitted ${name} to ${cfg.name}.`
        : implicitCommit
          ? `Submitted ${name} to ${cfg.name}. ${cfg.driver === 'mysql' ? 'MySQL' : 'H2'} commits DDL at once, so the open transaction was committed too.`
          : `${name} was changed in the open transaction on ${cfg.name}; commit to keep it.`,
    );
  }

  /**
   * 편집을 시작한 정의를 바꾼다. 정의와 그 머리 · 꼬리를 만든 코드 스타일은 늘 함께 바꾼다
   * (스타일을 빠뜨리면 Submit 때 스타일만 다른 것을 충돌로 본다).
   */
  private rebase(entry: Entry, base: ViewSource, style: CodeStyle | undefined): void {
    entry.base = base;
    entry.style = style;
    entry.mtime = Date.now();
  }

  /**
   * DB에서 뷰 정의를 읽는다. DataGrip처럼 구조 정보 읽기(introspection) 세션에서 읽는다 — 콘솔 세션에서 읽으면
   * 그리드가 아직 다 받지 않은 결과 커서를 닫는다. 수동 트랜잭션에서 커밋하지 않은 변경은 세션이 따로면 보이지 않는다.
   * @param style 머리 · 꼬리를 만들 코드 스타일(기본: 연결의 지금 스타일)
   */
  private fetch(cfg: ConnectionConfig, view: ViewName, database?: string, style: CodeStyle | undefined = cfg.codeStyle): Promise<ViewSource | undefined> {
    return readViewSource(cfg.driver, view, (q) => this.sessions.introspectionQuery(cfg, q.sql, q.params, database), style);
  }

  private text(entry: Entry): string {
    return viewDdlText(entry.base);
  }

  private changed(uri: vscode.Uri): void {
    const local = uri.with({ query: '' });
    this.emitter.fire([
      { type: vscode.FileChangeType.Changed, uri: local },
      { type: vscode.FileChangeType.Changed, uri: local.with({ query: 'db' }) },
    ]);
  }

  // ── FileSystemProvider ──

  private entryOf(uri: vscode.Uri): Entry {
    const e = this.entries.get(uri.path);
    if (!e) throw vscode.FileSystemError.FileNotFound(uri);
    return e;
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const e = this.entryOf(uri);
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: e.mtime,
      size: Buffer.byteLength(this.contentOf(uri, e)),
      // 비교(Merge)의 DB 쪽은 읽기 전용
      ...(uri.query === 'db' ? { permissions: vscode.FilePermission.Readonly } : {}),
    };
  }

  private contentOf(uri: vscode.Uri, e: Entry): string {
    return uri.query === 'db' ? this.text(e) : (e.local ?? this.text(e));
  }

  readFile(uri: vscode.Uri): Uint8Array {
    return Buffer.from(this.contentOf(uri, this.entryOf(uri)));
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    if (uri.query === 'db') throw vscode.FileSystemError.NoPermissions(uri);
    const e = this.entryOf(uri);
    const text = Buffer.from(content).toString('utf8');
    // 원래 DDL과 같아지면 편집이 없는 것으로 본다
    e.local = text === this.text(e) ? undefined : text;
    e.mtime = Date.now();
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.emitter.dispose();
  }
}
