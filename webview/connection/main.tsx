import './connection.css';
import { Select } from './select';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DRIVER_LABELS, buildConfig, emptyForm, suggestName, type ConnectionForm, type FormErrors } from '../../src/core/connectionDraft';
import type { DriverId, SharedSshConfig } from '../../src/drivers/types';
import type {
  Change,
  DataSourceTemplate,
  DriverInfo,
  PanelHostToWebview,
  PanelInit,
  PanelWebviewToHost,
  PickField,
  SecretChanges,
  SecretField,
} from '../../src/shared/connectionProtocol';
import { DRIVER_LOGOS } from '../../src/shared/driverLogos';
import { AdvancedTab, GeneralTab, OptionsTab, SchemasTab, SshSslTab, TABS, tabOf, type SchemaTreeState, type SecretDraft, type Tab } from './tabs';

/*
 * DataGrip의 Data Sources and Drivers 창(JetBrains 공식 문서 스크린샷)을 따른다.
 * https://www.jetbrains.com/help/datagrip/data-sources-and-drivers-dialog.html
 *  - 왼쪽: Data Sources | Drivers 탭, + − 복제 · 드라이버로 가기 · 뒤로 · 앞으로, 전역/프로젝트 목록, Problems
 *  - 오른쪽: Name · Comment, 탭(General · Options · SSH/SSL · Schemas · Advanced), 아래 띠에 Test Connection
 *  - 창 전체 폭 아래 줄: Cancel · Apply · OK
 */

declare function acquireVsCodeApi(): { postMessage(msg: PanelWebviewToHost): void };
const vscode = acquireVsCodeApi();
const send = (msg: PanelWebviewToHost) => vscode.postMessage(msg);

const DRIVERS = Object.keys(DRIVER_LABELS) as DriverId[];
const SECRET_FIELDS: SecretField[] = ['password', 'sslKey', 'ssh'];
const noSecrets = (): Record<SecretField, SecretDraft> => ({
  password: { value: '', clear: false },
  sslKey: { value: '', clear: false },
  ssh: { value: '', clear: false },
});

interface Draft {
  key: string;
  /** 저장된 연결이면 id */
  id?: string;
  form: ConnectionForm;
  /** 저장된 값(Reset Changes) */
  saved?: ConnectionForm;
  secrets: Record<SecretField, SecretDraft>;
  has: Record<SecretField, boolean>;
  dirty: boolean;
  /** 이름을 직접 썼는가. 쓰기 전에는 입력에 따라 이름을 제안한다. */
  nameTouched: boolean;
}

type TestState = { kind: 'busy' } | { kind: 'ok' | 'fail'; text: string; detail?: string };
/** 왼쪽에서 고른 것: 데이터 소스, 드라이버, Problems */
type Selection = { kind: 'source'; key: string } | { kind: 'driver'; id: DriverId } | { kind: 'problems' } | { kind: 'template'; index: number };

let seq = 0;
const newDraft = (driver: DriverId, form?: ConnectionForm): Draft => ({
  key: `new-${++seq}`,
  form: form ?? emptyForm(driver),
  secrets: noSecrets(),
  has: { password: false, sslKey: false, ssh: false },
  dirty: true,
  nameTouched: !!form,
});

/** 새 DDL data source 초안 */
const newDdlDraft = (dialect: DriverId, name = ''): Draft => {
  const base = emptyForm(dialect);
  return { ...newDraft(dialect, { ...base, name, adv: { ...base.adv, kind: 'ddl' } }), nameTouched: !!name };
};

const effective = (d: Draft): ConnectionForm => (d.nameTouched || d.form.name ? d.form : { ...d.form, name: suggestName(d.form) });

const secretChanges = (d: Draft): SecretChanges =>
  Object.fromEntries(
    SECRET_FIELDS.map((f) => [f, d.secrets[f].clear ? { kind: 'clear' } : d.secrets[f].value ? { kind: 'set', value: d.secrets[f].value } : { kind: 'keep' }]),
  ) as SecretChanges;

const same = (a: Selection | undefined, b: Selection | undefined) => JSON.stringify(a) === JSON.stringify(b);

function Logo(props: { driver: DriverId; size?: number }) {
  const l = DRIVER_LOGOS[props.driver];
  const s = props.size ?? 18;
  return (
    <svg className="logo" width={s} height={s} viewBox="0 0 24 24" role="img" aria-label={l.title}>
      <rect width="24" height="24" rx="5" fill={l.hex} />
      <g transform="translate(4 4) scale(0.6667)">
        <path d={l.path} fill="#fff" />
      </g>
    </svg>
  );
}

