import '@glideapps/glide-data-grid/dist/index.css';
import './grid.css';
import {
  DataEditor,
  GridCellKind,
  type GridCell,
  type GridColumn as GlideColumn,
  type Item,
  type Rectangle,
  type Theme,
} from '@glideapps/glide-data-grid';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CellValue, GridColumn, HostToWebview, WebviewToHost } from '../../src/shared/protocol';

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

function toGridCell(v: CellValue | undefined, nullColor: string): GridCell {
  if (v === undefined) return { kind: GridCellKind.Loading, allowOverlay: false };
  if (v === null) {
    return { kind: GridCellKind.Text, data: '', displayData: 'NULL', allowOverlay: false, readonly: true, themeOverride: { textDark: nullColor } };
  }
  if (typeof v === 'number') {
    return { kind: GridCellKind.Number, data: v, displayData: String(v), allowOverlay: true, readonly: true, contentAlign: 'right' };
  }
  if (typeof v === 'boolean') {
    return { kind: GridCellKind.Text, data: String(v), displayData: String(v), allowOverlay: false, readonly: true };
  }
  if (typeof v === 'object') {
    const text = `<binary ${v.$bin} bytes>`;
    return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: false, readonly: true, themeOverride: { textDark: nullColor } };
  }
  return { kind: GridCellKind.Text, data: v, displayData: v.length > 500 ? `${v.slice(0, 500)}…` : v, allowOverlay: true, readonly: true };
}

function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [columns, setColumns] = useState<GridColumn[]>([]);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [rowCount, setRowCount] = useState(0);
  const rows = useRef<CellValue[][]>([]);
  const waiting = useRef(false);
  const qidRef = useRef<string>();
  const themeVersion = useThemeVersion();
  const theme = useMemo(vscodeTheme, [themeVersion]);
  const nullColor = theme.textLight ?? '#888';

  useEffect(() => {
    const onMessage = (e: MessageEvent<HostToWebview>) => {
      const m = e.data;
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
          setPhase({ kind: 'error', qid: m.qid, message: m.message });
          break;
      }
    };
    window.addEventListener('message', onMessage);
    send({ t: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const gridColumns = useMemo<GlideColumn[]>(
    () =>
      columns.map((c, i) => ({
        id: `${i}`,
        title: c.name,
        width: widths[i] ?? Math.min(320, Math.max(80, c.name.length * 9 + 32)),
      })),
    [columns, widths],
  );

  const getCellContent = useCallback(([col, row]: Item): GridCell => toGridCell(rows.current[row]?.[col], nullColor), [nullColor]);

  const done = phase.kind === 'rows' && phase.done;
  const onVisibleRegionChanged = useCallback(
    (r: Rectangle) => {
      if (done || waiting.current || !qidRef.current) return;
      if (r.y + r.height >= rows.current.length - PREFETCH_MARGIN) {
        waiting.current = true;
        send({ t: 'fetch', qid: qidRef.current });
      }
    },
    [done],
  );

  return (
    <div className="app">
      <Toolbar phase={phase} rowCount={rowCount} />
      {phase.kind === 'error' && <pre className="error">{phase.message}</pre>}
      {phase.kind === 'update' && (
        <div className="message">
          {phase.affectedRows === null ? 'Statement executed.' : `${phase.affectedRows} row(s) affected.`}
        </div>
      )}
      {phase.kind === 'idle' && <div className="message muted">Run a statement with ⌘/Ctrl+Enter.</div>}
      {columns.length > 0 && (phase.kind === 'rows' || phase.kind === 'running') && (
        <div className="grid">
          <DataEditor
            columns={gridColumns}
            rows={rowCount}
            getCellContent={getCellContent}
            getCellsForSelection
            onVisibleRegionChanged={onVisibleRegionChanged}
            onColumnResize={(_, w, i) => setWidths((prev) => ({ ...prev, [i]: w }))}
            rowMarkers="number"
            smoothScrollX
            smoothScrollY
            theme={theme}
            width="100%"
            height="100%"
          />
        </div>
      )}
    </div>
  );
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
      <span className="sql" title={sql}>{sql.replace(/\s+/g, ' ')}</span>
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
