import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { splitStatements } from '../language/splitter';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ConnectionStore } from '../core/connections';
import { ddlFor, ddlPath, diffSchemas, migrationChanges, migrationSql, parseDdl, withCodeStyle } from '../core/ddl';
import type { SessionManager } from '../core/sessions';
import type { ConnectionConfig } from '../drivers';

/*
 * DDL Mapping 명령(DataGrip 2025.3 문서의 동작).
 *  - Dump to <DDL>(실제 데이터 소스에서) · Update from <데이터 소스>(DDL 데이터 소스에서):
 *    실제 DB의 객체를 DDL 파일로 쓴다. DB에 없는 객체의 파일은 경고 뒤 지운다.
 *  - Apply to <데이터 소스>(DDL 데이터 소스에서): 차이로 스크립트를 만들어 콘솔로 연다(검토 후 실행).
 */

export class DdlMapping {
  /** Migration 창: 변경 고르기. 통합 테스트에서만 바꾼다 */
  pickChanges = async (items: (vscode.QuickPickItem & { picked: boolean })[], title: string): Promise<string[] | undefined> =>
    (await vscode.window.showQuickPick(items, { canPickMany: true, title, ignoreFocusOut: true }))?.map((i) => i.label);

  /** 파일을 쓰기 전 확인. 통합 테스트에서만 바꾼다(모달은 테스트가 누를 수 없다) */
  confirm = async (message: string, detail: string, action: string): Promise<boolean> =>
    (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
  ) {}

  /** DDL 데이터 소스에 연결된(매핑된) 실제 데이터 소스. 여럿이면 고르게 한다 */
  private async sourceFor(ddl: ConnectionConfig): Promise<ConnectionConfig | undefined> {
    const mapped = this.store.list().filter((c) => c.ddlMapping?.ddl === ddl.id);
    if (mapped.length === 0) {
      vscode.window.showWarningMessage(`No data source is mapped to ${ddl.name}. Use Create DDL Mapping on a data source first.`);
      return undefined;
    }
    if (mapped.length === 1) return mapped[0];
    return (await vscode.window.showQuickPick(mapped.map((c) => ({ label: c.name, cfg: c })), { placeHolder: 'Which data source?' }))?.cfg;
  }

  private ddlOf(source: ConnectionConfig): ConnectionConfig | undefined {
    const ddl = source.ddlMapping && this.store.get(source.ddlMapping.ddl);
    if (!ddl) vscode.window.showWarningMessage(`${source.name} has no DDL mapping.`);
    return ddl || undefined;
  }

  /** Dump to <DDL data source> */
  async dump(source: ConnectionConfig): Promise<void> {
    const ddl = this.ddlOf(source);
    if (ddl) await this.write(source, ddl);
  }

  /** Update <DDL data source> from <data source> */
  async update(ddl: ConnectionConfig): Promise<void> {
    const source = await this.sourceFor(ddl);
    if (source) await this.write(source, ddl);
  }

  /** Apply <DDL data source> to <data source> */
  async apply(ddl: ConnectionConfig): Promise<void> {
    const source = await this.sourceFor(ddl);
    if (!source) return;
    const [db, files] = await Promise.all([this.sessions.metadata(source, true), this.sessions.metadata(ddl, true)]);
    const diff = diffSchemas(db, files, source.ddlMapping?.scope);
    const changes = withCodeStyle(source.codeStyle, () => migrationChanges(source.driver, diff));
    if (!changes.length) {
      vscode.window.showInformationMessage(`${source.name} already matches ${ddl.name}.`);
      return;
    }
    // Migration: 적용할 변경을 고른다(지우는 변경은 기본으로 고르지 않는다)
    const picked = await this.pickChanges(
      changes.map((c) => ({ label: c.label, description: c.destructive ? 'drops data' : undefined, detail: c.sql.split('\n')[0], picked: !c.destructive })),
      `Migration: ${ddl.name} → ${source.name} — choose the changes to apply`,
    );
    if (!picked?.length) return;
    const script = withCodeStyle(source.codeStyle, () => migrationSql(source.driver, diff, new Set(picked)));
    const header = [
      `-- @conn: ${source.name}`,
      `-- Migration: ${ddl.name} → ${source.name}`,
      '-- Script preview: edit it if needed, then run it with "BindB: Run All Statements" (or one statement with Cmd/Ctrl+Enter).',
      '',
      '',
    ].join('\n');
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: header + script });
    await vscode.window.showTextDocument(doc);
  }

  private async write(source: ConnectionConfig, ddl: ConnectionConfig): Promise<void> {
    const folder = ddl.ddlFolder;
    if (!folder) {
      vscode.window.showErrorMessage(`${ddl.name} has no folder.`);
      return;
    }
    const scope = source.ddlMapping?.scope;
    const tables = (await this.sessions.metadata(source, true)).filter(
      (t) => !scope?.length || scope.some((s) => s.toLowerCase() === t.schema.toLowerCase()),
    );
    if (!tables.length) {
      vscode.window.showWarningMessage(`${source.name} returned no objects${scope?.length ? ` in ${scope.join(', ')}` : ''}; nothing was written or deleted.`);
      return;
    }
    const root = path.resolve(folder);
    const inside = (f: string) => {
      const rel = path.relative(root, f);
      return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    const wanted = withCodeStyle(source.codeStyle, () => new Map(tables.map((t) => [path.resolve(root, ddlPath(ddl.driver, t)), ddlFor(ddl.driver, t)])));
    const outside = [...wanted.keys()].filter((f) => !inside(f));
    if (outside.length) {
      vscode.window.showErrorMessage(`Refusing to write outside ${folder}: ${outside.map((f) => path.basename(f)).join(', ')}`);
      return;
    }
    // 지울 수 있는 파일: 매핑 범위의 스키마 폴더 안에 있고, BindB가 쓰는 모양(객체 하나의 CREATE 문)인 것만.
    // 손으로 쓴 마이그레이션 · 범위 밖 스키마의 파일은 건드리지 않는다
    const inScopeDirs = new Set(
      ddl.driver === 'sqlite' ? [root] : [...new Set(tables.map((t) => t.schema))].map((s) => path.dirname(path.resolve(root, ddlPath(ddl.driver, { schema: s, name: 'x', kind: 'table' })))),
    );
    const existing = await listSql(folder);
    const stale: string[] = [];
    for (const f of existing) {
      if (wanted.has(path.resolve(f)) || !inScopeDirs.has(path.dirname(path.resolve(f)))) continue;
      const text = await readFile(f, 'utf8').catch(() => '');
      if (splitStatements(text, ddl.driver).filter((x) => x.text.trim()).length === 1 && parseDdl(text, 'x', ddl.driver).length === 1) stale.push(f);
    }

    const go = 'Write Files';
    const detail = [
      `${wanted.size} file(s) will be written to ${folder}.`,
      stale.length ? `${stale.length} file(s) for objects that are not in ${source.name} will be deleted:\n${stale.map((f) => `  ${path.relative(folder, f)}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    if (!(await this.confirm(`Dump ${source.name} to ${ddl.name}?`, detail, go))) return;

    for (const [file, content] of wanted) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
    }
    for (const f of stale) await rm(f, { force: true });
    await this.sessions.metadata(ddl, true).catch(() => {});
    vscode.window.showInformationMessage(`Wrote ${wanted.size} file(s)${stale.length ? `, deleted ${stale.length}` : ''} in ${ddl.name}.`);
  }
}

async function listSql(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.sql$/i.test(e.name)) out.push(full);
    }
  };
  await walk(dir);
  return out;
}
