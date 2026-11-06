import '@glideapps/glide-data-grid/dist/index.css';
import './grid.css';
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type GridCell,
  type GridColumn as GlideColumn,
  type GridSelection,
  type Item,
  type Rectangle,
  type Theme,
} from '@glideapps/glide-data-grid';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { emptyChanges, hasChanges, setCell, type EditValue, type PendingChanges } from '../../src/core/editing';
import { orderByOf, toggleSort, type SortKey } from '../../src/core/gridQuery';
import { EXPORT_FORMATS, formatRows, type ExportFormat } from '../../src/shared/exportFormats';
import type { CellValue, Editability, GridColumn, HostToWebview, WebviewToHost, WireChanges } from '../../src/shared/protocol';

/*
 * 결과 그리드(DataGrip Data editor를 따른다).
 *  - WHERE / ORDER BY 줄, 헤더 클릭 정렬(Shift = 여러 열)
 *  - 내보내기(결과 전체 → 파일), 형식 복사(선택 영역)
 *  - 테이블 데이터면 편집: 셀 편집 · 행 추가 · 행 삭제 → Preview / Submit / Revert
 */

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void };
const vscode = acquireVsCodeApi();
const send = (msg: WebviewToHost) => vscode.postMessage(msg);

/** 끝에서 이만큼 남으면 다음 페이지를 요청한다 */
const PREFETCH_MARGIN = 100;

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; qid: string; sql: string; connection: string }
  | { kind: 'rows'; qid: string; sql: string; connection: string; done: boolean; elapsedMs?: number }
  | { kind: 'update'; qid: string; affectedRows: number | null; elapsedMs: number }
  | { kind: 'error'; qid: string; message: string };

interface Meta {
  table?: string;
  quotedTable?: string;
  dialect: 'postgres' | 'mysql' | 'sqlite' | 'h2';
  filterable: true | string;
  exportable: true | string;
  edit: Editability;
}

type Banner = { text: string; error?: boolean } | undefined;

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}

/** VS Code 테마 색을 그리드 테마로. 테마가 바뀌면 body 클래스가 바뀐다. */
function vscodeTheme(): Partial<Theme> {
  const fg = cssVar('--vscode-editor-foreground', '#ccc');
  return {
    accentColor: cssVar('--vscode-focusBorder', '#007fd4'),
    accentLight: cssVar('--vscode-editor-selectionBackground', '#264f78'),
    textDark: fg,
    textMedium: cssVar('--vscode-descriptionForeground', fg),
    textLight: cssVar('--vscode-disabledForeground', '#888'),
    textHeader: fg,
    textHeaderSelected: cssVar('--vscode-list-activeSelectionForeground', '#fff'),
    bgCell: cssVar('--vscode-editor-background', '#1e1e1e'),
    bgCellMedium: cssVar('--vscode-editorWidget-background', '#252526'),
    bgHeader: cssVar('--vscode-sideBar-background', '#252526'),
    bgHeaderHasFocus: cssVar('--vscode-list-hoverBackground', '#2a2d2e'),
    bgHeaderHovered: cssVar('--vscode-list-hoverBackground', '#2a2d2e'),
    borderColor: cssVar('--vscode-editorGroup-border', '#444'),
    horizontalBorderColor: cssVar('--vscode-editorGroup-border', '#444'),
    fontFamily: cssVar('--vscode-editor-font-family', 'monospace'),
    baseFontStyle: `${cssVar('--vscode-editor-font-size', '13px')}`,
    headerFontStyle: `600 ${cssVar('--vscode-editor-font-size', '13px')}`,
    editorFontSize: cssVar('--vscode-editor-font-size', '13px'),
  };
}

function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const obs = new MutationObserver(() => setV((x) => x + 1));
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return v;
}

/** 편집 상태 색(VS Code 진단 · git 장식 색) */
function editColors() {
  return {
    changed: cssVar('--vscode-diffEditor-insertedTextBackground', 'rgba(155,185,85,0.2)'),
    deleted: cssVar('--vscode-diffEditor-removedTextBackground', 'rgba(255,0,0,0.2)'),
    inserted: cssVar('--vscode-diffEditor-insertedLineBackground', 'rgba(155,185,85,0.15)'),
  };
}

