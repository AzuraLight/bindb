import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { buildConfig, formFromConfig, type ConnectionForm, type FormErrors } from '../core/connectionDraft';
import type { ConnectionStore } from '../core/connections';
import { askHostKey, setupStatements, sharedSshConfigs } from '../core/sessions';
import { resolveSharedSsh } from '../drivers/common';
import type { SharedSshConfig } from '../drivers/types';
import { downloadH2, h2Versions } from '../drivers/h2Download';
import { connectDriver } from '../drivers/tunnel';
import * as path from 'node:path';
import { drivers, type ConnectionConfig, type DriverId, type Session } from '../drivers';
import { queryAll } from '../drivers/cursor';
import type { SecretUpdate } from '../core/connections';
import type {
  Change,
  DataSourceTemplate,
  DriverInfo,
  PanelHostToWebview,
  PanelInit,
  PanelWebviewToHost,
  PasswordChange,
  PickField,
  SecretChanges,
} from '../shared/connectionProtocol';
import mysqlPkg from 'mysql2/package.json';
import pgPkg from 'pg/package.json';
import { errorText } from './explorer';

/** 저장 결과. 바뀐 연결은 열린 세션을 끊고 다시 연다. */
export interface Applied {
  added: ConnectionConfig[];
  updated: ConnectionConfig[];
  removed: string[];
}

const VERSION_SQL: Record<DriverId, string> = {
  postgres: 'SELECT version()',
  mysql: 'SELECT VERSION()',
  sqlite: 'SELECT sqlite_version()',
  h2: 'SELECT H2VERSION()',
};

/**
 * DataGrip의 Data Sources 창을 본뜬 연결 관리 패널. 왼쪽 연결 목록, 오른쪽 탭(General · Options · SSL),
 * 아래 OK · Cancel · Apply. 패널은 하나만 연다.
 */
export class ConnectionPanel {
  private static current?: ConnectionPanel;
  /** 내려받은 드라이버 파일을 둘 폴더(확장 전용 저장소). activate에서 정한다 */
  static driverDir = '';
  /** 주고받은 메시지 기록(통합 테스트가 패널이 실제로 그려졌는지 확인하는 데 쓴다) */
  static readonly trace: string[] = [];

