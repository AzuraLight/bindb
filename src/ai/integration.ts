import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ConnectionStore } from '../core/connections';
import type { SessionManager } from '../core/sessions';
import { pickConnection } from '../ui/binding';
import { errorText } from '../ui/explorer';
import { BindbMcpServer, newToken, schemaMarkdown } from './mcpServer';

/*
 * AI 에이전트 연계.
 *  - Copilot(에이전트 모드): VS Code MCP 서버 제공 API(contributes.mcpServerDefinitionProviders)로 자동 등록
 *    https://code.visualstudio.com/api/extension-guides/ai/mcp
 *  - Claude Code: `claude mcp add --transport http --scope user …` (설정은 ~/.claude.json, 저장소 파일에 토큰을 남기지 않는다)
 *    https://code.claude.com/docs/en/mcp
 *  - Codex: ~/.codex/config.toml 의 [mcp_servers.bindb] (url + http_headers)
 *  - 아무 AI 채팅: 연결의 스키마를 Markdown으로 복사
 */

const TOKEN_KEY = 'bindb.mcp.token';
const SECTION = 'bindb.ai';

export class AiIntegration implements vscode.Disposable {
  readonly server: BindbMcpServer;
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
  ) {
    this.server = new BindbMcpServer(
      store,
      sessions,
      {
        allowWrites: () => this.config.get<boolean>('allowWrites', false),
        confirmWrite: async (connection, sql) =>
          (await vscode.window.showWarningMessage(`An AI tool wants to change ${connection}.`, { modal: true, detail: sql }, 'Run')) === 'Run',
      },
      () => this.token(),
    );

    this.subs.push(
      vscode.lm.registerMcpServerDefinitionProvider('bindb', {
        onDidChangeMcpServerDefinitions: this.changed.event,
        provideMcpServerDefinitions: async () => {
          if (!this.enabled) return [];
          return [new vscode.McpHttpServerDefinition('BindB', vscode.Uri.parse(this.url), { Authorization: `Bearer ${await this.token()}` }, '0.2.0')];
        },
        resolveMcpServerDefinition: async (def) => {
          await this.ensureRunning();
          return def;
        },
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION)) void this.sync();
      }),
      vscode.commands.registerCommand('bindb.ai.enableMcp', () => this.enable(true)),
      vscode.commands.registerCommand('bindb.ai.disableMcp', () => this.enable(false)),
      vscode.commands.registerCommand('bindb.ai.setupClaudeCode', () => this.setupClaudeCode()),
      vscode.commands.registerCommand('bindb.ai.setupCodex', () => this.setupCodex()),
      vscode.commands.registerCommand('bindb.ai.copySchema', (node?: { cfg?: { id: string } }) => this.copySchema(node?.cfg?.id)),
      vscode.commands.registerCommand('bindb.ai.rotateToken', () => this.rotateToken()),
    );
    void this.sync();
  }

  private get config() {
    return vscode.workspace.getConfiguration(SECTION);
  }

  get enabled(): boolean {
    return this.config.get<boolean>('mcpServer.enabled', false);
  }

  get port(): number {
    return this.config.get<number>('mcpServer.port', 47863);
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async token(): Promise<string> {
    let t = await this.context.secrets.get(TOKEN_KEY);
    if (!t) {
      t = newToken();
      await this.context.secrets.store(TOKEN_KEY, t);
    }
    return t;
  }

  private async ensureRunning(): Promise<void> {
    if (!this.server.running) await this.server.start(this.port);
  }

  /** 설정에 맞춰 서버를 켜고 끈다 */
  private async sync(): Promise<void> {
    try {
      if (this.enabled) await this.ensureRunning();
      else await this.server.stop();
    } catch (e) {
      vscode.window.showErrorMessage(`BindB MCP server could not start on port ${this.port}: ${errorText(e)}`);
    }
    this.changed.fire();
  }

  private async enable(on: boolean): Promise<void> {
    await this.config.update('mcpServer.enabled', on, vscode.ConfigurationTarget.Global);
    await this.sync();
    if (on) vscode.window.showInformationMessage(`BindB MCP server is running at ${this.url}.`);
  }

  private async ensureEnabled(): Promise<boolean> {
    if (this.enabled && this.server.running) return true;
    const yes = 'Enable';
    const ok = await vscode.window.showInformationMessage(
      'AI agents reach BindB through a local MCP server (127.0.0.1 only, token required, read-only tools by default). Enable it?',
      { modal: true },
      yes,
    );
    if (ok !== yes) return false;
    await this.enable(true);
    return this.server.running;
  }

  private async setupClaudeCode(): Promise<void> {
    if (!(await this.ensureEnabled())) return;
    // 토큰을 명령줄에 쓰지 않는다(셸 기록에 남는다). 0600 임시 파일에 JSON을 쓰고, 명령은 그 파일을 읽게 한다
    const json = JSON.stringify({ type: 'http', url: this.url, headers: { Authorization: `Bearer ${await this.token()}` } });
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bindb-mcp-'));
    const file = path.join(dir, 'server.json');
    await writeFile(file, json, { encoding: 'utf8', mode: 0o600 });
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const cmd = `claude mcp add-json --scope user bindb "$(cat ${q(file)})" && rm -rf ${q(dir)}`;
    const run = 'Run in Terminal';
    const copy = 'Copy Command';
    const pick = await vscode.window.showInformationMessage(
      'Register BindB with Claude Code (user scope, stored in ~/.claude.json — not in this repository). The token is read from a private temporary file, so it does not end up in your shell history.',
      run,
      copy,
    );
    if (pick === run) {
      const term = vscode.window.createTerminal('BindB → Claude Code');
      term.show();
      term.sendText(cmd);
    } else if (pick === copy) {
      await vscode.env.clipboard.writeText(cmd);
      vscode.window.showInformationMessage('Copied. Paste it in a terminal where `claude` is installed (the temporary file is removed after it runs).');
    } else {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Codex: ~/.codex/config.toml 에 [mcp_servers.bindb]를 더한다(이미 있으면 건드리지 않는다) */
  private async setupCodex(): Promise<void> {
    if (!(await this.ensureEnabled())) return;
    const snippet = `\n[mcp_servers.bindb]\nurl = "${this.url}"\nhttp_headers = { Authorization = "Bearer ${await this.token()}" }\n`;
    const file = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');
    const add = 'Add to config.toml';
    const copy = 'Copy Snippet';
    const pick = await vscode.window.showInformationMessage(`Register BindB with Codex in ${file}?`, add, copy);
    if (pick === copy) {
      await vscode.env.clipboard.writeText(snippet.trim());
      vscode.window.showInformationMessage('Copied the [mcp_servers.bindb] section.');
      return;
    }
    if (pick !== add) return;
    const current = await readFile(file, 'utf8').catch(() => '');
    if (/^\s*\[mcp_servers\.bindb\]/m.test(current)) {
      vscode.window.showWarningMessage(`${file} already has [mcp_servers.bindb]. Edit it there, or use Copy Snippet.`);
      return;
    }
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, snippet, { encoding: 'utf8', mode: 0o600 });
    // 토큰이 들어갔으니 다른 사용자가 읽지 못하게 한다
    await chmod(file, 0o600).catch(() => {});
    vscode.window.showInformationMessage(`Added [mcp_servers.bindb] to ${file}. Restart Codex to pick it up.`);
  }

  private async copySchema(id?: string): Promise<void> {
    const cfg = id ? this.store.get(id) : await pickConnection(this.store, 'Copy the schema of which connection?');
    if (!cfg) return;
    try {
      const md = schemaMarkdown(cfg, await this.sessions.metadata(cfg));
      await vscode.env.clipboard.writeText(md);
      vscode.window.showInformationMessage(`Copied the ${cfg.name} schema as Markdown — paste it into any AI chat.`);
    } catch (e) {
      vscode.window.showErrorMessage(errorText(e));
    }
  }

  private async rotateToken(): Promise<void> {
    await this.context.secrets.store(TOKEN_KEY, newToken());
    await this.server.stop();
    await this.sync();
    vscode.window.showInformationMessage('Made a new MCP token. Run the Claude Code / Codex setup commands again to update them.');
  }

  dispose(): void {
    void this.server.stop();
    this.subs.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}
