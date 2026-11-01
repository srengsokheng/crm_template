import { Globe, Mail, MessageCircle, Phone } from 'lucide-react';
import type { Method } from '../../lib/types.ts';

const ICON = { email: Mail, phone: Phone, website: Globe, messenger: MessageCircle };
export function MethodsView({ methods }: { methods: Method[] }) {
  if (!methods.length) return <span className="text-muted">—</span>;
  return (
    <ul className="space-y-1">
      {methods.map((m, i) => {
        const Icon = ICON[m.kind];
        const href = m.kind === 'email' ? `mailto:${m.value}` : m.kind === 'phone' ? `tel:${m.value.replace(/[^\d+]/g, '')}` : m.kind === 'website' ? (m.value.startsWith('http') ? m.value : `https://${m.value}`) : undefined;
        return (
          <li key={m.id ?? i} className="flex items-center gap-2">
            <Icon className="size-3.5 shrink-0 text-muted" />
            {href ? <a href={href} target={m.kind === 'website' ? '_blank' : undefined} rel="noreferrer" className="truncate text-brand-600 hover:underline">{m.value}</a> : <span className="truncate">{m.value}</span>}
            <span className="text-xs text-muted">{m.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