  static show(
    extensionUri: vscode.Uri,
    store: ConnectionStore,
    target: { select?: string; addNew?: DriverId; pickDriver?: boolean; createDdlMapping?: boolean },
    onApplied: (r: Applied) => void,
  ): void {
    const open = ConnectionPanel.current;
    if (open) {
      open.panel.reveal();
      open.post({ t: 'focus', ...target });
      return;
    }
    ConnectionPanel.current = new ConnectionPanel(extensionUri, store, target, onApplied);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    extensionUri: vscode.Uri,
    private readonly store: ConnectionStore,
    private target: { select?: string; addNew?: DriverId; pickDriver?: boolean; createDdlMapping?: boolean },
    private readonly onApplied: (r: Applied) => void,
  ) {
    const outUri = vscode.Uri.joinPath(extensionUri, 'out', 'webview');
    this.panel = vscode.window.createWebviewPanel('bindb.connections', 'Data Sources', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [outUri],
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'bindb.svg');
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(outUri, 'connection.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(outUri, 'connection.css'));
    webview.html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
</head><body><div id="root"></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
    webview.onDidReceiveMessage((m: PanelWebviewToHost) => {
      ConnectionPanel.trace.push(`in:${m.t}`);
      // 호스트에서 난 예외를 삼키지 않는다(삼키면 패널이 빈 채로 남는다)
      this.onMessage(m).catch((e) => {
        ConnectionPanel.trace.push(`error:${errorText(e)}`);
        void vscode.window.showErrorMessage(`BindB Data Sources: ${errorText(e)}`);
      });
    });
    this.panel.onDidDispose(() => {
      if (ConnectionPanel.current === this) ConnectionPanel.current = undefined;
    });
  }

  private post(msg: PanelHostToWebview): void {
    ConnectionPanel.trace.push(`out:${msg.t}`);
    void this.panel.webview.postMessage(msg);
  }

  private async snapshot(select?: string, addNew?: DriverId, pickDriver?: boolean, createDdlMapping?: boolean): Promise<PanelInit> {
    const list = this.store.list();
    const items = await Promise.all(
      list.map(async (c) => ({
        id: c.id,
        form: formFromConfig(c),
        has: {
          password: (c.passwordSave ?? 'forever') === 'forever' ? !!(await this.store.password(c.id)) : false,
          sslKey: !!(await this.store.secret('sslKey', c.id)),
          ssh: !!(await this.store.secret('ssh', c.id)),
        },
      })),
    );
    return {
      items,
      select,
      addNew,
      pickDriver,
      createDdlMapping,
      h2Jar: vscode.workspace.getConfiguration('bindb').get<string>('h2.jarPath', ''),
      drivers: DRIVER_INFO,
      canUseProject: this.store.canUseProject,
      sshConfigs: sharedSshConfigs(),
      templates: vscode.workspace.getConfiguration('bindb').get<DataSourceTemplate[]>('dataSourceTemplates', []),
    };
  }

  private async onMessage(m: PanelWebviewToHost): Promise<void> {
    switch (m.t) {
      case 'ready':
        this.post({ t: 'init', init: await this.snapshot(this.target.select, this.target.addNew, this.target.pickDriver, this.target.createDdlMapping) });
        return;
      case 'pick': {
        const path = await pickPath(m.field, m.driver);
        if (path) this.post({ t: 'picked', key: m.key, field: m.field, path });
        return;
      }
      case 'test':
        return this.test(m.key, m.id, m.form, m.secrets, m.h2Jar, m.sshConfigs);
      case 'h2Versions':
        try {
          this.post({ t: 'h2Versions', ...(await h2Versions()) });
        } catch (e) {
          this.post({ t: 'h2Versions', error: errorText(e) });
        }
        return;
      case 'downloadH2':
        try {
          const file = await downloadH2(m.version, path.join(ConnectionPanel.driverDir, 'h2'));
          await vscode.workspace.getConfiguration('bindb').update('h2.jarPath', file, vscode.ConfigurationTarget.Global);
          this.post({ t: 'h2Downloaded', path: file });
        } catch (e) {
          this.post({ t: 'h2Downloaded', error: errorText(e) });
        }
        return;
      case 'listSchemas':
        return this.listSchemas(m.key, m.id, m.form, m.secrets, m.h2Jar, m.sshConfigs);
      case 'apply':
        if (m.sshConfigs) await vscode.workspace.getConfiguration('bindb').update('ssh.configurations', m.sshConfigs, vscode.ConfigurationTarget.Global);
        if (m.templates) await vscode.workspace.getConfiguration('bindb').update('dataSourceTemplates', m.templates, vscode.ConfigurationTarget.Global);
        return this.apply(m.changes, m.removed, m.h2Jar, m.close, m.selectedKey);
      case 'close': {
        if (m.dirty) {
          const discard = 'Discard Changes';
          const ok = await vscode.window.showWarningMessage('Discard unsaved connection changes?', { modal: true }, discard);
          if (ok !== discard) return;
        }
        this.panel.dispose();
        return;
      }
    }
  }

  /** 시험 접속에 쓸 비밀 값: 새로 쓴 값, 아니면 저장된 값 */
  private async resolveSecret(id: string | undefined, kind: keyof SecretChanges, change: PasswordChange): Promise<string | undefined> {
    if (change.kind === 'set') return change.value || undefined;
    if (change.kind === 'clear' || !id) return undefined;
    return kind === 'password' ? this.store.password(id) : this.store.secret(kind, id);
  }

  /**
   * 폼 값으로 시험 접속한다(Test Connection · Schemas 탭 Refresh). 실패하면 report로 알리고 undefined.
   * 접속 직후 문장(Time zone · Startup script 등)도 실행해 본다.
   */
  private async trial(
    key: string,
    id: string | undefined,
    form: ConnectionForm,
    secrets: SecretChanges,
    h2Jar: string,
    report: (message: string) => void,
    sshConfigs: SharedSshConfig[] = [],
  ): Promise<{ cfg: ConnectionConfig; session: Session; ms: number } | undefined> {
    const built = buildConfig({ ...form, name: form.name.trim() || 'test' }, []);
    if (!built.ok) {
      report(Object.values(built.errors)[0] ?? 'Check the highlighted fields.');
      return undefined;
    }
    let password = await this.resolveSecret(id, 'password', secrets.password);
    if (password === undefined && built.config.auth === undefined && (built.config.passwordSave ?? 'forever') !== 'forever' && form.driver !== 'sqlite') {
      // Never 등: 저장해 두지 않는 방식이면 시험할 때 묻는다
      password = await vscode.window.showInputBox({ prompt: `Password for ${form.name || 'this connection'}`, password: true });
      if (password === undefined) return undefined;
    }
    if (form.driver === 'h2' && form.h2Mode === 'file' && !h2Jar.trim()) {
      report('Choose the h2-*.jar file to open H2 database files.');
      return undefined;
    }
    const started = Date.now();
    let cfg: ConnectionConfig = { id: `trial-${key}`, ...built.config };
    try {
      cfg = resolveSharedSsh(cfg, sshConfigs);
      const session = await connectDriver(drivers[form.driver], cfg, {
        askHostKey,
        password,
        h2Jar: h2Jar.trim() || undefined,
        sslKeyPassword: await this.resolveSecret(id, 'sslKey', secrets.sslKey),
        // 공유 SSH 설정이면 그 설정 id에 저장된 비밀 값
        sshSecret: await this.resolveSecret(cfg.ssh?.configId ?? id, 'ssh', secrets.ssh),
      });
      try {
        for (const sql of setupStatements(cfg)) await (await session.execute(sql)).close();
      } catch (e) {
        await session.close().catch(() => {});
        throw e;
      }
      return { cfg, session, ms: Date.now() - started };
    } catch (e) {
      report(errorText(e));
      return undefined;
    }
  }

  private async test(key: string, id: string | undefined, form: ConnectionForm, secrets: SecretChanges, h2Jar: string, ssh: SharedSshConfig[]): Promise<void> {
    const t = await this.trial(key, id, form, secrets, h2Jar, (message) => this.post({ t: 'tested', key, ok: false, message }), ssh);
    if (!t) return;
    let detail: string | undefined;
    try {
      detail = String((await queryAll(t.session, VERSION_SQL[form.driver]))[0]?.[0] ?? '') || undefined;
    } catch {
      // 버전은 덤이다. 못 읽어도 연결은 성공이다.
    }
    await t.session.close().catch(() => {});
    this.post({ t: 'tested', key, ok: true, message: `Succeeded · ${t.ms} ms`, detail });
  }

  /** Schemas 탭 Refresh: 데이터베이스 · 스키마 목록 */
  private async listSchemas(key: string, id: string | undefined, form: ConnectionForm, secrets: SecretChanges, h2Jar: string, ssh: SharedSshConfig[]): Promise<void> {
    const fail = (message: string) => this.post({ t: 'schemas', key, ok: false, message });
    const t = await this.trial(key, id, form, secrets, h2Jar, fail, ssh);
    if (!t) return;
    try {
      const tables = await drivers[form.driver].introspect(t.session, { ...t.cfg, showSystemSchemas: true, schemaPattern: undefined });
      const schemas = [...new Set(tables.map((x) => x.schema))].sort();
      const tree: { database?: string; schemas: string[] }[] = [{ database: t.cfg.database, schemas }];
      if (form.driver === 'postgres') {
        const rows = await queryAll(t.session, `SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname`);
        for (const [name] of rows) if (String(name) !== t.cfg.database) tree.push({ database: String(name), schemas: [] });
      }
      this.post({ t: 'schemas', key, ok: true, tree });
    } catch (e) {
      fail(errorText(e));
    } finally {
      await t.session.close().catch(() => {});
    }
  }

  private async apply(changes: Change[], removed: string[], h2Jar: string, close: boolean, selectedKey?: string): Promise<void> {
    // 이름 중복은 저장 뒤의 최종 목록 기준으로 본다.
    const changedIds = new Set(changes.map((c) => c.id).filter(Boolean));
    const untouched = this.store.list().filter((c) => !removed.includes(c.id) && !changedIds.has(c.id));
    const errors: Record<string, FormErrors> = {};
    const built = new Map<string, Omit<ConnectionConfig, 'id'>>();
    for (const c of changes) {
      const others = [...untouched, ...changes.filter((o) => o.key !== c.key).map((o) => o.form)];
      const r = buildConfig(c.form, others);
      if (r.ok) {
        built.set(c.key, r.config);
        // URL only의 URL에 있던 비밀번호는 키체인으로(설정에는 뺀 URL만 남는다)
        if (r.urlPassword !== undefined && c.secrets.password.kind === 'keep') c.secrets.password = { kind: 'set', value: r.urlPassword };
      }
      else errors[c.key] = r.errors;
    }
    if (Object.keys(errors).length) {
      this.post({ t: 'applyFailed', errors });
      return;
    }

    const result: Applied = { added: [], updated: [], removed: [] };
    const idOf = new Map<string, string>();
    try {
      if (changes.some((c) => c.form.driver === 'h2' && c.form.h2Mode === 'file') && h2Jar.trim()) {
        const config = vscode.workspace.getConfiguration('bindb');
        if (config.get<string>('h2.jarPath') !== h2Jar.trim()) {
          await config.update('h2.jarPath', h2Jar.trim(), vscode.ConfigurationTarget.Global);
        }
      }
      for (const id of removed) {
        await this.store.remove(id);
        result.removed.push(id);
      }
      // DDL data source를 먼저 저장해 id를 얻고, 새 DDL을 가리키는 매핑(아직 key)을 그 id로 바꾼다
      const ordered = [...changes].sort((x, y) => Number(y.form.adv.kind === 'ddl') - Number(x.form.adv.kind === 'ddl'));
      for (const c of ordered) {
        const config = { ...built.get(c.key)! };
        if (config.ddlMapping && idOf.has(config.ddlMapping.ddl)) config.ddlMapping = { ...config.ddlMapping, ddl: idOf.get(config.ddlMapping.ddl)! };
        const secrets = secretUpdate(c, config);
        if (c.id) {
          result.updated.push(await this.store.update(c.id, config, secrets));
          idOf.set(c.key, c.id);
        } else {
          const added = await this.store.add(config, secrets);
          result.added.push(added);
          idOf.set(c.key, added.id);
        }
      }
    } catch (e) {
      this.post({ t: 'applyFailed', message: errorText(e) });
      return;
    }

    this.onApplied(result);
    if (close) {
      this.panel.dispose();
      return;
    }
    const select = selectedKey ? (idOf.get(selectedKey) ?? selectedKey) : undefined;
    this.post({ t: 'init', init: await this.snapshot(select) });
  }
}

/** 저장할 비밀 값. 쓰지 않는 칸(SQLite의 비밀번호, 꺼진 SSL 키 · SSH)은 지운다 */
function secretUpdate(c: Change, config: Omit<ConnectionConfig, 'id'>): SecretUpdate {
  const map = (ch: PasswordChange, used: boolean): string | null | undefined =>
    !used ? null : ch.kind === 'set' ? ch.value || null : ch.kind === 'clear' ? null : undefined;
  return {
    password: map(c.secrets.password, c.form.driver !== 'sqlite' && config.auth === undefined),
    sslKey: map(c.secrets.sslKey, !!config.sslKeyFile),
    ssh: map(c.secrets.ssh, !!config.ssh?.enabled && config.ssh.auth !== 'agent'),
  };
}

const DRIVER_INFO: DriverInfo[] = [
  { id: 'postgres', module: 'pg (node-postgres)', version: pgPkg.version, urlTemplates: ['postgresql://[user@]host[:port][/database][?sslmode=…]'] },
  { id: 'mysql', module: 'mysql2', version: mysqlPkg.version, urlTemplates: ['mysql://[user@]host[:port][/database][?ssl-mode=…]'] },
  { id: 'sqlite', module: 'node:sqlite (built into VS Code)', version: process.versions.sqlite ?? 'unknown', urlTemplates: ['jdbc:sqlite:<file>', '<file>'] },
  {
    id: 'h2',
    module: 'pg (node-postgres) over the H2 PostgreSQL server, plus your h2-*.jar',
    version: pgPkg.version,
    urlTemplates: ['postgresql://[user@]host[:port]/database', 'jdbc:h2:file:<path>.mv.db'],
  },
];

async function pickPath(field: PickField, driver: DriverId): Promise<string | undefined> {
  const open = async (title: string, filters?: Record<string, string[]>, folders = false) =>
    (await vscode.window.showOpenDialog({ title, filters, canSelectMany: false, canSelectFiles: !folders, canSelectFolders: folders }))?.[0]?.fsPath;
  switch (field) {
    case 'h2Jar':
      return open('Select h2-*.jar', { 'H2 jar': ['jar'] });
    case 'sslCaFile':
      return open('CA certificate', { Certificates: ['pem', 'crt', 'cer'], 'All files': ['*'] });
    case 'sslCertFile':
      return open('Client certificate', { Certificates: ['pem', 'crt', 'cer'], 'All files': ['*'] });
    case 'sslKeyFile':
      return open('Client key', { Keys: ['pem', 'key'], 'All files': ['*'] });
    case 'sshKeyFile':
      return open('SSH private key', { 'All files': ['*'] });
    case 'workingDirectory':
      return open('Working directory', undefined, true);
    case 'ddlFolder':
      return open('Folder with DDL files', undefined, true);
    case 'virtualObjectsFile':
      return (await vscode.window.showSaveDialog({ title: 'Virtual objects file', filters: { JSON: ['json'] } }))?.fsPath;
    case 'newFile':
      return (await vscode.window.showSaveDialog({ title: 'New SQLite database file', filters: { SQLite: ['db', 'sqlite', 'sqlite3', 'db3'] } }))?.fsPath;
    case 'file':
      return open(
        'Select database file',
        driver === 'h2' ? { 'H2 database': ['db'] } : { SQLite: ['db', 'sqlite', 'sqlite3', 'db3'], 'All files': ['*'] },
      );
  }
}
