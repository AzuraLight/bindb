import * as vscode from 'vscode';
import type { ConnectionStore } from '../core/connections';
import type { SessionManager } from '../core/sessions';
import { drivers, type ConnectionConfig, type MetaTable } from '../drivers';
import { splitStatements } from '../language/splitter';
import { dbObjectOf, documentSymbols, symbolAt, type Occurrence, type SymbolScope } from '../language/symbols';
import { cachedScope, withCatalog } from './metaScope';
import { bindingNameOfText, boundConnection, boundSchema, schemaOfText } from './binding';
import type { Node } from './explorer';

/** 다른 파일에서 사용처를 찾을 때 읽을 .sql 파일 수 상한 */
const MAX_FILES = 500;

/**
 * 정의로 이동(별칭 · WITH 이름 · 문서의 CREATE TABLE/VIEW와 열 정의)과 사용처 찾기(테이블 · 열은 같은 연결에 바인딩된
 * 작업 공간의 .sql 파일까지). DB에만 있는 테이블 · 열은 "Reveal in BindB Explorer"로 탐색기에서 보여 준다.
 */
export class SqlNavigation implements vscode.DefinitionProvider, vscode.ReferenceProvider {
  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
  ) {}

  private async scope(cfg: ConnectionConfig | undefined, schema: string | undefined): Promise<SymbolScope> {
    if (!cfg) return { tables: [], schema };
    // 메타데이터를 아직 안 받았어도 별칭 · WITH · 문서의 CREATE는 쓸 수 있다
    return (await cachedScope(this.sessions, cfg, schema)) ?? { tables: withCatalog(cfg, []), schema: schema ?? drivers[cfg.driver].defaultSchema(cfg) };
  }

  private async analyze(doc: vscode.TextDocument) {
    const cfg = boundConnection(doc, this.store);
    const scope = await this.scope(cfg, boundSchema(doc));
    return { cfg, scope, symbols: documentSymbols(splitStatements(doc.getText(), cfg?.driver), scope) };
  }

  /** 커서 위치의 대상(탐색기 보여 주기 명령도 쓴다) */
  async objectAt(doc: vscode.TextDocument, position: vscode.Position): Promise<{ cfg?: ConnectionConfig; table?: MetaTable; column?: string }> {
    const { cfg, scope, symbols } = await this.analyze(doc);
    const occ = symbolAt(symbols, doc.offsetAt(position));
    const obj = occ && dbObjectOf(occ.key, scope);
    return { cfg, ...obj };
  }

  async provideDefinition(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location | undefined> {
    const { symbols } = await this.analyze(doc);
    const occ = symbolAt(symbols, doc.offsetAt(position));
    if (!occ) return undefined;
    const decl = symbols.find((o) => o.decl && o.key === occ.key);
    return decl && new vscode.Location(doc.uri, new vscode.Range(doc.positionAt(decl.start), doc.positionAt(decl.end)));
  }

  async provideReferences(doc: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext, token: vscode.CancellationToken): Promise<vscode.Location[]> {
    const { cfg, symbols } = await this.analyze(doc);
    const occ = symbolAt(symbols, doc.offsetAt(position));
    if (!occ) return [];
    const pick = (list: Occurrence[]) => list.filter((o) => o.key === occ.key && (context.includeDeclaration || !o.decl));
    const out = pick(symbols).map((o) => new vscode.Location(doc.uri, new vscode.Range(doc.positionAt(o.start), doc.positionAt(o.end))));
    // 별칭 · WITH 이름은 그 문장 안에서만 뜻이 있다
    if (!cfg || !/^[tc]:/.test(occ.key)) return out;

    const files = await sqlFiles(token);
    const open = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.toString(), d]));
    // 메타데이터 · 시스템 카탈로그는 한 번만 만들고, 파일마다 @schema만 바꾼다
    const base = await this.scope(cfg, undefined);
    for (const uri of files) {
      if (token.isCancellationRequested) break;
      if (uri.toString() === doc.uri.toString()) continue;
      const opened = open.get(uri.toString());
      const text = opened ? opened.getText() : await vscode.workspace.fs.readFile(uri).then((b) => Buffer.from(b).toString('utf8'), () => undefined);
      if (token.isCancellationRequested) break;
      if (text === undefined || bindingNameOfText(text) !== cfg.name) continue;
      const found = pick(documentSymbols(splitStatements(text, cfg.driver), { tables: base.tables, schema: schemaOfText(text) ?? base.schema }));
      if (!found.length) continue;
      const at = lineIndex(text);
      for (const o of found) out.push(new vscode.Location(uri, new vscode.Range(at(o.start), at(o.end))));
    }
    return out;
  }
}

/**
 * 작업 공간의 .sql 파일(모두 합쳐 MAX_FILES개까지). findFiles는 제외 패턴을 주면 files.exclude를 끄므로,
 * 폴더마다 그 폴더의 files.exclude(true인 항목)와 node_modules를 합친 패턴으로 찾는다 —
 * 제외한 파일은 상한에 들어가지 않는다. 조건부 항목({ when: … })은 반영하지 않는다.
 */
export function excludeGlob(excludes: Record<string, unknown> | undefined): string {
  const globs = ['**/node_modules/**', ...Object.keys(excludes ?? {}).filter((k) => excludes![k] === true)];
  return `{${[...new Set(globs)].join(',')}}`;
}

async function sqlFiles(token: vscode.CancellationToken): Promise<vscode.Uri[]> {
  const out: vscode.Uri[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (token.isCancellationRequested || out.length >= MAX_FILES) break;
    const excludes = vscode.workspace.getConfiguration('files', folder.uri).get<Record<string, unknown>>('exclude');
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.sql'), excludeGlob(excludes), MAX_FILES - out.length, token);
    out.push(...found);
  }
  return out;
}

/** 열지 않은 파일에서 오프셋 → 위치 */
function lineIndex(text: string): (offset: number) => vscode.Position {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return new vscode.Position(lo, offset - starts[lo]);
  };
}

/** 커서의 테이블 · 열을 BindB 탐색기에서 찾아 보여 준다 */
export async function revealInExplorer(nav: SqlNavigation, view: vscode.TreeView<Node>): Promise<boolean> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return false;
  const { cfg, table, column } = await nav.objectAt(editor.document, editor.selection.active);
  if (!cfg) {
    vscode.window.showInformationMessage('This file is not bound to a BindB connection (-- @conn: <name>).');
    return false;
  }
  if (!table) {
    vscode.window.showInformationMessage('No database table or column at the cursor (or its metadata is not loaded yet).');
    return false;
  }
  const col = column && table.columns.find((c) => c.name === column);
  const node: Node = col ? { kind: 'column', cfg, table, column: col } : { kind: 'table', cfg, table };
  try {
    await view.reveal(node, { select: true, focus: true, expand: !col });
    return true;
  } catch (e) {
    // 스키마 패턴 · 객체 필터로 숨긴 객체 등
    vscode.window.showInformationMessage(`${table.schema}.${table.name} is not shown in the BindB explorer (${e instanceof Error ? e.message : String(e)}).`);
    return false;
  }
}
