import { useEffect, useRef, type ReactNode } from 'react';
import type { LevelDef } from '@fs/model';

// Semáforo de niveles de la marca Vantaz (sección 8.1 de la especificación).
export const LEVEL_COLORS = ['var(--n1)', 'var(--n2)', 'var(--n3)', 'var(--n4)', 'var(--n5)'];
export const SCORE_COLORS = LEVEL_COLORS;

export const fmtPct = (p: number | null | undefined) =>
  p == null ? '—' : `${(Math.round(p * 10) / 10).toLocaleString('es-CL')} %`;

export const dimLabel = (code: string, name: string) => `${code} · ${name}`;

export function LevelPill({ level, pct, prefix = '' }: { level: LevelDef | null; pct?: number | null; prefix?: string }) {
  if (!level) return null;
  return (
    <span className="pill" style={{ background: LEVEL_COLORS[level.n - 1] }}>
      {prefix}{pct != null ? `${fmtPct(pct)} · ` : ''}Nivel {level.n}
    </span>
  );
}

export function Bar({ value }: { value: number }) {
  return <span className="bar" style={{ display: 'block' }}><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></span>;
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('textarea, input, select, button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    return () => { removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function PageHead({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-h">
      <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
      {children && <><span className="spacer" />{children}</>}
    </div>
  );
}