function App() {
  const [drafts, setDrafts] = useState<Draft[]>();
  const [removed, setRemoved] = useState<string[]>([]);
  const [sel, setSelRaw] = useState<Selection>();
  const [history, setHistory] = useState<{ back: Selection[]; forward: Selection[] }>({ back: [], forward: [] });
  const [leftTab, setLeftTab] = useState<'sources' | 'drivers'>('sources');
  const [tab, setTab] = useState<Tab>('general');
  const [errors, setErrors] = useState<Record<string, FormErrors>>({});
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [schemaTrees, setSchemaTrees] = useState<Record<string, SchemaTreeState>>({});
  const [h2Jar, setH2Jar] = useState('');
  const [h2JarDirty, setH2JarDirty] = useState(false);
  const [driverInfo, setDriverInfo] = useState<DriverInfo[]>([]);
  const [canUseProject, setCanUseProject] = useState(false);
  const [sshConfigs, setSshConfigs] = useState<SharedSshConfig[]>([]);
  const [sshDirty, setSshDirty] = useState(false);
  const [templates, setTemplates] = useState<DataSourceTemplate[]>([]);
  const [templatesDirty, setTemplatesDirty] = useState(false);
  const [applyError, setApplyError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; key: string }>();

  // 메시지 처리기에서 최신 상태를 읽는다.
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const createMappingRef = useRef<(key: string) => void>(() => {});

  /** 고르기 + 뒤로/앞으로 기록 */
  const select = (next: Selection | undefined, record = true) => {
    setSelRaw((prev) => {
      if (record && prev && next && !same(prev, next)) setHistory((h) => ({ back: [...h.back, prev].slice(-50), forward: [] }));
      return next;
    });
  };

  /** 확장(호스트)과 화면의 판이 다르면 init에 항목이 빠진다 — 빈 화면 대신 알린다 */
  const [mismatch, setMismatch] = useState(false);

  const load = (init: PanelInit) => {
    const required: (keyof PanelInit)[] = ['items', 'drivers', 'sshConfigs', 'templates'];
    if (required.some((k) => !Array.isArray(init[k]))) {
      setMismatch(true);
      return;
    }
    const list: Draft[] = init.items.map((it) => ({
      key: it.id,
      id: it.id,
      form: it.form,
      saved: it.form,
      secrets: noSecrets(),
      has: it.has,
      dirty: false,
      nameTouched: true,
    }));
    let key = init.select && list.some((d) => d.key === init.select) ? init.select : list[0]?.key;
    if (init.addNew) {
      const d = newDraft(init.addNew);
      list.push(d);
      key = d.key;
    }
    if (init.createDdlMapping && key) {
      const src = list.find((d) => d.key === key);
      if (src) {
        const ddl = newDdlDraft(src.form.driver, `${src.form.name} (DDL)`);
        src.form = { ...src.form, adv: { ...src.form.adv, ddlMapping: ddl.key } };
        src.dirty = true;
        list.push(ddl);
        key = ddl.key;
      }
    }
    setDrafts(list);
    setRemoved([]);
    setSelRaw(key ? { kind: 'source', key } : undefined);
    setHistory({ back: [], forward: [] });
    setTab('general');
    setErrors({});
    setTests({});
    setH2Jar(init.h2Jar);
    setH2JarDirty(false);
    setDriverInfo(init.drivers);
    setCanUseProject(init.canUseProject);
    setSshConfigs(init.sshConfigs);
    setSshDirty(false);
    setTemplates(init.templates);
    setTemplatesDirty(false);
    setApplyError(undefined);
    setBusy(false);
    setMenu(!!init.pickDriver);
    setLeftTab('sources');
  };

  const add = (driver: DriverId, form?: ConnectionForm) => {
    const d = newDraft(driver, form);
    setDrafts((list) => [...(list ?? []), d]);
    select({ kind: 'source', key: d.key });
    setLeftTab('sources');
    setTab('general');
    setMenu(false);
    setApplyError(undefined);
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent<PanelHostToWebview>) => {
      const m = e.data;
      switch (m.t) {
        case 'init':
          load(m.init);
          break;
        case 'focus':
          if (m.createDdlMapping && m.select) createMappingRef.current(m.select);
          else if (m.pickDriver) setMenu(true);
          else if (m.addNew) add(m.addNew);
          else if (m.select && draftsRef.current?.some((d) => d.key === m.select)) select({ kind: 'source', key: m.select });
          break;
        case 'picked':
          if (m.field === 'h2Jar') {
            setH2Jar(m.path);
            setH2JarDirty(true);
            break;
          }
          setDrafts((list) =>
            list?.map((d) => {
              if (d.key !== m.key) return d;
              const form =
                m.field === 'file' || m.field === 'newFile'
                  ? { ...d.form, file: m.path }
                  : { ...d.form, adv: { ...d.form.adv, [m.field]: m.path } };
              return { ...d, form, dirty: true };
            }),
          );
          break;
        case 'tested':
          setTests((t) => ({ ...t, [m.key]: { kind: m.ok ? 'ok' : 'fail', text: m.message, detail: m.detail } }));
          break;
        case 'h2Versions':
        case 'h2Downloaded':
          window.dispatchEvent(new CustomEvent('bindb-h2', { detail: m }));
          if (m.t === 'h2Downloaded' && m.path) {
            setH2Jar(m.path);
            setH2JarDirty(false);
          }
          break;
        case 'schemas':
          setSchemaTrees((t) => ({ ...t, [m.key]: m.ok ? { kind: 'ok', tree: m.tree ?? [] } : { kind: 'fail', message: m.message ?? 'Failed.' } }));
          break;
        case 'applyFailed': {
          setBusy(false);
          setApplyError(m.message ?? (m.errors ? 'Fix the highlighted fields.' : undefined));
          if (m.errors) {
            setErrors(m.errors);
            const first = Object.keys(m.errors)[0];
            if (first) {
              select({ kind: 'source', key: first });
              setLeftTab('sources');
              const field = Object.keys(m.errors[first])[0];
              if (field) setTab(tabOf(field));
            }
          }
          break;
        }
      }
    };
    window.addEventListener('message', onMessage);
    send({ t: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!menu && !ctxMenu) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(false);
        setCtxMenu(undefined);
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menu, ctxMenu]);

  if (mismatch) {
    return (
      <div className="placeholder mismatch">
        <div>
          <p>BindB was updated, but VS Code is still running the previous version.</p>
          <p className="muted">Run “Developer: Reload Window” (or “Developer: Restart Extension Host”), then open Data Sources again.</p>
        </div>
      </div>
    );
  }
  if (!drafts) return null;

  const current = sel?.kind === 'source' ? drafts.find((d) => d.key === sel.key) : undefined;
  const dirty = removed.length > 0 || h2JarDirty || sshDirty || templatesDirty || drafts.some((d) => d.dirty);

  /** Save as Template: 자격 증명(사용자 · 비밀번호)과 이름 · 메모 · 매핑은 빼고 담는다 */
  const saveTemplate = (key: string) => {
    const d = drafts.find((x) => x.key === key);
    if (!d) return;
    const f = effective(d);
    const form: ConnectionForm = { ...f, name: '', comment: '', user: '', adv: { ...f.adv, ddlMapping: '', ddlScope: '', url: f.adv.url.replace(/\/\/[^@/]*@/, '//') } };
    setTemplates((list) => [...list, { name: `${f.name || DRIVER_LABELS[f.driver]} template`, form }]);
    setTemplatesDirty(true);
    setLeftTab('sources');
    select({ kind: 'template', index: templates.length });
  };

  const update = (key: string, p: Partial<Draft>) => {
    setDrafts((list) => list?.map((d) => (d.key === key ? { ...d, ...p, dirty: true } : d)));
    setTests((t) => {
      if (!t[key] || t[key].kind === 'busy') return t;
      const { [key]: _drop, ...rest } = t;
      return rest;
    });
    setApplyError(undefined);
  };

  const removeDraft = (key: string) => {
    const target = drafts.find((d) => d.key === key);
    if (!target) return;
    const i = drafts.indexOf(target);
    const rest = drafts.filter((d) => d !== target);
    if (target.id) setRemoved((r) => [...r, target.id!]);
    setDrafts(rest);
    const next = rest[Math.min(i, rest.length - 1)];
    select(next ? { kind: 'source', key: next.key } : undefined, false);
  };

  /** Create DDL Mapping: 새 DDL data source를 만들어 이 데이터 소스에 매핑하고 고른다 */
  const createMapping = (key: string) => {
    const src = (draftsRef.current ?? []).find((d) => d.key === key);
    if (!src) return;
    const name = effective(src).name;
    const ddl = newDdlDraft(src.form.driver, `${name} (DDL)`);
    setDrafts((list) => [
      ...(list ?? []).map((d) => (d.key === key ? { ...d, form: { ...d.form, adv: { ...d.form.adv, ddlMapping: ddl.key } }, dirty: true } : d)),
      ddl,
    ]);
    select({ kind: 'source', key: ddl.key });
    setTab('general');
  };
  createMappingRef.current = createMapping;

  const duplicate = (key: string) => {
    const src = drafts.find((d) => d.key === key);
    if (!src) return;
    const form = effective(src);
    add(form.driver, { ...form, name: `${form.name} (copy)` });
  };

  const reset = (key: string) => {
    const d = drafts.find((x) => x.key === key);
    if (!d?.saved) return;
    setDrafts((list) => list?.map((x) => (x.key === key ? { ...x, form: d.saved!, secrets: noSecrets(), dirty: false } : x)));
    setErrors((e) => {
      const { [key]: _drop, ...rest } = e;
      return rest;
    });
  };

  const back = () => {
    const prev = history.back[history.back.length - 1];
    if (!prev) return;
    setHistory((h) => ({ back: h.back.slice(0, -1), forward: sel ? [sel, ...h.forward] : h.forward }));
    setSelRaw(prev);
    if (prev.kind === 'driver') setLeftTab('drivers');
    else setLeftTab('sources');
  };
  const forward = () => {
    const next = history.forward[0];
    if (!next) return;
    setHistory((h) => ({ back: sel ? [...h.back, sel] : h.back, forward: h.forward.slice(1) }));
    setSelRaw(next);
    if (next.kind === 'driver') setLeftTab('drivers');
    else setLeftTab('sources');
  };

  const goToDriver = () => {
    if (!current) return;
    setLeftTab('drivers');
    select({ kind: 'driver', id: effective(current).driver });
  };

  // Problems: 저장하면 걸릴 칸 오류 + H2 jar 없음
  const problems: { key: string; name: string; message: string }[] = [];
  for (const d of drafts) {
    const form = effective(d);
    const others = drafts.filter((o) => o !== d).map((o) => effective(o));
    const r = buildConfig(form, others);
    if (!r.ok) for (const msg of Object.values(r.errors)) problems.push({ key: d.key, name: form.name || 'Untitled', message: msg! });
    if (form.driver === 'h2' && !h2Jar.trim()) problems.push({ key: d.key, name: form.name, message: 'The H2 jar (driver file) is not set.' });
  }

  const apply = (close: boolean) => {
    const changes: Change[] = drafts.filter((d) => d.dirty).map((d) => ({ key: d.key, id: d.id, form: effective(d), secrets: secretChanges(d) }));
    if (!changes.length && !removed.length && !h2JarDirty && !sshDirty && !templatesDirty) {
      if (close) send({ t: 'close', dirty: false });
      return;
    }
    setBusy(true);
    setErrors({});
    setApplyError(undefined);
    send({ t: 'apply', changes, removed, h2Jar, close, selectedKey: current?.key, ...(sshDirty ? { sshConfigs } : {}), ...(templatesDirty ? { templates } : {}) });
  };

  const groups: { title: string; list: Draft[] }[] = [
    { title: 'Global Data Sources', list: drafts.filter((d) => d.form.adv.kind !== 'ddl' && d.form.adv.scope !== 'project') },
    { title: 'Project Data Sources', list: drafts.filter((d) => d.form.adv.kind !== 'ddl' && d.form.adv.scope === 'project') },
    { title: 'DDL Data Sources', list: drafts.filter((d) => d.form.adv.kind === 'ddl') },
  ].filter((g) => g.list.length);

  const ctxDraft = ctxMenu && drafts.find((d) => d.key === ctxMenu.key);

  return (
    <div className="dialog" onClick={() => ctxMenu && setCtxMenu(undefined)}>
      <aside className="side">
        <div className="side-head" role="tablist">
          <button role="tab" aria-selected={leftTab === 'sources'} className={`side-tab${leftTab === 'sources' ? ' on' : ''}`} onClick={() => setLeftTab('sources')}>
            Data Sources
          </button>
          <button role="tab" aria-selected={leftTab === 'drivers'} className={`side-tab${leftTab === 'drivers' ? ' on' : ''}`} onClick={() => setLeftTab('drivers')}>
            Drivers
          </button>
        </div>

        {leftTab === 'sources' ? (
          <>
            <div className="toolbar">
              <div className="menu-anchor">
                <button className={`icon${menu ? ' active' : ''}`} title="Add" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
                  <Icon d="M8 2.5v11M2.5 8h11" />
                  <span className="drop-corner" aria-hidden="true" />
                </button>
                {menu && (
                  <>
                    <div className="menu-backdrop" onClick={() => setMenu(false)} />
                    <div className="menu" role="menu">
                      {DRIVERS.map((d) => (
                        <button key={d} role="menuitem" onClick={() => add(d)}>
                          <Logo driver={d} />
                          {DRIVER_LABELS[d]}
                        </button>
                      ))}
                      <div className="menu-sep" />
                      <button
                        role="menuitem"
                        onClick={() => {
                          const d = newDdlDraft('postgres');
                          setDrafts((list) => [...(list ?? []), d]);
                          select({ kind: 'source', key: d.key });
                          setMenu(false);
                        }}
                      >
                        <DdlIcon />
                        DDL Data Source
                      </button>
                    </div>
                  </>
                )}
              </div>
              <button className="icon" title="Remove" disabled={!current} onClick={() => current && removeDraft(current.key)}>
                <Icon d="M2.5 8h11" />
              </button>
              <button className="icon" title="Duplicate" disabled={!current} onClick={() => current && duplicate(current.key)}>
                <Icon d="M5.5 5.5h7v7h-7zM3.5 10.5v-7h7" />
              </button>
              <button className="icon" title="Go to Driver" disabled={!current} onClick={goToDriver}>
                <Icon d="M6 3.5l4.5 4.5L6 12.5" />
              </button>
              <span className="toolbar-gap" />
              <button className="icon" title="Back" disabled={!history.back.length} onClick={back}>
                <Icon d="M13 8H3.5M7.5 4L3.5 8l4 4" />
              </button>
              <button className="icon" title="Forward" disabled={!history.forward.length} onClick={forward}>
                <Icon d="M3 8h9.5M8.5 4l4 4-4 4" />
              </button>
            </div>
            <div className="list-scroll">
              {groups.map((g) => (
                <div key={g.title}>
                  <div className="group-title">{g.title}</div>
                  <ul className="list" role="listbox" aria-label={g.title}>
                    {g.list.map((d) => {
                      const form = effective(d);
                      const on = sel?.kind === 'source' && sel.key === d.key;
                      return (
                        <li
                          key={d.key}
                          role="option"
                          aria-selected={on}
                          title={form.comment || undefined}
                          className={`${on ? 'on' : ''}${errors[d.key] ? ' invalid' : ''}`}
                          onClick={() => select({ kind: 'source', key: d.key })}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            select({ kind: 'source', key: d.key });
                            setCtxMenu({ x: e.clientX, y: e.clientY, key: d.key });
                          }}
                        >
                          {form.adv.kind === 'ddl' ? <DdlIcon /> : <Logo driver={form.driver} />}
                          <span className="name">{form.name || 'Untitled'}</span>
                          {form.adv.color && <span className="color-mark" style={{ background: form.adv.color }} />}
                          {d.dirty && <span className="dot" title={d.id ? 'Modified' : 'Not saved yet'} />}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              {!drafts.length && <p className="note side-note">No data sources. Click + to add one.</p>}
              {templates.length > 0 && (
                <div>
                  <div className="group-title">Data Source Templates</div>
                  <ul className="list" role="listbox" aria-label="Data Source Templates">
                    {templates.map((t, i) => {
                      const on = sel?.kind === 'template' && sel.index === i;
                      return (
                        <li key={i} role="option" aria-selected={on} className={on ? 'on' : ''} onClick={() => select({ kind: 'template', index: i })}>
                          <Logo driver={t.form.driver} />
                          <span className="name">{t.name}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
            <button className={`problems${sel?.kind === 'problems' ? ' on' : ''}`} onClick={() => select({ kind: 'problems' })}>
              Problems
              {problems.length > 0 && <span className="badge">{problems.length}</span>}
            </button>
          </>
        ) : (
          <div className="list-scroll">
            <ul className="list" role="listbox" aria-label="Drivers">
              {DRIVERS.map((d) => {
                const on = sel?.kind === 'driver' && sel.id === d;
                return (
                  <li key={d} role="option" aria-selected={on} className={on ? 'on' : ''} onClick={() => select({ kind: 'driver', id: d })}>
                    <Logo driver={d} />
                    <span className="name">{DRIVER_LABELS[d]}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </aside>

      <main className="main">
        {current ? (
          <SourceEditor
            key={current.key}
            draft={current}
            errors={errors[current.key] ?? {}}
            test={tests[current.key]}
            tab={tab}
            setTab={setTab}
            h2Jar={h2Jar}
            setH2Jar={(v) => {
              setH2Jar(v);
              setH2JarDirty(true);
            }}
            update={(p) => update(current.key, p)}
            sshConfigs={sshConfigs}
            setSshConfig={(c) => {
              setSshConfigs((list) => list.map((x) => (x.id === c.id ? c : x)));
              setSshDirty(true);
            }}
            shareSsh={() => {
              const a = current.form.adv;
              const id = `ssh-${Date.now().toString(36)}`;
              const c: SharedSshConfig = {
                id,
                name: `${a.sshUser || 'user'}@${a.sshHost}:${a.sshPort || 22}`,
                host: a.sshHost,
                port: Number(a.sshPort) || 22,
                user: a.sshUser,
                auth: a.sshAuth,
                keyFile: a.sshKeyFile || undefined,
                parseConfig: a.sshParseConfig || undefined,
                keepAlive: Number(a.sshKeepAlive) || undefined,
                strictHostKey: a.sshStrict === 'ask' ? undefined : a.sshStrict,
              };
              setSshConfigs((list) => [...list, c]);
              setSshDirty(true);
              update(current.key, { form: { ...current.form, adv: { ...a, sshConfigId: id } } });
            }}
            copySources={drafts.filter((d) => d.key !== current.key && d.form.adv.kind !== 'ddl').map((d) => ({ key: d.key, name: effective(d).name || 'Untitled' }))}
            copyFrom={(key) => {
              const src = drafts.find((d) => d.key === key);
              if (!src) return;
              const s = src.form.adv;
              const a = current.form.adv;
              // DataGrip의 Copy from은 SSH 설정만 복사한다(SSL은 데이터 소스마다 다르다)
              const picked = Object.fromEntries(Object.entries(s).filter(([k]) => /^ssh/.test(k)));
              update(current.key, { form: { ...current.form, adv: { ...a, ...picked } } });
            }}
            ddlSources={drafts.filter((d) => d.form.adv.kind === 'ddl').map((d) => ({ key: d.key, name: effective(d).name || 'Untitled' }))}
            onCreateMapping={() => createMapping(current.key)}
            onOpen={(key) => select({ kind: 'source', key })}
            schemaTree={schemaTrees[current.key]}
            onTest={() => {
              setTests((t) => ({ ...t, [current.key]: { kind: 'busy' } }));
              send({ t: 'test', key: current.key, id: current.id, form: effective(current), secrets: secretChanges(current), h2Jar, sshConfigs });
            }}
            onListSchemas={() => {
              setSchemaTrees((t) => ({ ...t, [current.key]: { kind: 'busy' } }));
              send({ t: 'listSchemas', key: current.key, id: current.id, form: effective(current), secrets: secretChanges(current), h2Jar, sshConfigs });
            }}
          />
        ) : sel?.kind === 'driver' ? (
          <DriverPage
            info={driverInfo.find((i) => i.id === sel.id)}
            id={sel.id}
            h2Jar={h2Jar}
            setH2Jar={(v) => {
              setH2Jar(v);
              setH2JarDirty(true);
            }}
            usages={drafts.filter((d) => effective(d).driver === sel.id)}
            openSource={(key) => {
              setLeftTab('sources');
              select({ kind: 'source', key });
            }}
          />
        ) : sel?.kind === 'template' && templates[sel.index] ? (
          <div className="body">
            <div className="driver-head">
              <Logo driver={templates[sel.index].form.driver} size={28} />
              <h2 className="page-title">Data Source Template</h2>
            </div>
            <div className="grid">
              <label className="row-label" htmlFor="t-name">
                Name:
              </label>
              <div className="row-field">
                <input
                  id="t-name"
                  value={templates[sel.index].name}
                  onChange={(e) => {
                    const i = sel.index;
                    setTemplates((list) => list.map((t, j) => (j === i ? { ...t, name: e.target.value } : t)));
                    setTemplatesDirty(true);
                  }}
                />
              </div>
              <label className="row-label">Driver:</label>
              <div className="row-field">{DRIVER_LABELS[templates[sel.index].form.driver]}</div>
              <label className="row-label">Contains:</label>
              <div className="row-field">
                <span className="muted">General, Options, SSH/SSL, Schemas and Advanced settings — no user, password or other credentials.</span>
              </div>
            </div>
            <div className="name-line template-actions">
              <button
                className="link"
                onClick={() => {
                  const t = templates[sel.index];
                  add(t.form.driver, { ...t.form, name: '' });
                }}
              >
                Create Data Source
              </button>
              <button
                className="link"
                onClick={() => {
                  const i = sel.index;
                  setTemplates((list) => list.filter((_, j) => j !== i));
                  setTemplatesDirty(true);
                  select(undefined, false);
                }}
              >
                Remove Template
              </button>
            </div>
          </div>
        ) : sel?.kind === 'problems' ? (
          <div className="body">
            <h2 className="page-title">Problems</h2>
            {problems.length === 0 ? (
              <p className="note">No problems found.</p>
            ) : (
              <ul className="problem-list">
                {problems.map((p, i) => (
                  <li key={i}>
                    <button
                      className="link"
                      onClick={() => {
                        select({ kind: 'source', key: p.key });
                        setErrors((e) => ({ ...e, [p.key]: buildErrors(drafts, p.key) }));
                      }}
                    >
                      {p.name}
                    </button>
                    <span>{p.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="placeholder">{drafts.length ? 'Select a data source.' : 'No data sources. Click + to add one.'}</div>
        )}
      </main>

      <footer className="footer">
        <span className="footer-error" role="alert">
          {applyError}
        </span>
        <button className="secondary" onClick={() => send({ t: 'close', dirty })}>
          Cancel
        </button>
        <button className="secondary" disabled={!dirty || busy} onClick={() => apply(false)}>
          Apply
        </button>
        <button className="primary" disabled={busy} onClick={() => apply(true)}>
          OK
        </button>
      </footer>

      {ctxMenu && ctxDraft && (
        <div className="menu context" role="menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button role="menuitem" onClick={() => (duplicate(ctxDraft.key), setCtxMenu(undefined))}>
            Duplicate
          </button>
          <button role="menuitem" disabled={!ctxDraft.dirty || !ctxDraft.saved} onClick={() => (reset(ctxDraft.key), setCtxMenu(undefined))}>
            Reset Changes
          </button>
          {ctxDraft.form.adv.kind !== 'ddl' && (
            <button role="menuitem" onClick={() => (saveTemplate(ctxDraft.key), setCtxMenu(undefined))}>
              Save as Template
            </button>
          )}
          <div className="menu-sep" />
          <div className="menu-label">Change Driver</div>
          {DRIVERS.filter((d) => d !== ctxDraft.form.driver).map((d) => (
            <button
              key={d}
              role="menuitem"
              className="indent-item"
              onClick={() => {
                update(ctxDraft.key, { form: { ...ctxDraft.form, driver: d, port: '', file: '', ssl: d === 'postgres' || d === 'mysql' ? ctxDraft.form.ssl : 'disable' } });
                setCtxMenu(undefined);
              }}
            >
              <Logo driver={d} />
              {DRIVER_LABELS[d]}
            </button>
          ))}
          <div className="menu-sep" />
          {ctxDraft.form.adv.scope === 'project' ? (
            <button role="menuitem" onClick={() => (update(ctxDraft.key, { form: { ...ctxDraft.form, adv: { ...ctxDraft.form.adv, scope: 'global' } } }), setCtxMenu(undefined))}>
              Make Global
            </button>
          ) : (
            <button
              role="menuitem"
              disabled={!canUseProject}
              title={canUseProject ? undefined : 'Open a folder or workspace to keep project data sources.'}
              onClick={() => (update(ctxDraft.key, { form: { ...ctxDraft.form, adv: { ...ctxDraft.form.adv, scope: 'project' } } }), setCtxMenu(undefined))}
            >
              Move to Project
            </button>
          )}
          <div className="menu-sep" />
          <button role="menuitem" onClick={() => (removeDraft(ctxDraft.key), setCtxMenu(undefined))}>
            Remove
          </button>
        </div>
      )}
    </div>
  );
}

function buildErrors(drafts: Draft[], key: string): FormErrors {
  const d = drafts.find((x) => x.key === key)!;
  const r = buildConfig(effective(d), drafts.filter((o) => o !== d).map((o) => effective(o)));
  return r.ok ? {} : r.errors;
}

function SourceEditor(props: {
  draft: Draft;
  errors: FormErrors;
  test?: TestState;
  tab: Tab;
  setTab: (t: Tab) => void;
  h2Jar: string;
  setH2Jar: (v: string) => void;
  update: (p: Partial<Draft>) => void;
  sshConfigs: SharedSshConfig[];
  setSshConfig: (c: SharedSshConfig) => void;
  shareSsh: () => void;
  copySources: { key: string; name: string }[];
  copyFrom: (key: string) => void;
  ddlSources: { key: string; name: string }[];
  onCreateMapping: () => void;
  onOpen: (key: string) => void;
  schemaTree?: SchemaTreeState;
  onTest: () => void;
  onListSchemas: () => void;
}) {
  const { draft, errors, test, tab, setTab, update } = props;
  const form = effective(draft);
  if (form.adv.kind === 'ddl') return <DdlEditor draft={draft} errors={errors} update={update} />;
  const a = form.adv;
  const editor = {
    form,
    secrets: draft.secrets,
    has: draft.has,
    errors,
    h2Jar: props.h2Jar,
    setH2Jar: props.setH2Jar,
    setForm: (f: ConnectionForm) => update({ form: f }),
    setSecret: (field: SecretField, s: SecretDraft) => update({ secrets: { ...draft.secrets, [field]: s } }),
    pick: (field: PickField) => send({ t: 'pick', key: draft.key, field, driver: form.driver }),
    schemaTree: props.schemaTree,
    listSchemas: props.onListSchemas,
    sshConfigs: props.sshConfigs,
    setSshConfig: props.setSshConfig,
    shareSsh: props.shareSsh,
    copySources: props.copySources,
    copyFrom: props.copyFrom,
  };
  const errorTabs = new Set(Object.keys(errors).map(tabOf));

  return (
    <>
      <div className="head">
        <label className="row-label" htmlFor="f-name">
          Name:
        </label>
        <div className="row-field">
          <div className="name-line">
            <input id="f-name" value={form.name} placeholder="Untitled" onChange={(e) => update({ form: { ...draft.form, name: e.target.value }, nameTouched: true })} />
            <label className={`color-dot${a.color ? ' set' : ''}`} title="Data source color" style={a.color ? { background: a.color } : undefined}>
              <input type="color" value={a.color || '#4a90d9'} onChange={(e) => update({ form: { ...draft.form, adv: { ...a, color: e.target.value } } })} />
            </label>
            {a.color && (
              <button className="dots" title="Clear color" onClick={() => update({ form: { ...draft.form, adv: { ...a, color: '' } } })}>
                ×
              </button>
            )}
            {!a.ddlMapping && (
              <button className="link" onClick={props.onCreateMapping}>
                Create DDL Mapping
              </button>
            )}
          </div>
          {errors.name && <div className="error">{errors.name}</div>}
        </div>
        <label className="row-label" htmlFor="f-comment">
          Comment:
        </label>
        <div className="row-field">
          <input id="f-comment" value={form.comment} onChange={(e) => update({ form: { ...draft.form, comment: e.target.value } })} />
        </div>
        {a.ddlMapping && (
          <>
            <label className="row-label" htmlFor="f-ddl">
              DDL mapping:
            </label>
            <div className="row-field">
              <div className="name-line">
                <Select id="f-ddl" className="short" value={a.ddlMapping} onChange={(e) => update({ form: { ...draft.form, adv: { ...a, ddlMapping: e.target.value } } })}>
                  <option value="">None</option>
                  {props.ddlSources.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.name}
                    </option>
                  ))}
                </Select>
                <label className="pair-label" htmlFor="f-scope">
                  Scope:
                </label>
                <input id="f-scope" placeholder="all schemas" value={a.ddlScope} onChange={(e) => update({ form: { ...draft.form, adv: { ...a, ddlScope: e.target.value } } })} />
                <button className="link" onClick={() => props.onOpen(a.ddlMapping)}>
                  Open
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
            {errorTabs.has(t.id) && t.id !== 'general' && <span className="tab-error" />}
          </button>
        ))}
      </div>

      <div className="body">
        {tab === 'general' && <GeneralTab {...editor} />}
        {tab === 'options' && <OptionsTab {...editor} />}
        {tab === 'sshssl' && <SshSslTab {...editor} />}
        {tab === 'schemas' && <SchemasTab {...editor} />}
        {tab === 'advanced' && <AdvancedTab {...editor} />}
      </div>

      <div className="test-bar">
        <button className="link" disabled={test?.kind === 'busy'} onClick={props.onTest}>
          Test Connection
        </button>
        {test && (
          <span className={`test ${test.kind}`} role="status" title={test.kind === 'busy' ? undefined : [test.text, test.detail].filter(Boolean).join('\n')}>
            {test.kind === 'busy' ? 'Connecting…' : test.kind === 'ok' ? (test.detail ?? test.text) : test.text}
          </span>
        )}
      </div>
    </>
  );
}

/** DDL data source: SQL 파일 폴더와 방언 */
function DdlEditor(props: { draft: Draft; errors: FormErrors; update: (p: Partial<Draft>) => void }) {
  const { draft, errors, update } = props;
  const form = effective(draft);
  const a = form.adv;
  return (
    <>
      <div className="head">
        <label className="row-label" htmlFor="f-name">
          Name:
        </label>
        <div className="row-field">
          <input id="f-name" value={form.name} placeholder="Untitled" onChange={(e) => update({ form: { ...draft.form, name: e.target.value }, nameTouched: true })} />
          {errors.name && <div className="error">{errors.name}</div>}
        </div>
        <label className="row-label" htmlFor="f-comment">
          Comment:
        </label>
        <div className="row-field">
          <input id="f-comment" value={form.comment} onChange={(e) => update({ form: { ...draft.form, comment: e.target.value } })} />
        </div>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected className="on">
          General
        </button>
      </div>
      <div className="body">
        <div className="grid">
          <label className="row-label" htmlFor="f-ddlfolder">
            DDL files:
          </label>
          <div className="row-field">
            <div className="with-button">
              <input
                id="f-ddlfolder"
                className={errors.ddlFolder ? 'bad' : ''}
                value={a.ddlFolder}
                onChange={(e) => update({ form: { ...draft.form, adv: { ...a, ddlFolder: e.target.value } } })}
              />
              <button className="dots" title="Choose a folder" onClick={() => send({ t: 'pick', key: draft.key, field: 'ddlFolder', driver: form.driver })}>
                …
              </button>
            </div>
            {errors.ddlFolder ? <div className="error">{errors.ddlFolder}</div> : <div className="hint">A folder of .sql files. Sub-folders are schemas.</div>}
          </div>
          <label className="row-label" htmlFor="f-dialect">
            SQL dialect:
          </label>
          <div className="row-field">
            <Select id="f-dialect" className="short" value={form.driver} onChange={(e) => update({ form: { ...draft.form, driver: e.target.value as DriverId } })}>
              {DRIVERS.map((d) => (
                <option key={d} value={d}>
                  {DRIVER_LABELS[d]}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <p className="note">
          Map a data source to this DDL data source with Create DDL Mapping. Then, from the explorer: Dump / Update writes the database objects into these files,
          and Apply opens a migration script for the database.
        </p>
      </div>
    </>
  );
}

const DdlIcon = () => (
  <svg className="logo" width="18" height="18" viewBox="0 0 24 24" aria-label="DDL">
    <rect width="24" height="24" rx="5" fill="#6b5b95" />
    <text x="12" y="16" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="#fff" fontFamily="sans-serif">
      DDL
    </text>
  </svg>
);

/** Drivers 탭: 드라이버 하나 */
function DriverPage(props: {
  id: DriverId;
  info?: DriverInfo;
  h2Jar: string;
  setH2Jar: (v: string) => void;
  usages: Draft[];
  openSource: (key: string) => void;
}) {
  const { id, info } = props;
  return (
    <div className="body">
      <div className="driver-head">
        <Logo driver={id} size={28} />
        <h2 className="page-title">{DRIVER_LABELS[id]}</h2>
      </div>
      <div className="grid">
        <label className="row-label">Driver files:</label>
        <div className="row-field">
          <div>
            {info?.module} <span className="muted">ver. {info?.version}</span>
          </div>
          <div className="hint">Bundled with BindB.</div>
        </div>
        {id === 'h2' && (
          <>
            <label className="row-label">Class:</label>
            <div className="row-field">
              <code className="template">org.h2.tools.Server</code>
              <div className="hint">Started with -pg so BindB can talk to H2 over the PostgreSQL protocol.</div>
            </div>
            <label className="row-label">Download:</label>
            <div className="row-field">
              <H2Download />
            </div>
            <label className="row-label" htmlFor="d-jar">
              H2 jar:
            </label>
            <div className="row-field">
              <div className="with-button">
                <input id="d-jar" value={props.h2Jar} onChange={(e) => props.setH2Jar(e.target.value)} placeholder="h2-*.jar" />
                <button className="dots" title="Choose the H2 jar" onClick={() => send({ t: 'pick', key: '', field: 'h2Jar', driver: 'h2' })}>
                  …
                </button>
              </div>
              <div className="hint">BindB does not ship H2. Used to start the H2 server for Embedded data sources.</div>
            </div>
          </>
        )}
        <label className="row-label">URL templates:</label>
        <div className="row-field">
          {info?.urlTemplates.map((u) => (
            <code key={u} className="template">
              {u}
            </code>
          ))}
        </div>
        <label className="row-label">Used by:</label>
        <div className="row-field">
          {props.usages.length === 0 ? (
            <span className="muted">No data sources.</span>
          ) : (
            props.usages.map((d) => (
              <button key={d.key} className="link usage" onClick={() => props.openSource(d.key)}>
                {effective(d).name || 'Untitled'}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** Drivers · H2: Maven Central에서 판을 골라 내려받는다(SHA-1 확인) */
function H2Download() {
  const [versions, setVersions] = useState<string[]>();
  const [latest, setLatest] = useState<string>();
  const [version, setVersion] = useState('');
  const [status, setStatus] = useState<{ busy?: boolean; text?: string; error?: boolean }>({});
  useEffect(() => {
    const on = (e: Event) => {
      const m = (e as CustomEvent).detail as PanelHostToWebview;
      if (m.t === 'h2Versions') {
        if (m.error) setStatus({ text: m.error, error: true });
        else {
          setVersions(m.versions);
          setLatest(m.latest);
          setVersion(m.latest ?? '');
          setStatus({});
        }
      } else if (m.t === 'h2Downloaded') {
        setStatus(m.error ? { text: m.error, error: true } : { text: `Downloaded and verified: ${m.path}` });
      }
    };
    window.addEventListener('bindb-h2', on);
    setStatus({ busy: true, text: 'Loading versions from Maven Central…' });
    send({ t: 'h2Versions' });
    return () => window.removeEventListener('bindb-h2', on);
  }, []);
  const download = (v: string) => {
    setStatus({ busy: true, text: `Downloading h2-${v}.jar…` });
    send({ t: 'downloadH2', version: v });
  };
  return (
    <div className="h2-download">
      {latest && (
        <button className="link" disabled={status.busy} onClick={() => download(latest)}>
          Download ver. {latest}
        </button>
      )}
      {versions && (
        <div className="name-line">
          <Select className="short" aria-label="H2 version" value={version} onChange={(e) => setVersion(e.target.value)}>
            {versions.map((v) => (
              <option key={v} value={v}>
                ver. {v}
              </option>
            ))}
          </Select>
          <button className="text-button" disabled={status.busy || !version} onClick={() => download(version)}>
            Download
          </button>
        </div>
      )}
      {status.text && <div className={status.error ? 'error' : 'hint'}>{status.text}</div>}
    </div>
  );
}

const Icon = (props: { d: string }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d={props.d} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

createRoot(document.getElementById('root')!).render(<App />);
