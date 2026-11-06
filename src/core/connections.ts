import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConnectionConfig } from '../drivers';

const SETTING = 'connections';

/** 비밀 값 종류: DB 비밀번호 · SSL 클라이언트 키 비밀번호 · SSH 비밀번호(또는 키 암호) */
export type SecretKind = 'password' | 'sslKey' | 'ssh';
const PREFIX: Record<SecretKind, string> = { password: 'bindb.pw', sslKey: 'bindb.sslkey', ssh: 'bindb.ssh' };
const secretKey = (kind: SecretKind, id: string) => `${PREFIX[kind]}.${id}`;

/** 비밀 값 바꾸기: 문자열 = 새로 저장, null = 지움, undefined = 그대로 둠 */
export type SecretUpdate = Partial<Record<SecretKind, string | null>>;

/**
 * 연결 정의는 설정(bindb.connections)에 둔다. scope가 project인 연결은 워크스페이스 설정,
 * 나머지는 사용자(전역) 설정 — DataGrip의 Project / Global 데이터 소스.
 *
 * 비밀번호 보관(passwordSave)
 *  - forever: OS 키체인(SecretStorage)
 *  - restart: 이 창의 메모리. VS Code를 끄면 사라진다
 *  - session: 메모리. 연결을 끊으면 사라진다(forgetSession)
 *  - never:   보관하지 않는다. 접속할 때마다 묻는다
 */
export class ConnectionStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly sub: vscode.Disposable;
  /** restart · session 보관 비밀번호 */
  private readonly memory = new Map<string, string>();

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`bindb.${SETTING}`)) this.changed.fire();
    });
  }

  private read(target: 'global' | 'project'): ConnectionConfig[] {
    const info = vscode.workspace.getConfiguration('bindb').inspect<ConnectionConfig[]>(SETTING);
    const list = (target === 'global' ? info?.globalValue : info?.workspaceValue) ?? [];
    return list.map((c) => (target === 'project' ? { ...c, scope: 'project' as const } : { ...c, scope: undefined }));
  }

  /** 전역 연결 다음에 프로젝트 연결 */
  list(): ConnectionConfig[] {
    return [...this.read('global'), ...this.read('project')];
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  findByName(name: string): ConnectionConfig | undefined {
    const lower = name.trim().toLowerCase();
    return this.list().find((c) => c.name.toLowerCase() === lower);
  }

  /** 워크스페이스가 열려 있어야 프로젝트 연결을 둘 수 있다 */
  get canUseProject(): boolean {
    return !!vscode.workspace.workspaceFolders?.length;
  }

  async add(cfg: Omit<ConnectionConfig, 'id'>, secrets: SecretUpdate = {}): Promise<ConnectionConfig> {
    const full: ConnectionConfig = { id: randomUUID(), ...cfg };
    const target = full.scope === 'project' ? 'project' : 'global';
    await this.write(target, [...this.read(target), full]);
    await this.updateSecrets(full, secrets);
    return full;
  }

  /** 설정을 바꾼다. 범위(global ↔ project)가 바뀌면 옮긴다. */
  async update(id: string, cfg: Omit<ConnectionConfig, 'id'>, secrets: SecretUpdate = {}): Promise<ConnectionConfig> {
    const full: ConnectionConfig = { id, ...cfg };
    const target = full.scope === 'project' ? 'project' : 'global';
    const other = target === 'project' ? 'global' : 'project';
    if (this.read(other).some((c) => c.id === id)) await this.write(other, this.read(other).filter((c) => c.id !== id));
    const mine = this.read(target);
    await this.write(target, mine.some((c) => c.id === id) ? mine.map((c) => (c.id === id ? full : c)) : [...mine, full]);
    await this.updateSecrets(full, secrets);
    return full;
  }

  async remove(id: string): Promise<void> {
    for (const target of ['global', 'project'] as const) {
      const list = this.read(target);
      if (list.some((c) => c.id === id)) await this.write(target, list.filter((c) => c.id !== id));
    }
    for (const kind of Object.keys(PREFIX) as SecretKind[]) await this.secrets.delete(secretKey(kind, id));
    this.memory.delete(id);
  }

  /** 저장된 DB 비밀번호. 보관 방식에 따라 키체인 또는 메모리에서 */
  async password(id: string): Promise<string | undefined> {
    const cfg = this.get(id);
    const save = cfg?.passwordSave ?? 'forever';
    if (save === 'forever') return this.secrets.get(secretKey('password', id));
    return this.memory.get(id);
  }

  /** 접속할 때 물어서 받은 비밀번호를 보관 방식대로 기억한다(never면 기억하지 않는다) */
  remember(cfg: ConnectionConfig, password: string): void {
    const save = cfg.passwordSave ?? 'forever';
    if (save === 'restart' || save === 'session') this.memory.set(cfg.id, password);
  }

  /** 연결을 끊을 때: session 보관 비밀번호를 잊는다 */
  forgetSession(cfg: ConnectionConfig): void {
    if (cfg.passwordSave === 'session') this.memory.delete(cfg.id);
  }

  secret(kind: Exclude<SecretKind, 'password'>, id: string): Thenable<string | undefined> {
    return this.secrets.get(secretKey(kind, id));
  }

  private async updateSecrets(cfg: ConnectionConfig, update: SecretUpdate): Promise<void> {
    for (const kind of Object.keys(update) as SecretKind[]) {
      const value = update[kind];
      if (value === undefined) continue;
      if (kind === 'password' && (cfg.passwordSave ?? 'forever') !== 'forever') {
        // 키체인에 두지 않는 방식: 키체인 값은 지우고, 새 값은 메모리에만
        await this.secrets.delete(secretKey('password', cfg.id));
        if (value) this.remember(cfg, value);
        else this.memory.delete(cfg.id);
        continue;
      }
      // SSH 비밀 값은 공유 설정을 쓰면 그 설정 id에 둔다
      const owner = kind === 'ssh' ? (cfg.ssh?.configId ?? cfg.id) : cfg.id;
      if (value === null) await this.secrets.delete(secretKey(kind, owner));
      else if (value) await this.secrets.store(secretKey(kind, owner), value);
    }
    // 보관 방식을 forever에서 바꿨으면 키체인에 남은 비밀번호를 지운다
    if ((cfg.passwordSave ?? 'forever') !== 'forever' && update.password === undefined) {
      await this.secrets.delete(secretKey('password', cfg.id));
    }
  }

  private write(target: 'global' | 'project', list: ConnectionConfig[]): Thenable<void> {
    // scope는 어느 설정에 들어 있는지로 정해지므로 저장하지 않는다.
    const clean = list.map(({ scope: _scope, ...rest }) => rest);
    return vscode.workspace
      .getConfiguration('bindb')
      .update(SETTING, clean, target === 'project' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}
