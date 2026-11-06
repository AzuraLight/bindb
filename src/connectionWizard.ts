import * as vscode from 'vscode';
import type { ConnectionStore } from './core/connections';
import { drivers, type ConnectionConfig, type DriverId } from './drivers';

type Draft = Omit<ConnectionConfig, 'id'>;

async function input(prompt: string, value?: string, password = false): Promise<string | undefined> {
  return vscode.window.showInputBox({ prompt, value, password, ignoreFocusOut: true });
}

async function pickFile(title: string, filters: Record<string, string[]>, allowNew: boolean): Promise<string | undefined> {
  if (allowNew) {
    const choice = await vscode.window.showQuickPick(['Open existing file', 'Create new file'], { placeHolder: title });
    if (!choice) return undefined;
    if (choice === 'Create new file') return (await vscode.window.showSaveDialog({ title, filters }))?.fsPath;
  }
  const [uri] = (await vscode.window.showOpenDialog({ title, filters, canSelectMany: false })) ?? [];
  return uri?.fsPath;
}

/** 서버형(호스트·포트·DB·사용자·비밀번호) 입력 */
async function serverFields(driver: DriverId, draft: Draft): Promise<{ draft: Draft; password?: string } | undefined> {
  const host = await input('Host', 'localhost');
  if (host === undefined) return;
  const port = await input('Port', String(drivers[driver].defaultPort ?? ''));
  if (port === undefined) return;
  const database = await input(driver === 'h2' ? 'Database (H2 database path/name, e.g. ~/test)' : 'Database');
  if (database === undefined) return;
  const user = await input('User', driver === 'h2' ? 'sa' : driver === 'postgres' ? 'postgres' : 'root');
  if (user === undefined) return;
  const password = await input('Password (stored in the OS keychain)', '', true);
  if (password === undefined) return;
  return {
    draft: { ...draft, host, port: Number(port) || undefined, database: database || undefined, user: user || undefined },
    password: password || undefined,
  };
}

async function ensureH2Jar(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('bindb');
  if (config.get<string>('h2.jarPath')) return true;
  const jar = await pickFile('Select h2-*.jar (needed to open H2 files; requires java)', { 'H2 jar': ['jar'] }, false);
  if (!jar) return false;
  await config.update('h2.jarPath', jar, vscode.ConfigurationTarget.Global);
  return true;
}

export async function addConnectionWizard(store: ConnectionStore): Promise<ConnectionConfig | undefined> {
  const pickedDriver = await vscode.window.showQuickPick(
    Object.values(drivers).map((d) => ({ label: d.label, id: d.id })),
    { placeHolder: 'Database type' },
  );
  if (!pickedDriver) return;
  const driver = pickedDriver.id;
  let draft: Draft = { name: '', driver };
  let password: string | undefined;

  if (driver === 'sqlite') {
    const file = await pickFile('SQLite database file', { SQLite: ['db', 'sqlite', 'sqlite3', 'db3'], 'All files': ['*'] }, true);
    if (!file) return;
    draft.file = file;
  } else if (driver === 'h2') {
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Database file (.mv.db)', detail: 'BindB starts an H2 server for the file. Requires java and an h2 jar.', file: true },
        { label: 'Running H2 server', detail: 'Connect to `org.h2.tools.Server -pg` (PostgreSQL protocol, default port 5435).', file: false },
      ],
      { placeHolder: 'How to connect to H2' },
    );
    if (!mode) return;
    if (mode.file) {
      if (!(await ensureH2Jar())) return;
      const file = await pickFile('H2 database file', { H2: ['db'] }, false);
      if (!file) return;
      const user = await input('User', 'sa');
      if (user === undefined) return;
      const pw = await input('Password (stored in the OS keychain)', '', true);
      if (pw === undefined) return;
      draft = { ...draft, file, user };
      password = pw || undefined;
    } else {
      const r = await serverFields(driver, draft);
      if (!r) return;
      ({ draft, password } = r);
    }
  } else {
    const r = await serverFields(driver, draft);
    if (!r) return;
    ({ draft, password } = r);
  }

  const suggested = draft.file
    ? (draft.file.split(/[\\/]/).pop() ?? 'db').replace(/\.(mv\.db|sqlite3?|db3?)$/i, '')
    : `${draft.database ?? driver}@${draft.host ?? 'localhost'}`;
  const name = await input('Connection name (used in `-- @conn:` comments)', suggested);
  if (!name) return;
  if (store.findByName(name)) {
    vscode.window.showErrorMessage(`A connection named "${name}" already exists.`);
    return;
  }
  return store.add({ ...draft, name }, password);
}
