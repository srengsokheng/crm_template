import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { LeadForm } from '../features/leads/LeadForm.tsx';
import { DealForm } from '../features/deals/DealForm.tsx';
import { ContactForm } from '../features/contacts/ContactForm.tsx';
import { CompanyForm } from '../features/companies/CompanyForm.tsx';
import { ActivityForm } from '../features/activities/ActivityForm.tsx';

type Kind = 'lead' | 'deal' | 'contact' | 'company' | 'activity';
interface CreateState { kind: Kind; defaults?: Record<string, unknown> }
const Ctx = createContext<{ open: (k: Kind, defaults?: Record<string, unknown>) => void }>({ open: () => {} });

/** Global "create" drawers so any page (or the top bar) can open them. */
export function CreateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CreateState | null>(null);
  const open = useCallback((kind: Kind, defaults?: Record<string, unknown>) => setState({ kind, defaults }), []);
  const close = () => setState(null);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {state?.kind === 'lead' && <LeadForm open onClose={close} defaults={state.defaults} />}
      {state?.kind === 'deal' && <DealForm open onClose={close} defaults={state.defaults} />}
      {state?.kind === 'contact' && <ContactForm open onClose={close} defaults={state.defaults} />}
      {state?.kind === 'company' && <CompanyForm open onClose={close} defaults={state.defaults} />}
      {state?.kind === 'activity' && <ActivityForm open onClose={close} defaults={state.defaults} />}
    </Ctx.Provider>
  );
}
export const useCreate = () => useContext(Ctx);
