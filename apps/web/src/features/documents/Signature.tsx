import { useRef, useState, type PointerEvent } from 'react';
import { SIGNATURE_BOX, signaturePath } from '@crm/shared';
import { cn } from '../../lib/cn.ts';
import { Button } from '../../components/ui/primitives.tsx';

type Strokes = number[][];
const { width: W, height: H } = SIGNATURE_BOX;

/** A drawn signature, read-only (SVG in the signature box's units). */
export function SignatureView({ strokes, className, label }: { strokes: Strokes; className?: string; label: string }) {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={cn('h-auto w-full max-w-[240px] text-slate-900 dark:text-slate-100', className)} role="img" aria-label={label}>
      <path d={signaturePath(strokes)} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Draw a signature with a finger, pen or mouse. Points are kept in SIGNATURE_BOX units (whole numbers), so the
 * result is small and resolution-independent. `onChange(null)` when cleared.
 */
export function SignaturePad({ value, onChange, label, hint, clearLabel, invalid, id }: {
  value: Strokes | null; onChange: (v: Strokes | null) => void; label: string; hint: string; clearLabel: string; invalid?: boolean; id: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const drawing = useRef<number[] | null>(null);
  const [, redraw] = useState(0);
  const strokes = value ?? [];
  const point = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = Math.round(Math.min(W, Math.max(0, ((e.clientX - r.left) / r.width) * W)));
    const y = Math.round(Math.min(H, Math.max(0, ((e.clientY - r.top) / r.height) * H)));
    return [x, y] as const;
  };
  const down = (e: PointerEvent<SVGSVGElement>) => {
    e.preventDefault();
    ref.current!.setPointerCapture(e.pointerId);
    const [x, y] = point(e);
    drawing.current = [x, y];
    onChange([...strokes, drawing.current]);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const st = drawing.current;
    if (!st) return;
    const [x, y] = point(e);
    if (st[st.length - 2] === x && st[st.length - 1] === y) return;
    if (st.length >= 3000) return; // keeps a stroke within the server's limit
    st.push(x, y);
    redraw((n) => n + 1);
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = null;
    onChange([...strokes]);
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium" aria-hidden="true">{label}</span>
        {strokes.length > 0 && <Button size="sm" variant="ghost" onClick={() => onChange(null)}>{clearLabel}</Button>}
      </div>
      <div className={cn('relative rounded-md border bg-white dark:bg-slate-950', invalid ? 'border-rose-500' : 'border-base')}>
        <svg id={id} ref={ref} viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full cursor-crosshair touch-none select-none text-slate-900 dark:text-slate-100"
          role="img" aria-label={`${label}. ${hint}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} data-testid="signature-pad">
          <line x1={16} x2={W - 16} y1={H - 22} y2={H - 22} className="stroke-slate-300 dark:stroke-slate-700" strokeWidth={1} />
          <path d={strokes.length ? signaturePath(strokes) : ''} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {!strokes.length && <span className="pointer-events-none absolute inset-x-0 bottom-1 text-center text-xs text-muted">{hint}</span>}
      </div>
    </div>
  );
}
