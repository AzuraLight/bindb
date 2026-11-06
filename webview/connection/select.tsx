import { Children, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import VscodeOption from '@vscode-elements/react-elements/dist/components/VscodeOption.js';
import VscodeSingleSelect from '@vscode-elements/react-elements/dist/components/VscodeSingleSelect.js';

/*
 * 선택 상자. 웹뷰의 기본 <select>는 macOS에서 시스템 팝업으로 열려 VS Code 모양과 다르고 위치도 어긋난다.
 *  - 상자 모양: VSCode Elements의 vscode-single-select(직접 그린 목록, VS Code 테마 변수 사용).
 *    Microsoft의 Webview UI Toolkit은 2025-01-01에 지원이 끝나 보관(archived)됐다.
 *  - 링크 모양(className에 link-select): DataGrip의 "Driver: PostgreSQL ▾" 처럼 글자를 누르면 메뉴가 뜬다.
 * 쓰는 쪽은 기본 <select>와 같게 쓴다: value, onChange(e.target.value), 자식 <option>.
 */

interface Opt {
  value: string;
  label: string;
}

/** 자식 <option>들(조각 · 배열 · 조건부 포함)을 평평하게 모은다 */
function collect(children: ReactNode, out: Opt[] = []): Opt[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<{ value?: string; children?: ReactNode }>;
    if (el.type === 'option') {
      const label = Children.toArray(el.props.children).join('');
      out.push({ value: String(el.props.value ?? label), label });
    } else if (el.props.children !== undefined) collect(el.props.children, out);
  });
  return out;
}

export interface SelectProps {
  id?: string;
  className?: string;
  value: string;
  disabled?: boolean;
  'aria-label'?: string;
  onChange: (e: { target: { value: string } }) => void;
  children: ReactNode;
}

export function Select(props: SelectProps) {
  const options = collect(props.children);
  if (props.className?.split(/\s+/).includes('link-select')) return <LinkSelect {...props} options={options} />;
  return (
    <VscodeSingleSelect
      id={props.id}
      className={props.className}
      value={props.value}
      disabled={props.disabled}
      aria-label={props['aria-label']}
      onChange={(e) => props.onChange({ target: { value: (e.target as HTMLSelectElement).value } })}
    >
      {options.map((o) => (
        <VscodeOption key={o.value} value={o.value} selected={o.value === props.value}>
          {o.label}
        </VscodeOption>
      ))}
    </VscodeSingleSelect>
  );
}

/** 글자 링크 + 메뉴 */
function LinkSelect(props: SelectProps & { options: Opt[] }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const current = props.options.find((o) => o.value === props.value);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, props.options.findIndex((o) => o.value === props.value)));
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const pick = (value: string) => {
    setOpen(false);
    if (value !== props.value) props.onChange({ target: { value } });
  };

  return (
    <span className="link-select-wrap" ref={ref}>
      <button
        id={props.id}
        type="button"
        className="link-select"
        disabled={props.disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={props['aria-label']}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setOpen(true);
          } else if (open) {
            if (e.key === 'Escape') setOpen(false);
            else if (e.key === 'ArrowDown') setActive((i) => Math.min(props.options.length - 1, i + 1));
            else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
            else if (e.key === 'Enter') pick(props.options[active].value);
            else return;
            e.preventDefault();
          }
        }}
      >
        {current?.label ?? props.value}
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      {open && (
        <div className="menu" role="listbox">
          {props.options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === props.value}
              className={`${i === active ? 'active ' : ''}${o.value === props.value ? 'checked' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o.value)}
            >
              <span className="check-mark">{o.value === props.value ? '✓' : ''}</span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
