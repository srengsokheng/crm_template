import { Link } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import { useMe } from '../../lib/hooks.ts';

/** Shown on the dashboard and reports when some amounts can't be converted to the base currency yet. */
export function MissingRates({ currencies, base }: { currencies?: string[]; base?: string }) {
  const { data: me } = useMe();
  if (!currencies?.length) return null;
  const list = currencies.join(', ');
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
      <AlertTriangle className="size-4 shrink-0" />
      <span>Amounts in {list} aren’t included in the totals because there is no exchange rate to {base ?? 'the base currency'} yet.</span>
      {me?.role.isAdmin
        ? <Link to="/settings/currencies" className="font-medium underline">Add exchange rates</Link>
        : <span>Ask an admin to add them in Settings → Currencies.</span>}
    </p>
  );
}