const display = (v: CellValue | undefined): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return `<binary ${v.$bin} bytes>`;
  return String(v);
};

function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [columns, setColumns] = useState<GridColumn[]>([]);
  const [meta, setMeta] = useState<Meta>({ dialect: 'postgres', filterable: 'No result yet.', exportable: 'No result yet.', edit: { editable: false, reason: '' } });
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [rowCount, setRowCount] = useState(0);
  const [where, setWhere] = useState('');
  const [orderBy, setOrderBy] = useState('');
  const [applied, setApplied] = useState({ where: '', orderBy: '' });
  const [sort, setSort] = useState<SortKey[]>([]);
  const [changes, setChanges] = useState<PendingChanges>(emptyChanges);
  const [version, setVersion] = useState(0);
  const [selection, setSelection] = useState<GridSelection>({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
  const [banner, setBanner] = useState<Banner>();
  const [preview, setPreview] = useState<{ statements?: string[]; error?: string }>();
  const [confirm, setConfirm] = useState<{ text: string; go: () => void }>();
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'export' | 'cell'; cell?: Item }>();
  const [busy, setBusy] = useState(false);
  const rows = useRef<CellValue[][]>([]);
  /** 불러온 행 수(콜백이 최신 값을 읽게) */
  const loadedRef = useRef(0);
  const waiting = useRef(false);
  const qidRef = useRef<string>();
  const themeVersion = useThemeVersion();
  const theme = useMemo(vscodeTheme, [themeVersion]);
  const colors = useMemo(editColors, [themeVersion]);
  const nullColor = theme.textLight ?? '#888';
  const edit = meta.edit;
  const editable = edit.editable;
  const loaded = rowCount;
  loadedRef.current = rowCount;
  const totalRows = loaded + changes.inserts.length;
  const dirty = hasChanges(changes);
  const insertsRef = useRef(0);
  insertsRef.current = changes.inserts.length;

  useEffect(() => {
    const onMessage = (e: MessageEvent<HostToWebview>) => {
      const m = e.data;
      if (m.t === 'notice') {
        setBanner({ text: m.message, error: m.error });
        return;
      }
      if (m.t === 'running') {
        qidRef.current = m.qid;
        setPhase({ kind: 'running', qid: m.qid, sql: m.sql, connection: m.connection });
        return;
      }
      if (m.qid !== qidRef.current) return;
      switch (m.t) {
        case 'result/start':
          rows.current = [];
          waiting.current = true;
          setRowCount(0);
          setColumns(m.columns);
          setWidths({});
          setMeta({ table: m.table, quotedTable: m.quotedTable, dialect: m.dialect, filterable: m.filterable, exportable: m.exportable, edit: m.edit });
          setWhere(m.filter.where);
          setOrderBy(m.filter.orderBy);
          // 다른 결과의 정렬 표시가 남지 않게: 정렬은 ORDER BY 칸에서 온 것만 유지한다
          setSort((prev) => (m.filter.orderBy && m.filter.orderBy === orderByOf(prev) ? prev : []));
          setApplied(m.filter);
          setChanges(emptyChanges());
          setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
          setPreview(undefined);
          setBusy(false);
          setPhase({ kind: 'rows', qid: m.qid, sql: m.sql, connection: m.connection, done: false });
          break;
        case 'result/rows':
          rows.current.push(...m.rows);
          waiting.current = false;
          setRowCount(rows.current.length);
          setPhase((p) => (p.kind === 'rows' ? { ...p, done: m.done } : p));
          break;
        case 'result/stats':
          setPhase((p) => (p.kind === 'rows' ? { ...p, elapsedMs: m.elapsedMs } : p));
          break;
        case 'result/update':
          setColumns([]);
          rows.current = [];
          setRowCount(0);
          setPhase({ kind: 'update', qid: m.qid, affectedRows: m.affectedRows, elapsedMs: m.elapsedMs });
          break;
        case 'result/error':
          waiting.current = false;
          setBusy(false);
          // 결과는 지우되 WHERE / ORDER BY 줄은 남겨 바로 고칠 수 있게 한다
          setPhase({ kind: 'error', qid: m.qid, message: m.message });
          break;
        case 'edit/preview':
          setPreview({ statements: m.statements, error: m.error });
          break;
        case 'edit/result':
          setBusy(false);
          setBanner({ text: m.message, error: !m.ok });
          break;
      }
    };
    window.addEventListener('message', onMessage);
    send({ t: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /** 저장하지 않은 변경이 있으면 먼저 묻는다(웹뷰는 confirm 창을 띄울 수 없어 그리드 안에서 묻는다) */
  const guard = (text: string, go: () => void) => {
    if (dirty) setConfirm({ text, go });
    else go();
  };

  const applyFilter = (w = where, o = orderBy) => {
    if (!qidRef.current || meta.filterable !== true) return;
    guard('Discard unsaved changes and re-run?', () => {
      setBanner(undefined);
      send({ t: 'filter', qid: qidRef.current!, where: w, orderBy: o });
    });
  };

  const gridColumns = useMemo<GlideColumn[]>(
    () =>
      columns.map((c, i) => {
        const k = sort.find((s) => s.column === i);
        const arrow = k ? (k.desc ? ' ▼' : ' ▲') + (sort.length > 1 ? String(sort.indexOf(k) + 1) : '') : '';
        return { id: `${i}`, title: c.name + arrow, width: widths[i] ?? Math.min(320, Math.max(80, c.name.length * 9 + 40)) };
      }),
    [columns, widths, sort],
  );

  const colEditable = (c: number) => editable && edit.columns[c];

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const isNew = row >= loaded;
      const insert = isNew ? changes.inserts[row - loaded] : undefined;
      const pending = isNew ? insert?.get(col) : changes.updates.get(row)?.get(col);
      const original = isNew ? undefined : rows.current[row]?.[col];
      if (!isNew && original === undefined) return { kind: GridCellKind.Loading, allowOverlay: false };
      const deleted = !isNew && changes.deletes.has(row);
      const value: EditValue | CellValue | undefined = pending !== undefined ? pending : isNew ? { default: true } : original;
      const canEdit = !deleted && colEditable(col) && (isNew || typeof original !== 'object' || original === null);
      const isDefault = typeof value === 'object' && value !== null && 'default' in value;
      const isNull = value === null || value === undefined;
      const text = isDefault ? '<default>' : isNull ? 'NULL' : display(value as CellValue);
      const bg = deleted ? colors.deleted : pending !== undefined ? colors.changed : isNew ? colors.inserted : undefined;
      return {
        kind: GridCellKind.Text,
        data: isDefault || isNull ? '' : display(value as CellValue),
        displayData: text.length > 500 ? `${text.slice(0, 500)}…` : text,
        allowOverlay: canEdit || (!isNull && !isDefault),
        readonly: !canEdit,
        contentAlign: typeof value === 'number' ? 'right' : undefined,
        themeOverride: {
          ...(isNull || isDefault || (typeof value === 'object' && value !== null) ? { textDark: nullColor } : {}),
          ...(bg ? { bgCell: bg } : {}),
        },
      };
    },
    [nullColor, loaded, changes, version, editable, colors],
  );

  /** 셀 편집 여러 개를 한 번에(붙여넣기 포함). 항상 최신 상태 위에 쌓는다 */
  const applyEdits = useCallback(
    (edits: { location: Item; value: { data?: unknown } }[]) => {
      setChanges((prev) => {
        const next = cloneChanges(prev);
        for (const { location: [col, row], value: cell } of edits) {
          if (!colEditable(col)) continue;
          const text = String(cell.data ?? '');
          if (row >= loadedRef.current) {
            const ins = next.inserts[row - loadedRef.current];
            if (ins) ins.set(col, text);
            continue;
          }
          const original = rows.current[row]?.[col];
          if (original === undefined || (typeof original === 'object' && original !== null)) continue;
          // NULL 셀을 열었다가 그대로 닫으면 NULL을 유지한다(빈 문자열은 메뉴의 Set Empty String으로)
          if (original === null && text === '' && !next.updates.get(row)?.has(col)) continue;
          setCell(next, row, col, text, original);
        }
        return next;
      });
      setVersion((v) => v + 1);
    },
    [editable, edit],
  );
  const onCellEdited = useCallback(([col, row]: Item, cell: { data?: unknown }) => applyEdits([{ location: [col, row], value: cell }]), [applyEdits]);

  const done = phase.kind === 'rows' && phase.done;
  const onVisibleRegionChanged = useCallback(
    (r: Rectangle) => {
      if (done || waiting.current || !qidRef.current) return;
      // 저장하지 않은 새 행이 있으면 더 불러오지 않는다 — 불러오면 새 행의 위치가 밀려 다른 행을 가리키게 된다
      if (insertsRef.current > 0) return;
      if (r.y + r.height >= rows.current.length - PREFETCH_MARGIN) {
        waiting.current = true;
        send({ t: 'fetch', qid: qidRef.current });
      }
    },
    [done],
  );

  const selectedRows = (): number[] => {
    const set = new Set<number>(selection.rows.toArray());
    if (selection.current) for (let r = selection.current.range.y; r < selection.current.range.y + selection.current.range.height; r++) set.add(r);
    return [...set].sort((a, b) => a - b);
  };

  const deleteRows = (list = selectedRows()) => {
    if (!list.length) return;
    const next = cloneChanges(changes);
    const removeInserts: number[] = [];
    for (const r of list) {
      if (r >= loaded) removeInserts.push(r - loaded);
      else if (next.deletes.has(r)) next.deletes.delete(r);
      else next.deletes.add(r);
    }
    // 새 행을 지우면 그냥 없앤다(문장을 만들지 않는다)
    next.inserts = next.inserts.filter((_, i) => !removeInserts.includes(i));
    setChanges(next);
    setVersion((v) => v + 1);
  };

  const setCellValue = (cell: Item, value: EditValue | 'revert') => {
    const [col, row] = cell;
    const next = cloneChanges(changes);
    if (row >= loaded) {
      const ins = next.inserts[row - loaded];
      if (value === 'revert' || (typeof value === 'object' && value !== null)) ins.delete(col);
      else ins.set(col, value);
    } else if (value === 'revert') {
      const m = next.updates.get(row);
      m?.delete(col);
      if (m && !m.size) next.updates.delete(row);
    } else setCell(next, row, col, value, rows.current[row][col] as never);
    setChanges(next);
    setVersion((v) => v + 1);
  };

  const wire = (): WireChanges => ({
    updates: [...changes.updates].map(([row, cells]) => ({ row, original: rows.current[row], cells: [...cells] })),
    deletes: [...changes.deletes].map((row) => ({ row, original: rows.current[row] })),
    inserts: changes.inserts.map((m) => [...m]),
  });

  /** 선택 영역(불러온 행 안)을 형식대로 */
  const copyAs = (format: ExportFormat) => {
    const r = selection.current?.range;
    const cols = r ? Array.from({ length: r.width }, (_, i) => r.x + i) : columns.map((_, i) => i);
    const rowList = r ? Array.from({ length: r.height }, (_, i) => r.y + i).filter((x) => x < loaded) : selectedRows().filter((x) => x < loaded);
    const data = rowList.map((row) => cols.map((c) => rows.current[row][c] ?? null));
    const text = formatRows(format, cols.map((c) => columns[c].name), data, { table: meta.quotedTable, dialect: meta.dialect });
    void navigator.clipboard.writeText(text).then(
      () => setBanner({ text: `Copied ${data.length} row(s) as ${EXPORT_FORMATS.find((f) => f.id === format)!.label}.` }),
      () => setBanner({ text: 'Copy failed — the clipboard is not available.', error: true }),
    );
    setMenu(undefined);
  };

  const sortBy = (col: number, additive: boolean) => {
    if (meta.filterable !== true) {
      setBanner({ text: meta.filterable, error: true });
      return;
    }
    const keys = toggleSort(sort, col, additive);
    const o = orderByOf(keys);
    guard('Discard unsaved changes and re-run?', () => {
      setSort(keys);
      setOrderBy(o);
      setBanner(undefined);
      send({ t: 'filter', qid: qidRef.current!, where, orderBy: o });
    });
  };

  const filterReason = meta.filterable === true ? undefined : meta.filterable;
  const showGrid = columns.length > 0 && (phase.kind === 'rows' || phase.kind === 'running');
  /** 필터 오류 뒤에도 줄은 보인다(지난 결과의 열 기준) */
  const showBar = columns.length > 0 && phase.kind !== 'idle' && phase.kind !== 'update';

  return (
    <div className="app" onClick={() => menu && setMenu(undefined)}>
      <Toolbar phase={phase} rowCount={rowCount} />
      {showBar && (
        <div className="actions-bar">
          <div className="filter">
            <label>
              WHERE
              <input
                aria-label="WHERE"
                value={where}
                disabled={!!filterReason}
                title={filterReason}
                placeholder={filterReason ? '' : 'e.g. price > 10'}
                spellCheck={false}
                onChange={(e) => setWhere(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyFilter();
                  if (e.key === 'Escape') setWhere(applied.where);
                }}
              />
            </label>
            <label>
              ORDER BY
              <input
                aria-label="ORDER BY"
                value={orderBy}
                disabled={!!filterReason}
                title={filterReason}
                placeholder={filterReason ? '' : 'e.g. 2 DESC'}
                spellCheck={false}
                onChange={(e) => setOrderBy(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setSort([]);
                    applyFilter();
                  }
                  if (e.key === 'Escape') setOrderBy(applied.orderBy);
                }}
              />
            </label>
          </div>
          <div className="buttons">
            <button title="Re-run" onClick={() => guard('Discard unsaved changes and re-run?', () => qidRef.current && send({ t: 'refresh', qid: qidRef.current }))}>
              ⟳
            </button>
            <button
              title={meta.exportable === true ? 'Export all rows to a file' : meta.exportable}
              disabled={meta.exportable !== true}
              onClick={(e) => {
                e.stopPropagation();
                setMenu({ x: e.clientX, y: e.clientY, kind: 'export' });
              }}
            >
              Export ▾
            </button>
            {editable ? (
              <>
                <span className="sep" />
                <button
                  title="Add row"
                  onClick={() => {
                    setChanges({ ...cloneChanges(changes), inserts: [...changes.inserts.map((m) => new Map(m)), new Map()] });
                    setVersion((v) => v + 1);
                  }}
                >
                  + Row
                </button>
                <button title="Delete selected rows (again to undo)" onClick={() => deleteRows()}>
                  − Row
                </button>
                <button disabled={!dirty || busy} onClick={() => (setChanges(emptyChanges()), setVersion((v) => v + 1))}>
                  Revert
                </button>
                <button disabled={!dirty} onClick={() => qidRef.current && send({ t: 'edit/preview', qid: qidRef.current, changes: wire() })}>
                  Preview
                </button>
                <button
                  className="primary"
                  disabled={!dirty || busy}
                  onClick={() => {
                    setBusy(true);
                    setBanner(undefined);
                    send({ t: 'edit/submit', qid: qidRef.current!, changes: wire() });
                  }}
                >
                  Submit
                </button>
              </>
            ) : (
              <span className="readonly" title={edit.reason}>
                Read-only
              </span>
            )}
          </div>
        </div>
      )}
      {banner && (
        <div className={`banner${banner.error ? ' error' : ''}`} role="status">
          <span>{banner.text}</span>
          <button onClick={() => setBanner(undefined)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {confirm && (
        <div className="banner warn" role="alertdialog">
          <span>{confirm.text}</span>
          <button
            onClick={() => {
              const go = confirm.go;
              setConfirm(undefined);
              setChanges(emptyChanges());
              go();
            }}
          >
            Discard
          </button>
          <button onClick={() => setConfirm(undefined)}>Cancel</button>
        </div>
      )}
      {phase.kind === 'error' && <pre className="error">{phase.message}</pre>}
      {phase.kind === 'update' && (
        <div className="message">{phase.affectedRows === null ? 'Statement executed.' : `${phase.affectedRows} row(s) affected.`}</div>
      )}
      {phase.kind === 'idle' && <div className="message muted">Run a statement with ⌘/Ctrl+Enter.</div>}
      {showGrid && (
        <div className="grid">
          <DataEditor
            columns={gridColumns}
            rows={totalRows}
            getCellContent={getCellContent}
            getCellsForSelection
            onCellEdited={onCellEdited}
            onCellsEdited={(edits) => {
              applyEdits(edits.map((e) => ({ location: e.location, value: e.value as { data?: unknown } })));
              return true;
            }}
            onVisibleRegionChanged={onVisibleRegionChanged}
            onColumnResize={(_, w, i) => setWidths((prev) => ({ ...prev, [i]: w }))}
            onHeaderClicked={(col, e) => sortBy(col, e.shiftKey)}
            onCellContextMenu={(cell, e) => {
              e.preventDefault();
              setMenu({ x: e.bounds.x + e.localEventX, y: e.bounds.y + e.localEventY, kind: 'cell', cell });
            }}
            gridSelection={selection}
            onGridSelectionChange={setSelection}
            rowMarkers="clickable-number"
            smoothScrollX
            smoothScrollY
            theme={theme}
            width="100%"
            height="100%"
          />
        </div>
      )}
      {menu && (
        <div className="menu" role="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.kind === 'export' ? (
            EXPORT_FORMATS.map((f) => (
              <button
                key={f.id}
                role="menuitem"
                onClick={() => {
                  setMenu(undefined);
                  if (qidRef.current) send({ t: 'export', qid: qidRef.current, format: f.id });
                }}
              >
                {f.label}…
              </button>
            ))
          ) : (
            <>
              {menu.cell && colEditable(menu.cell[0]) && (
                <>
                  <button role="menuitem" onClick={() => (setCellValue(menu.cell!, null), setMenu(undefined))}>
                    Set NULL
                  </button>
                  <button role="menuitem" onClick={() => (setCellValue(menu.cell!, ''), setMenu(undefined))}>
                    Set Empty String
                  </button>
                  {menu.cell[1] >= loaded && (
                    <button role="menuitem" onClick={() => (setCellValue(menu.cell!, { default: true }), setMenu(undefined))}>
                      Set DEFAULT
                    </button>
                  )}
                  <button role="menuitem" onClick={() => (setCellValue(menu.cell!, 'revert'), setMenu(undefined))}>
                    Revert Cell
                  </button>
                  <button role="menuitem" onClick={() => (deleteRows(selectedRows().length ? selectedRows() : [menu.cell![1]]), setMenu(undefined))}>
                    Delete Row(s)
                  </button>
                  <div className="menu-sep" />
                </>
              )}
              <div className="menu-label">Copy as</div>
              {EXPORT_FORMATS.map((f) => (
                <button key={f.id} role="menuitem" className="indent" onClick={() => copyAs(f.id)}>
                  {f.label}
                </button>
              ))}
            </>
          )}
        </div>
      )}
      {preview && (
        <div className="overlay" onClick={() => setPreview(undefined)}>
          <div className="dialog" role="dialog" aria-label="Pending changes" onClick={(e) => e.stopPropagation()}>
            <h3>Pending changes</h3>
            {preview.error ? <p className="error-text">{preview.error}</p> : <pre className="sql">{preview.statements?.join(';\n\n')};</pre>}
            <div className="dialog-buttons">
              <button onClick={() => setPreview(undefined)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function cloneChanges(c: PendingChanges): PendingChanges {
  return {
    updates: new Map([...c.updates].map(([r, m]) => [r, new Map(m)])),
    deletes: new Set(c.deletes),
    inserts: c.inserts.map((m) => new Map(m)),
  };
}

function Toolbar({ phase, rowCount }: { phase: Phase; rowCount: number }) {
  if (phase.kind === 'idle') return null;
  const running = phase.kind === 'running';
  let status = '';
  if (phase.kind === 'running') status = 'Running…';
  else if (phase.kind === 'rows') status = `${rowCount}${phase.done ? '' : '+'} rows${phase.elapsedMs !== undefined ? ` · ${phase.elapsedMs} ms` : ''}`;
  else if (phase.kind === 'update') status = `${phase.elapsedMs} ms`;
  else status = 'Failed';
  const label = 'connection' in phase ? phase.connection : '';
  const sql = 'sql' in phase ? phase.sql : '';
  return (
    <div className="toolbar">
      {label && <span className="conn">{label}</span>}
      <span className="sql" title={sql}>
        {sql.replace(/\s+/g, ' ')}
      </span>
      <span className="status">{status}</span>
      {running && (
        <button className="cancel" onClick={() => send({ t: 'cancel', qid: phase.qid })}>
          Cancel
        </button>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
