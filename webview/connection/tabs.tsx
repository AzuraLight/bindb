import { useState, type ReactNode } from 'react';
import { Select } from './select';
import {
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_USER,
  DRIVER_LABELS,
  fieldsFor,
  hasUrl,
  parseUrl,
  toUrl,
  type AdvancedForm,
  type ConnectionForm,
  type FormErrors,
} from '../../src/core/connectionDraft';
import type { DriverId, SharedSshConfig } from '../../src/drivers/types';
import type { PickField, SecretField } from '../../src/shared/connectionProtocol';

/*
 * Data Sources 창 오른쪽의 탭들. 항목 이름 · 순서 · 값은 DataGrip 공식 문서를 따른다.
 * https://www.jetbrains.com/help/datagrip/data-sources-and-drivers-dialog.html
 */

export type Tab = 'general' | 'options' | 'sshssl' | 'schemas' | 'advanced';
export const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'options', label: 'Options' },
  { id: 'sshssl', label: 'SSH/SSL' },
  { id: 'schemas', label: 'Schemas' },
  { id: 'advanced', label: 'Advanced' },
];

/** 이 칸의 오류가 어느 탭에 있는가 */
export function tabOf(field: string): Tab {
  if (/^(ssh|ssl)/.test(field)) return 'sshssl';
  if (/^(schemaPattern|objectFilter)$/.test(field)) return 'schemas';
  if (/^(vm|workingDirectory|driverOptions)/.test(field)) return 'advanced';
  if (/^(keepAlive|autoDisconnect|introspectInterval|connectTimeout|timeZone|startupScript)$/.test(field)) return 'options';
  return 'general';
}

export interface SecretDraft {
  value: string;
  clear: boolean;
}

export interface EditorProps {
  form: ConnectionForm;
  secrets: Record<SecretField, SecretDraft>;
  has: Record<SecretField, boolean>;
  errors: FormErrors;
  h2Jar: string;
  setH2Jar: (v: string) => void;
  setForm: (f: ConnectionForm) => void;
  setSecret: (field: SecretField, s: SecretDraft) => void;
  pick: (field: PickField) => void;
  schemaTree?: SchemaTreeState;
  listSchemas: () => void;
  /** 공유 SSH 설정 */
  sshConfigs: SharedSshConfig[];
  setSshConfig: (c: SharedSshConfig) => void;
  /** 지금 칸의 SSH 값으로 공유 설정을 만들고 이 데이터 소스가 쓰게 한다 */
  shareSsh: () => void;
  /** Copy from: 다른 데이터 소스들 */
  copySources: { key: string; name: string }[];
  copyFrom: (key: string) => void;
}

export type SchemaTreeState = { kind: 'busy' } | { kind: 'fail'; message: string } | { kind: 'ok'; tree: { database?: string; schemas: string[] }[] };

const TIME_ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
})();

// ── General ───────────────────────────────

