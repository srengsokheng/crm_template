import { useState, type ReactNode } from 'react';
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { Link } from 'react-router';
import { Plus, CheckCircle2, XCircle, Clock, AlertTriangle } from 'lucide-react';
import { cn } from '../../lib/cn.ts';
import { dueLabel, money } from '../../lib/format.ts';
import type { NextActivity, Stage } from '../../lib/types.ts';
import { Avatar } from '../../components/ui/primitives.tsx';
import { STAGE_SOLID } from '../../components/ui/stageColors.ts';

export interface BoardCard {
  id: number; title: string; amount: string | null; currency: string; stageId: number; ownerName: string | null; ownerId: number;
  subtitle?: string | null; nextActivity: NextActivity | null; stageChangedAt: string; rotDays?: number | null; href: string;
}
export interface BoardStat { stageId: number; count: number; sum: string }

/** Generic pipeline board used for deals and leads. */
export function Board({ stages, cards, stats, currency, onMove, onQuickAdd, closedZones, canDrag }: {
  stages: Stage[]; cards: BoardCard[]; stats: BoardStat[]; currency: string;
  onMove: (card: BoardCard, target: Stage) => void; onQuickAdd?: (stage: Stage) => void;
  closedZones: { won?: Stage; lost?: Stage; wonLabel?: string; lostLabel?: string }; canDrag: (c: BoardCard) => boolean;
}) {
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const open = stages.filter((s) => s.kind === 'open');
  const onStart = (e: DragStartEvent) => setDragging(cards.find((c) => c.id === e.active.id) ?? null);
  const onEnd = (e: DragEndEvent) => {
    const card = cards.find((c) => c.id === e.active.id);
    setDragging(null);
    if (!card || !e.over) return;
    const target = stages.find((s) => `stage-${s.id}` === e.over!.id);
    if (target && target.id !== card.stageId) onMove(card, target);
  };
  return (
    <DndContext sensors={sensors} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={() => setDragging(null)}>
      <div className="-mx-4 overflow-x-auto px-4 pb-4 md:-mx-6 md:px-6">
        <div className="flex min-h-[60vh] gap-3">
          {open.map((s) => {
            const st = stats.find((x) => x.stageId === s.id);
            const list = cards.filter((c) => c.stageId === s.id);
            return (
              <Column key={s.id} stage={s} count={st?.count ?? 0} sum={money(st?.sum ?? 0, currency, { compact: true })} onQuickAdd={onQuickAdd}>
                {list.map((c) => <DraggableCard key={c.id} card={c} disabled={!canDrag(c)} />)}
                {(st?.count ?? 0) > list.length && <p className="py-2 text-center text-xs text-muted">+{(st?.count ?? 0) - list.length} more — use the list view or search</p>}
                {!list.length && <p className="py-6 text-center text-xs text-muted">Drop here</p>}
              </Column>
            );
          })}
        </div>
      </div>
      {/* Won / Lost drop zones appear while dragging */}
      <div className={cn('pointer-events-none fixed inset-x-0 bottom-0 z-40 grid grid-cols-2 gap-3 p-4 transition-all md:left-16 lg:left-60',
        dragging ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0')}>
        {closedZones.won && <DropZone stage={closedZones.won} label={closedZones.wonLabel ?? 'Won'} tone="won" active={!!dragging} />}
        {closedZones.lost && <DropZone stage={closedZones.lost} label={closedZones.lostLabel ?? 'Lost'} tone="lost" active={!!dragging} />}
      </div>
      <DragOverlay>{dragging && <CardBody card={dragging} overlay />}</DragOverlay>
    </DndContext>
  );
}

function Column({ stage, count, sum, children, onQuickAdd }: { stage: Stage; count: number; sum: string; children: ReactNode; onQuickAdd?: (s: Stage) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `stage-${stage.id}` });
  return (
    <section ref={setNodeRef} aria-label={`${stage.name} stage`}
      className={cn('flex w-[17rem] shrink-0 flex-col rounded-[var(--radius-card)] border border-base bg-[var(--surface-2)]/50 transition-colors', isOver && 'border-brand-400 bg-brand-50/70 dark:bg-brand-600/10')}>
      <header className="sticky top-0 px-3 pb-2 pt-3">
        <div className={cn('mb-2 h-1 rounded-full', STAGE_SOLID[stage.color] ?? 'bg-slate-400')} />
        <div className="flex items-center justify-between gap-2">
          <h3 className="truncate text-[13px] font-semibold">{stage.name}</h3>
          <span className="rounded-full bg-[var(--surface)] px-1.5 text-xs font-medium text-muted">{count}</span>
        </div>
        <div className="mt-0.5 text-xs text-muted tabular">{sum}{stage.probability != null && <span> · {stage.probability}%</span>}</div>
      </header>
      {onQuickAdd && (
        <button type="button" onClick={() => onQuickAdd(stage)} className="mx-3 mb-2 inline-flex items-center justify-center gap-1 rounded-md border border-dashed border-base py-1.5 text-xs font-medium text-muted hover:bg-[var(--surface)] hover:text-[var(--text)]">
          <Plus className="size-3.5" />Add
        </button>
      )}
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">{children}</div>
    </section>
  );
}

function DropZone({ stage, label, tone, active }: { stage: Stage; label: string; tone: 'won' | 'lost'; active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `stage-${stage.id}`, disabled: !active });
  return (
    <div ref={setNodeRef} className={cn('pointer-events-auto flex h-16 items-center justify-center gap-2 rounded-xl border-2 border-dashed text-sm font-semibold shadow-lg backdrop-blur',
      tone === 'won' ? 'border-emerald-400 bg-emerald-50/95 text-emerald-700 dark:bg-emerald-900/80 dark:text-emerald-100' : 'border-rose-400 bg-rose-50/95 text-rose-700 dark:bg-rose-900/80 dark:text-rose-100',
      isOver && 'scale-[1.02] border-solid')}>
      {tone === 'won' ? <CheckCircle2 className="size-5" /> : <XCircle className="size-5" />}{label}
    </div>
  );
}

