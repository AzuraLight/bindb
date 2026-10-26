import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConnectionConfig } from '../drivers';

const SETTING = 'connections';

/** 연결 정의는 사용자 설정(bindb.connections), 비밀번호는 OS 키체인(SecretStorage)에 둔다. */
export class ConnectionStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`bindb.${SETTING}`)) this.changed.fire();
    });
  }

  list(): ConnectionConfig[] {
    return vscode.workspace.getConfiguration('bindb').get<ConnectionConfig[]>(SETTING, []);
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  findByName(name: string): ConnectionConfig | undefined {
    const lower = name.trim().toLowerCase();
    return this.list().find((c) => c.name.toLowerCase() === lower);
  }

  async add(cfg: Omit<ConnectionConfig, 'id'>, password: string | undefined): Promise<ConnectionConfig> {
    const full: ConnectionConfig = { id: randomUUID(), ...cfg };
    await this.save([...this.list(), full]);
    if (password) await this.secrets.store(secretKey(full.id), password);
    return full;
  }

  async remove(id: string): Promise<void> {
    await this.save(this.list().filter((c) => c.id !== id));
    await this.secrets.delete(secretKey(id));
  }

  password(id: string): Thenable<string | undefined> {
    return this.secrets.get(secretKey(id));
  }

  private save(list: ConnectionConfig[]): Thenable<void> {
    return vscode.workspace.getConfiguration('bindb').update(SETTING, list, vscode.ConfigurationTarget.Global);
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}

const secretKey = (id: string) => `bindb.pw.${id}`;