export function GeneralTab(p: EditorProps) {
  const { form, errors } = p;
  const a = form.adv;
  const f = fieldsFor(form.driver, form.h2Mode);
  const urlOnly = a.connectionType === 'url';
  const set = <K extends keyof ConnectionForm>(k: K, v: ConnectionForm[K]) => p.setForm({ ...form, [k]: v });
  const setA = <K extends keyof AdvancedForm>(k: K, v: AdvancedForm[K]) => p.setForm({ ...form, adv: { ...a, [k]: v } });

  const changeDriver = (driver: DriverId) => {
    const user = form.user === (DEFAULT_USER[form.driver] ?? '') ? (DEFAULT_USER[driver] ?? '') : form.user;
    const ssl = driver === 'postgres' || driver === 'mysql' ? form.ssl : 'disable';
    const auth = a.auth === 'pgpass' && driver !== 'postgres' ? 'password' : a.auth;
    p.setForm({ ...form, driver, user, ssl, port: '', file: '', adv: { ...a, auth } });
  };

  // H2의 연결 방식: Remote(떠 있는 서버) · Embedded(.mv.db 파일) · URL only
  const typeValue = urlOnly ? 'url' : form.driver === 'h2' ? (form.h2Mode === 'file' ? 'embedded' : 'remote') : 'default';
  const setType = (v: string) => {
    if (v === 'url') return setA('connectionType', 'url');
    p.setForm({ ...form, h2Mode: v === 'embedded' ? 'file' : 'server', adv: { ...a, connectionType: 'default' } });
  };

  const credentials = f.credentials || (urlOnly && form.driver !== 'sqlite');
  const pw = p.secrets.password;

  return (
    <div role="tabpanel">
      <div className="type-line">
        <label>
          Connection type:
          <Select className="link-select" value={typeValue} onChange={(e) => setType(e.target.value)}>
            {form.driver === 'h2' ? (
              <>
                <option value="remote">Remote</option>
                <option value="embedded">Embedded</option>
              </>
            ) : (
              <option value="default">default</option>
            )}
            <option value="url">URL only</option>
          </Select>
        </label>
        <label>
          Driver:
          <Select className="link-select" value={form.driver} onChange={(e) => changeDriver(e.target.value as DriverId)}>
            {(Object.keys(DRIVER_LABELS) as DriverId[]).map((d) => (
              <option key={d} value={d}>
                {DRIVER_LABELS[d]}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <div className="grid">
        {!urlOnly && f.server && (
          <Row label="Host" htmlFor="f-host" error={errors.host ?? errors.port}>
            <div className="pair">
              <input id="f-host" className={errors.host ? 'bad' : ''} value={form.host} onChange={(e) => set('host', e.target.value)} />
              <label className="pair-label" htmlFor="f-port">
                Port:
              </label>
              <input
                id="f-port"
                className={errors.port ? 'bad' : ''}
                value={form.port}
                inputMode="numeric"
                onChange={(e) => set('port', e.target.value)}
                placeholder={String(DEFAULT_PORT[form.driver] ?? '')}
              />
            </div>
          </Row>
        )}

        {!urlOnly && f.file && (
          <Row label="File" htmlFor="f-file" error={errors.file}>
            <div className="with-button">
              <input id="f-file" className={errors.file ? 'bad' : ''} value={form.file} onChange={(e) => set('file', e.target.value)} />
              <button className="dots" title="Choose a file" onClick={() => p.pick('file')}>
                …
              </button>
              {form.driver === 'sqlite' && (
                <button className="text-button" onClick={() => p.pick('newFile')}>
                  New file
                </button>
              )}
            </div>
          </Row>
        )}

        {form.driver === 'h2' && (
          <Row label="H2 jar" htmlFor="f-jar" hint="H2 JDBC driver file, shared by all H2 data sources. BindB runs it in a Java process started only while connected (Java 11+ on PATH or JAVA_HOME).">
            <div className="with-button">
              <input id="f-jar" value={p.h2Jar} onChange={(e) => p.setH2Jar(e.target.value)} placeholder="h2-*.jar" />
              <button className="dots" title="Choose the H2 jar" onClick={() => p.pick('h2Jar')}>
                …
              </button>
            </div>
          </Row>
        )}

        {credentials && (
          <>
            <Row label="Authentication" htmlFor="f-auth" gap>
              <Select id="f-auth" className="short" value={a.auth} onChange={(e) => setA('auth', e.target.value as AdvancedForm['auth'])}>
                <option value="password">User &amp; Password</option>
                {form.driver === 'postgres' && <option value="pgpass">pgpass</option>}
                <option value="none">No auth</option>
              </Select>
            </Row>
            {a.auth !== 'none' && (
              <Row label="User" htmlFor="f-user">
                <div className="pair">
                  <input id="f-user" value={form.user} onChange={(e) => set('user', e.target.value)} />
                  <span className="pair-spacer" />
                </div>
              </Row>
            )}
            {a.auth === 'password' && (
              <Row label="Password" htmlFor="f-password">
                <div className="pair">
                  <input
                    id="f-password"
                    type="password"
                    value={pw.value}
                    disabled={pw.clear}
                    onChange={(e) => p.setSecret('password', { value: e.target.value, clear: false })}
                    placeholder={p.has.password ? '<hidden>' : '<empty>'}
                  />
                  <label className="pair-label" htmlFor="f-save">
                    Save:
                  </label>
                  <Select id="f-save" value={a.passwordSave} onChange={(e) => setA('passwordSave', e.target.value as AdvancedForm['passwordSave'])}>
                    <option value="never">Never</option>
                    <option value="restart">Until restart</option>
                    <option value="session">For session</option>
                    <option value="forever">Forever</option>
                  </Select>
                </div>
                {p.has.password && (
                  <label className="check small">
                    <input type="checkbox" checked={pw.clear} onChange={(e) => p.setSecret('password', { value: '', clear: e.target.checked })} />
                    Set empty (forget the saved password)
                  </label>
                )}
              </Row>
            )}
            {a.auth === 'pgpass' && <p className="note grid-note">The password is read from ~/.pgpass for this host, port, database and user.</p>}
          </>
        )}

        {!urlOnly && f.server && (
          <Row label="Database" htmlFor="f-db" gap>
            <input id="f-db" value={form.database} onChange={(e) => set('database', e.target.value)} placeholder={form.driver === 'h2' ? '~/test' : ''} />
          </Row>
        )}

        {urlOnly ? (
          <Row label="URL" htmlFor="f-url" error={errors.url} gap>
            <input id="f-url" className={errors.url ? 'bad' : ''} value={a.url} spellCheck={false} onChange={(e) => setA('url', e.target.value)} />
          </Row>
        ) : (
          hasUrl(form) &&
          form.driver !== 'h2' && (
            <GeneratedUrl
              form={form}
              onParsed={(patch, password) => {
                p.setForm({ ...form, ...patch });
                if (password) p.setSecret('password', { value: password, clear: false });
              }}
            />
          )
        )}
      </div>
    </div>
  );
}

/** URL 칸: 칸들로 만든 URL을 보여 주고, 붙여 넣으면 칸을 채운다 */
function GeneratedUrl(props: { form: ConnectionForm; onParsed: (patch: Partial<ConnectionForm>, password?: string) => void }) {
  const [editing, setEditing] = useState<string>();
  const [error, setError] = useState<string>();
  const value = editing ?? toUrl(props.form);
  return (
    <Row label="URL" htmlFor="f-url" error={error} hint="Pasting a URL fills in the settings above" gap>
      <input
        id="f-url"
        className={error ? 'bad' : ''}
        value={value}
        spellCheck={false}
        onFocus={() => setEditing(value)}
        onBlur={() => {
          setEditing(undefined);
          setError(undefined);
        }}
        onChange={(e) => {
          setEditing(e.target.value);
          const r = parseUrl(e.target.value, props.form.driver);
          if (r.ok) {
            setError(undefined);
            props.onParsed(r.patch, r.password);
          } else setError(r.error);
        }}
      />
    </Row>
  );
}

// ── Options ───────────────────────────────

export function OptionsTab(p: EditorProps) {
  const { form, errors } = p;
  const a = form.adv;
  const f = fieldsFor(form.driver, form.h2Mode);
  const setA = <K extends keyof AdvancedForm>(k: K, v: AdvancedForm[K]) => p.setForm({ ...form, adv: { ...a, [k]: v } });
  const server = form.driver !== 'sqlite';

  return (
    <div role="tabpanel">
      <Section title="Connection">
        <label className="check">
          <input type="checkbox" checked={form.readOnly} onChange={(e) => p.setForm({ ...form, readOnly: e.target.checked })} />
          Read-only
        </label>
        <div className="opt-grid">
          <label htmlFor="o-tx">Transaction control:</label>
          <Select id="o-tx" className="link-select" value={a.transactionControl} onChange={(e) => setA('transactionControl', e.target.value as AdvancedForm['transactionControl'])}>
            <option value="auto">Auto</option>
            <option value="manual">Manual</option>
          </Select>

          <label htmlFor="o-switch">Switch schema:</label>
          <Select id="o-switch" className="short" value={a.switchSchema} onChange={(e) => setA('switchSchema', e.target.value as AdvancedForm['switchSchema'])}>
            <option value="automatic">Automatic</option>
            <option value="manual">Manual</option>
            <option value="disable">Disable</option>
          </Select>

          {server && (
            <>
              <label htmlFor="o-tz">Time zone:</label>
              <div>
                <input id="o-tz" className="mid" list="tz-list" value={a.timeZone} onChange={(e) => setA('timeZone', e.target.value)} />
                <datalist id="tz-list">
                  {TIME_ZONES.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
              </div>
            </>
          )}

          <label htmlFor="o-session">Session control:</label>
          <Select id="o-session" className="mid" value={a.sessionControl} onChange={(e) => setA('sessionControl', e.target.value as AdvancedForm['sessionControl'])}>
            <option value="single">Single shared session</option>
            <option value="two">Two sessions: shared and introspection</option>
            <option value="dedicated">Dedicated sessions</option>
          </Select>
        </div>

        <Toggle label="Run keep-alive query each" on={a.keepAliveOn} setOn={(v) => setA('keepAliveOn', v)} value={a.keepAlive} setValue={(v) => setA('keepAlive', v)} unit="sec." error={errors.keepAlive} />
        <Toggle label="Auto-disconnect after" on={a.autoDisconnectOn} setOn={(v) => setA('autoDisconnectOn', v)} value={a.autoDisconnect} setValue={(v) => setA('autoDisconnect', v)} unit="sec." error={errors.autoDisconnect} />
        {f.timeout && (
          <div className="inline-row indent-check">
            <label htmlFor="o-timeout">Connect timeout:</label>
            <input
              id="o-timeout"
              className={`num${errors.connectTimeout ? ' bad' : ''}`}
              value={form.connectTimeout}
              inputMode="numeric"
              onChange={(e) => p.setForm({ ...form, connectTimeout: e.target.value })}
              placeholder={String(DEFAULT_TIMEOUT_SECONDS)}
            />
            <span>sec.</span>
          </div>
        )}
        {errors.connectTimeout && <div className="error">{errors.connectTimeout}</div>}
        {(form.driver === 'postgres' || form.driver === 'mysql') && (
          <label className="check">
            <input type="checkbox" checked={a.singleDatabase} onChange={(e) => setA('singleDatabase', e.target.checked)} />
            Single database mode
          </label>
        )}
        <div className="opt-grid">
          <label htmlFor="o-startup">Startup script:</label>
          <textarea id="o-startup" rows={3} spellCheck={false} value={a.startupScript} onChange={(e) => setA('startupScript', e.target.value)} />
        </div>
      </Section>

      <Section title="Introspection">
        <label className="check">
          <input type="checkbox" checked={a.autoSync} onChange={(e) => setA('autoSync', e.target.checked)} />
          Auto sync
        </label>
        <div className="opt-grid">
          <label htmlFor="o-sources">Load sources for:</label>
          <Select id="o-sources" className="mid" value={a.loadSources} onChange={(e) => setA('loadSources', e.target.value as AdvancedForm['loadSources'])}>
            <option value="all">All schemas</option>
            <option value="nonSystem">All excl. system schemas</option>
            <option value="none">None</option>
          </Select>
        </div>
        <div className="opt-grid">
          <label htmlFor="o-level">Default level:</label>
          <Select id="o-level" className="mid" value={a.introspectionLevel} onChange={(e) => setA('introspectionLevel', e.target.value as AdvancedForm['introspectionLevel'])}>
            <option value="1">Level 1 — names only</option>
            <option value="2">Level 2 — everything except source code</option>
            <option value="3">Level 3 — everything</option>
          </Select>
        </div>
        <label className="check">
          <input type="checkbox" checked={a.trackSchemas} onChange={(e) => setA('trackSchemas', e.target.checked)} />
          Track databases/schemas creation and deletion
        </label>
        <label className="check">
          <input type="checkbox" checked={a.preIntrospected} onChange={(e) => setA('preIntrospected', e.target.checked)} />
          Use pre-introspected objects for system catalogs that are not introspected
        </label>
        <div className="opt-grid">
          <label htmlFor="o-virtual">Virtual objects and attributes:</label>
          <FileInput id="o-virtual" value={a.virtualObjectsFile} onChange={(v) => setA('virtualObjectsFile', v)} onPick={() => p.pick('virtualObjectsFile')} />
        </div>
        <div className="opt-grid">
          <label htmlFor="o-tpl">Use session template:</label>
          <Select id="o-tpl" className="mid" value={a.useSessionTemplate} onChange={(e) => setA('useSessionTemplate', e.target.value)}>
            <option value="">None</option>
            {a.sessionTemplates
              .filter((t) => t.name.trim())
              .map((t) => (
                <option key={t.name} value={t.name.trim()}>
                  {t.name}
                </option>
              ))}
          </Select>
        </div>
        {errors.useSessionTemplate && <div className="error">{errors.useSessionTemplate}</div>}
        <Toggle
          label="Automatic introspection interval"
          on={a.introspectOn}
          setOn={(v) => setA('introspectOn', v)}
          value={a.introspectInterval}
          setValue={(v) => setA('introspectInterval', v)}
          unit="minutes"
          error={errors.introspectInterval}
        />
      </Section>

      <Section title="Other">
        <div className="opt-grid">
          <label htmlFor="o-kw">Code style:</label>
          <div className="name-line">
            <Select id="o-kw" className="short" value={a.keywordCase} onChange={(e) => setA('keywordCase', e.target.value as AdvancedForm['keywordCase'])}>
              <option value="upper">Keywords UPPER</option>
              <option value="lower">keywords lower</option>
            </Select>
            <Select className="short" aria-label="Identifier quoting" value={a.quoteIdentifiers} onChange={(e) => setA('quoteIdentifiers', e.target.value as AdvancedForm['quoteIdentifiers'])}>
              <option value="always">Always quote identifiers</option>
              <option value="needed">Quote only when needed</option>
            </Select>
          </div>
          <label htmlFor="o-before">Before connection:</label>
          <div>
            <textarea id="o-before" rows={2} spellCheck={false} placeholder="One VS Code task name per line" value={a.beforeConnection} onChange={(e) => setA('beforeConnection', e.target.value)} />
            <div className="hint">Tasks from tasks.json (or extensions) run in order before the first connection; a non-zero exit code stops connecting.</div>
          </div>
        </div>
        <div className="sub-title">Session Templates</div>
        <p className="note">Template settings override the data source settings for its sessions. Pick one in Introspection · Use session template.</p>
        <table className="kv templates">
          <thead>
            <tr>
              <th>Name</th>
              <th>User</th>
              <th>Read-only</th>
              <th>Startup script</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {a.sessionTemplates.map((t, i) => {
              const setT = (patch: Partial<AdvancedForm['sessionTemplates'][number]>) =>
                setA('sessionTemplates', a.sessionTemplates.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <tr key={i}>
                  <td>
                    <input aria-label="Template name" value={t.name} onChange={(e) => setT({ name: e.target.value })} />
                  </td>
                  <td>
                    <input aria-label="Template user" value={t.user} onChange={(e) => setT({ user: e.target.value })} />
                  </td>
                  <td className="center">
                    <input type="checkbox" aria-label="Template read-only" checked={t.readOnly} onChange={(e) => setT({ readOnly: e.target.checked })} />
                  </td>
                  <td>
                    <input aria-label="Template startup script" spellCheck={false} value={t.startupScript} onChange={(e) => setT({ startupScript: e.target.value })} />
                  </td>
                  <td>
                    <button className="dots" title="Remove template" onClick={() => setA('sessionTemplates', a.sessionTemplates.filter((_, j) => j !== i))}>
                      −
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button className="text-button" onClick={() => setA('sessionTemplates', [...a.sessionTemplates, { name: `Template ${a.sessionTemplates.length + 1}`, user: '', readOnly: false, startupScript: '' }])}>
          + Add template
        </button>
      </Section>
    </div>
  );
}

function Toggle(props: { label: string; on: boolean; setOn: (v: boolean) => void; value: string; setValue: (v: string) => void; unit: string; error?: string }) {
  return (
    <>
      <div className="inline-row">
        <label className="check">
          <input type="checkbox" checked={props.on} onChange={(e) => props.setOn(e.target.checked)} />
          {props.label}
        </label>
        <input className={`num${props.error ? ' bad' : ''}`} value={props.value} disabled={!props.on} inputMode="numeric" onChange={(e) => props.setValue(e.target.value)} />
        <span>{props.unit}</span>
      </div>
      {props.error && <div className="error">{props.error}</div>}
    </>
  );
}

// ── SSH/SSL ───────────────────────────────

/** SSH 칸 값: 이 데이터 소스만의 값(adv.ssh*) 또는 공유 설정(SharedSshConfig) */
interface SshFields {
  host: string;
  port: string;
  user: string;
  auth: 'password' | 'key' | 'agent';
  keyFile: string;
  parseConfig: boolean;
  keepAlive: string;
  strict: 'yes' | 'acceptNew' | 'no' | 'ask';
}

export function SshSslTab(p: EditorProps) {
  const { form, errors } = p;
  const a = form.adv;
  const setA = <K extends keyof AdvancedForm>(k: K, v: AdvancedForm[K]) => p.setForm({ ...form, adv: { ...a, [k]: v } });
  const sslAvailable = form.driver === 'postgres' || form.driver === 'mysql';
  const useSsl = form.ssl !== 'disable';
  const ssh = p.secrets.ssh;
  const sslKey = p.secrets.sslKey;
  const sshAvailable = form.driver !== 'sqlite' && !(form.driver === 'h2' && form.h2Mode === 'file');
  const shared = a.sshConfigId ? p.sshConfigs.find((c) => c.id === a.sshConfigId) : undefined;

  // 보이는 값과 고치는 곳: 공유 설정을 골랐으면 그 설정을, 아니면 이 데이터 소스의 값을
  const f: SshFields = shared
    ? {
        host: shared.host,
        port: shared.port !== undefined ? String(shared.port) : '22',
        user: shared.user,
        auth: shared.auth,
        keyFile: shared.keyFile ?? '',
        parseConfig: !!shared.parseConfig,
        keepAlive: shared.keepAlive !== undefined ? String(shared.keepAlive) : '',
        strict: shared.strictHostKey ?? 'ask',
      }
    : { host: a.sshHost, port: a.sshPort, user: a.sshUser, auth: a.sshAuth, keyFile: a.sshKeyFile, parseConfig: a.sshParseConfig, keepAlive: a.sshKeepAlive, strict: a.sshStrict };
  const setF = (patch: Partial<SshFields>) => {
    if (shared) {
      const n = { ...f, ...patch };
      p.setSshConfig({
        ...shared,
        host: n.host,
        port: Number(n.port) || 22,
        user: n.user,
        auth: n.auth,
        keyFile: n.keyFile || undefined,
        parseConfig: n.parseConfig || undefined,
        keepAlive: Number(n.keepAlive) || undefined,
        strictHostKey: n.strict === 'ask' ? undefined : n.strict,
      });
      return;
    }
    const map: Record<keyof SshFields, keyof AdvancedForm> = {
      host: 'sshHost', port: 'sshPort', user: 'sshUser', auth: 'sshAuth', keyFile: 'sshKeyFile', parseConfig: 'sshParseConfig', keepAlive: 'sshKeepAlive', strict: 'sshStrict',
    };
    const adv = { ...a };
    for (const [k, v] of Object.entries(patch)) (adv as Record<string, unknown>)[map[k as keyof SshFields]] = v;
    p.setForm({ ...form, adv });
  };
  const on = a.sshEnabled;

  return (
    <div role="tabpanel">
      <div className="name-line copy-line">
        <label className="check big">
          <input type="checkbox" checked={on} disabled={!sshAvailable} onChange={(e) => setA('sshEnabled', e.target.checked)} />
          Use SSH tunnel
        </label>
        {p.copySources.length > 0 && (
          <Select
            className="short"
            aria-label="Copy SSH/SSL settings from"
            value=""
            onChange={(e) => {
              if (e.target.value) p.copyFrom(e.target.value);
            }}
          >
            <option value="">Copy from…</option>
            {p.copySources.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      {!sshAvailable && <p className="note">{form.driver === 'sqlite' ? 'SQLite' : 'H2 Embedded'} opens a local file; there is nothing to tunnel.</p>}
      <div className={`grid indent${on ? '' : ' disabled'}`}>
        <Row label="SSH configuration" htmlFor="s-cfg">
          <div className="name-line">
            <Select id="s-cfg" className="mid" disabled={!on} value={a.sshConfigId} onChange={(e) => setA('sshConfigId', e.target.value)}>
              <option value="">This data source only</option>
              {p.sshConfigs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            {!shared && (
              <button className="text-button" disabled={!on || !a.sshHost.trim()} onClick={() => p.shareSsh()}>
                Save as shared configuration
              </button>
            )}
          </div>
          {shared && <div className="hint">Shared configuration — changes here apply to every data source that uses it.</div>}
        </Row>
        <Row label="Host" htmlFor="s-host" error={errors.sshHost ?? errors.sshPort}>
          <div className="pair">
            <input id="s-host" disabled={!on} className={errors.sshHost ? 'bad' : ''} value={f.host} onChange={(e) => setF({ host: e.target.value })} />
            <label className="pair-label" htmlFor="s-port">
              Port:
            </label>
            <input id="s-port" disabled={!on} className={errors.sshPort ? 'bad' : ''} value={f.port} onChange={(e) => setF({ port: e.target.value })} />
          </div>
        </Row>
        <Row label="User name" htmlFor="s-user" error={errors.sshUser}>
          <input id="s-user" disabled={!on} className={errors.sshUser ? 'bad' : ''} value={f.user} onChange={(e) => setF({ user: e.target.value })} />
        </Row>
        <Row label="Authentication type" htmlFor="s-auth">
          <Select id="s-auth" className="mid" disabled={!on} value={f.auth} onChange={(e) => setF({ auth: e.target.value as SshFields['auth'] })}>
            <option value="password">Password</option>
            <option value="key">Key pair</option>
            <option value="agent">OpenSSH config and authentication agent</option>
          </Select>
        </Row>
        {f.auth === 'key' && (
          <Row label="Private key file" htmlFor="s-key" error={errors.sshKeyFile}>
            <FileInput id="s-key" disabled={!on} value={f.keyFile} onChange={(v) => setF({ keyFile: v })} onPick={() => p.pick('sshKeyFile')} />
          </Row>
        )}
        {f.auth !== 'agent' && (
          <Row label={f.auth === 'key' ? 'Passphrase' : 'Password'} htmlFor="s-pass">
            <input
              id="s-pass"
              type="password"
              disabled={!on || ssh.clear}
              value={ssh.value}
              placeholder={p.has.ssh ? '<hidden>' : '<empty>'}
              onChange={(e) => p.setSecret('ssh', { value: e.target.value, clear: false })}
            />
          </Row>
        )}
        {f.auth !== 'agent' && (
          <Row label="Config file">
            <label className="check">
              <input type="checkbox" disabled={!on} checked={f.parseConfig} onChange={(e) => setF({ parseConfig: e.target.checked })} />
              Parse config file ~/.ssh/config
            </label>
          </Row>
        )}
        <Row label="Keep-alive" htmlFor="s-ka" error={errors.sshKeepAlive}>
          <div className="inline-row">
            <span>Send keep-alive messages every</span>
            <input id="s-ka" className="num" disabled={!on} value={f.keepAlive} placeholder="off" onChange={(e) => setF({ keepAlive: e.target.value })} />
            <span>sec.</span>
          </div>
        </Row>
        <Row label="Strict host key checking" htmlFor="s-strict">
          <Select id="s-strict" className="short" disabled={!on} value={f.strict} onChange={(e) => setF({ strict: e.target.value as SshFields['strict'] })}>
            <option value="yes">Yes</option>
            <option value="acceptNew">Accept New</option>
            <option value="no">No</option>
            <option value="ask">Ask</option>
          </Select>
        </Row>
        <Row label="Local port" htmlFor="s-local" error={errors.sshLocalPort}>
          <input id="s-local" className="num" disabled={!on} value={a.sshLocalPort} placeholder="<Dynamic>" onChange={(e) => setA('sshLocalPort', e.target.value)} />
        </Row>
      </div>

      <hr className="divider" />

      <label className="check big">
        <input type="checkbox" checked={useSsl} disabled={!sslAvailable} onChange={(e) => p.setForm({ ...form, ssl: e.target.checked ? 'require' : 'disable' })} />
        Use SSL
      </label>
      {!sslAvailable && <p className="note">{DRIVER_LABELS[form.driver]} connections do not use SSL.</p>}
      <div className={`grid indent${useSsl ? '' : ' disabled'}`}>
        <Row label="CA file" htmlFor="l-ca">
          <FileInput id="l-ca" disabled={!useSsl} value={a.sslCaFile} onChange={(v) => setA('sslCaFile', v)} onPick={() => p.pick('sslCaFile')} />
        </Row>
        <Row label="Use truststore" hint="Bundled = the CA list built into Node.js (DataGrip's JAVA store). System = the operating system's store. BindB has no separate IDE store.">
          <div className="inline-row">
            <label className="check">
              <input type="checkbox" disabled={!useSsl} checked={a.sslTrustBundled} onChange={(e) => setA('sslTrustBundled', e.target.checked)} />
              Bundled
            </label>
            <label className="check">
              <input type="checkbox" disabled={!useSsl} checked={a.sslTrustSystem} onChange={(e) => setA('sslTrustSystem', e.target.checked)} />
              System
            </label>
          </div>
        </Row>
        <Row label="Client certificate file" htmlFor="l-cert">
          <FileInput id="l-cert" disabled={!useSsl} value={a.sslCertFile} onChange={(v) => setA('sslCertFile', v)} onPick={() => p.pick('sslCertFile')} />
        </Row>
        <Row label="Client key file" htmlFor="l-key">
          <FileInput id="l-key" disabled={!useSsl} value={a.sslKeyFile} onChange={(v) => setA('sslKeyFile', v)} onPick={() => p.pick('sslKeyFile')} />
        </Row>
        <Row label="Client key password" htmlFor="l-keypw">
          <input
            id="l-keypw"
            type="password"
            disabled={!useSsl || !a.sslKeyFile}
            value={sslKey.value}
            placeholder={p.has.sslKey ? '<hidden>' : '<empty>'}
            onChange={(e) => p.setSecret('sslKey', { value: e.target.value, clear: false })}
          />
        </Row>
        <Row label="Mode" htmlFor="l-mode" hint="Prefer: SSL if the server supports it, otherwise plain. Require: encrypt without checking the certificate — with a CA file it checks the chain like Verify CA (as libpq does). Verify CA: certificate chain. Verify full: chain and host name.">
          <Select id="l-mode" className="short" disabled={!useSsl} value={useSsl ? form.ssl : 'require'} onChange={(e) => p.setForm({ ...form, ssl: e.target.value as ConnectionForm['ssl'] })}>
            <option value="prefer">Prefer</option>
            <option value="require">Require</option>
            <option value="verify-ca">Verify CA</option>
            <option value="verify">Verify full</option>
          </Select>
        </Row>
      </div>
    </div>
  );
}

function FileInput(props: { id: string; value: string; disabled?: boolean; onChange: (v: string) => void; onPick: () => void }) {
  return (
    <div className="with-button">
      <input id={props.id} disabled={props.disabled} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      <button className="dots" disabled={props.disabled} title="Choose a file" onClick={props.onPick}>
        …
      </button>
    </div>
  );
}

// ── Schemas ───────────────────────────────

export function SchemasTab(p: EditorProps) {
  const { form, errors } = p;
  const a = form.adv;
  const setA = <K extends keyof AdvancedForm>(k: K, v: AdvancedForm[K]) => p.setForm({ ...form, adv: { ...a, [k]: v } });
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = p.schemaTree;
  const dbNames = tree?.kind === 'ok' ? tree.tree.map((n) => n.database ?? '@') : [];

  // 체크한 스키마 → Schema pattern(`db:s1,s2|db2:*`)
  const selected = parsePattern(a.schemaPattern);
  const toggle = (database: string | undefined, schema: string, on: boolean) => {
    const db = database ?? '@';
    const list = new Set(selected.get(db) ?? []);
    if (on) list.add(schema);
    else list.delete(schema);
    const next = new Map(selected);
    if (list.size) next.set(db, [...list]);
    else next.delete(db);
    setA('schemaPattern', [...next.entries()].map(([d, s]) => `${d}:${s.join(',')}`).join('|'));
  };

  return (
    <div role="tabpanel">
      <div className="schema-tools">
        <button className="text-button" onClick={p.listSchemas} disabled={tree?.kind === 'busy'}>
          Refresh
        </button>
        <button className="text-button" disabled={tree?.kind !== 'ok'} onClick={() => setCollapsed(new Set())}>
          Expand All
        </button>
        <button className="text-button" disabled={tree?.kind !== 'ok'} onClick={() => setCollapsed(new Set(dbNames))}>
          Collapse All
        </button>
        <input className="mid" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="schema-tree">
        {!tree && <p className="note">Click Refresh to load the databases and schemas from the server.</p>}
        {tree?.kind === 'busy' && <p className="note">Loading…</p>}
        {tree?.kind === 'fail' && <p className="error">{tree.message}</p>}
        {tree?.kind === 'ok' &&
          tree.tree.map((node) => (
            <div key={node.database ?? '@'} className="tree-db">
              {node.database && (
                <button
                  className="tree-db-name"
                  aria-expanded={!collapsed.has(node.database)}
                  onClick={() =>
                    setCollapsed((c) => {
                      const next = new Set(c);
                      if (next.has(node.database!)) next.delete(node.database!);
                      else next.add(node.database!);
                      return next;
                    })
                  }
                >
                  {collapsed.has(node.database) ? '▸' : '▾'} {node.database}
                </button>
              )}
              {!collapsed.has(node.database ?? '@') && node.schemas
                .filter((s) => s.toLowerCase().includes(filter.toLowerCase()))
                .map((s) => {
                  const db = node.database ?? '@';
                  const on = (selected.get(db) ?? []).includes(s) || (selected.get(db) ?? []).includes('*');
                  return (
                    <label key={s} className="check tree-schema">
                      <input type="checkbox" checked={on} onChange={(e) => toggle(node.database, s, e.target.checked)} />
                      {s}
                    </label>
                  );
                })}
              {node.database && !collapsed.has(node.database) && !node.schemas.length && <div className="note tree-schema">Schemas load when this database is opened in the explorer.</div>}
            </div>
          ))}
      </div>

      <div className="grid">
        <Row label="Schema pattern" htmlFor="sc-pattern" error={errors.schemaPattern} hint="db:schema items joined with |. @ = current, * = all. Empty = all schemas.">
          <input id="sc-pattern" spellCheck={false} value={a.schemaPattern} onChange={(e) => setA('schemaPattern', e.target.value)} />
        </Row>
        <Row label="Object filter" htmlFor="sc-filter" error={errors.objectFilter} hint="<type>:[-]<regex>, e.g. table:-tmp_.*  view:report_.*">
          <input id="sc-filter" spellCheck={false} value={a.objectFilter} onChange={(e) => setA('objectFilter', e.target.value)} />
        </Row>
      </div>
      <div className="checks">
        <label className="check">
          <input type="checkbox" checked={a.showSystemSchemas} onChange={(e) => setA('showSystemSchemas', e.target.checked)} />
          Show internal system schemas
        </label>
        {form.driver === 'postgres' && (
          <label className="check">
            <input type="checkbox" checked={a.showTemplateDatabases} onChange={(e) => setA('showTemplateDatabases', e.target.checked)} />
            Show template databases
          </label>
        )}
      </div>
    </div>
  );
}

function parsePattern(pattern: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const item of pattern.split('|').map((x) => x.trim()).filter(Boolean)) {
    const [db, schemas] = item.includes(':') ? item.split(':', 2) : ['@', item];
    out.set(db, [...(out.get(db) ?? []), ...schemas.split(',').map((x) => x.trim()).filter(Boolean)]);
  }
  return out;
}

// ── Advanced ──────────────────────────────

export function AdvancedTab(p: EditorProps) {
  const { form, errors } = p;
  const a = form.adv;
  const setA = <K extends keyof AdvancedForm>(k: K, v: AdvancedForm[K]) => p.setForm({ ...form, adv: { ...a, [k]: v } });
  const rows = [...a.driverOptions, { key: '', value: '' }];
  const setRow = (i: number, row: { key: string; value: string }) => {
    const next = rows.map((r, j) => (j === i ? row : r)).filter((r, j) => j < rows.length - 1 || r.key || r.value);
    setA('driverOptions', next.filter((r) => r.key || r.value));
  };
  const jvm = form.driver === 'h2';

  return (
    <div role="tabpanel">
      <table className="kv">
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <input value={r.key} placeholder={i === rows.length - 1 ? 'Add option…' : ''} spellCheck={false} onChange={(e) => setRow(i, { ...r, key: e.target.value })} />
              </td>
              <td>
                <input value={r.value} spellCheck={false} onChange={(e) => setRow(i, { ...r, value: e.target.value })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">
        Passed to the {form.driver === 'mysql' ? 'mysql2' : form.driver === 'sqlite' ? 'SQLite' : 'pg'} client as connection options
        {form.driver === 'postgres' ? ' (for example application_name, statement_timeout, options).' : '.'}
      </p>

      <div className="grid adv-grid">
        <Row label="VM options" htmlFor="a-vm" hint={jvm ? 'Arguments for the java process that runs the H2 server (Embedded).' : 'Used by H2 Embedded only.'}>
          <input id="a-vm" disabled={!jvm} spellCheck={false} value={a.vmOptions} onChange={(e) => setA('vmOptions', e.target.value)} />
        </Row>
        <Row label="VM environment" htmlFor="a-env" error={errors.vmEnvironment} hint="KEY=VALUE, one per line.">
          <textarea id="a-env" rows={3} disabled={!jvm} spellCheck={false} value={a.vmEnvironment} onChange={(e) => setA('vmEnvironment', e.target.value)} />
        </Row>
        <Row label="Working directory" htmlFor="a-wd" hint="Base for relative file paths (database file, certificates, keys).">
          <FileInput id="a-wd" value={a.workingDirectory} onChange={(v) => setA('workingDirectory', v)} onPick={() => p.pick('workingDirectory')} />
        </Row>
      </div>
    </div>
  );
}

// ── 공용 ─────────────────────────────────

/** 라벨 | 칸 한 줄. gap = 위에 여백(DataGrip이 무리를 나누는 간격) */
export function Row(props: { label: string; htmlFor?: string; error?: string; hint?: string; gap?: boolean; children: ReactNode }) {
  return (
    <>
      <label className={`row-label${props.gap ? ' gap' : ''}`} htmlFor={props.htmlFor}>
        {props.label}:
      </label>
      <div className={`row-field${props.gap ? ' gap' : ''}`}>
        {props.children}
        {props.error ? <div className="error">{props.error}</div> : props.hint ? <div className="hint">{props.hint}</div> : null}
      </div>
    </>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h3>
        <span>{props.title}</span>
      </h3>
      <div className="section-body">{props.children}</div>
    </section>
  );
}