function DraggableCard({ card, disabled }: { card: BoardCard; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.id, disabled });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className={cn('touch-manipulation', isDragging && 'opacity-30')} aria-roledescription="Draggable card">
      <CardBody card={card} />
    </div>
  );
}

function CardBody({ card, overlay }: { card: BoardCard; overlay?: boolean }) {
  const due = card.nextActivity ? dueLabel(card.nextActivity.dueAt) : null;
  const idleDays = Math.floor((Date.now() - new Date(card.stageChangedAt).getTime()) / 864e5);
  const rotting = card.rotDays && idleDays >= card.rotDays;
  return (
    <article className={cn('surface rounded-lg border border-base p-3 shadow-xs transition-shadow hover:shadow-md', overlay && 'rotate-1 shadow-xl')}>
      <Link to={card.href} className="block text-sm font-medium leading-snug hover:text-brand-700 dark:hover:text-brand-200" onClick={(e) => overlay && e.preventDefault()}>{card.title}</Link>
      {card.subtitle && <p className="mt-0.5 truncate text-xs text-muted">{card.subtitle}</p>}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold tabular">{card.amount && Number(card.amount) > 0 ? money(card.amount, card.currency) : <span className="font-normal text-muted">No value</span>}</span>
        <Avatar size="xs" name={card.ownerName} />
      </div>
      <div className="mt-2 flex items-center gap-1 text-xs">
        {due ? (
          <span className={cn('inline-flex items-center gap-1 truncate', due.tone === 'overdue' ? 'text-rose-600' : due.tone === 'today' ? 'text-amber-600' : 'text-muted')}>
            <Clock className="size-3 shrink-0" />{card.nextActivity!.subject} · {due.text}
          </span>
        ) : <span className="inline-flex items-center gap-1 text-amber-600"><AlertTriangle className="size-3" />No next step</span>}
      </div>
      {rotting && <div className="mt-1 text-[11px] font-medium text-rose-600">Idle for {idleDays} days</div>}
    </article>
  );
}
