import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import qrcode from 'qrcode-generator';
import { Link } from 'react-router';
import { api, errorMessage } from '../../lib/api.ts';
import { money } from '../../lib/format.ts';
import { useMe } from '../../lib/hooks.ts';
import { Card, ErrorState, Skeleton } from '../../components/ui/primitives.tsx';
import { dateOnly } from './common.tsx';

type Khqr =
  | { available: true; payload: string; amount: string; currency: 'KHR' | 'USD'; expiresAt: string; accountId: string; merchantName: string }
  | { available: false; reason: 'not_configured' | 'not_invoice' | 'not_sent' | 'paid' | 'currency'; message: string };

/** A QR code as SVG squares (dark modules on white, with the quiet zone scanners need). */
export function QrSvg({ text, label, className }: { text: string; label: string; className?: string }) {
  const { path, size } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { path: d, size: n + 8 };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className={className} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/** "Pay with KHQR" on a sent invoice: the Bakong QR for the balance due (admins see how to set it up). */
export function KhqrCard({ docId, balance }: { docId: number; balance: string }) {
  const { data: me } = useMe();
  const q = useQuery({ queryKey: ['khqr', docId, balance], queryFn: () => api.get<Khqr>(`/documents/${docId}/khqr`) });
  if (q.isLoading) return <Card title="Pay with KHQR"><Skeleton className="h-40" /></Card>;
  if (q.isError) return <Card title="Pay with KHQR"><ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /></Card>;
  const k = q.data!;
  if (!k.available) {
    if (k.reason === 'not_configured' && me?.role.isAdmin) {
      return (
        <Card title="Pay with KHQR">
          <p className="text-sm text-muted">Let customers pay by scanning a Bakong KHQR with any Cambodian bank app. <Link className="text-brand-600 underline underline-offset-2 dark:text-brand-200" to="/settings/documents">Set it up</Link> once; every sent invoice in riel or dollars then shows it, here and on the PDF.</p>
        </Card>
      );
    }
    return k.reason === 'currency' ? <Card title="Pay with KHQR"><p className="text-sm text-muted">{k.message}</p></Card> : null;
  }
  return (
    <Card title="Pay with KHQR">
      <div className="flex flex-wrap items-center gap-4">
        <QrSvg text={k.payload} label={`KHQR to pay ${money(k.amount, k.currency)} to ${k.merchantName}`} className="size-40 shrink-0 rounded-md border border-base" />
        <div className="min-w-0 space-y-1 text-sm">
          <div className="text-lg font-semibold tabular">{money(k.amount, k.currency)}</div>
          <div>To <span className="font-medium">{k.merchantName}</span> <span className="text-muted">({k.accountId})</span></div>
          <div className="text-muted">Scan with any Bakong member bank app (ABA, ACLEDA, Wing, …). Valid until {dateOnly(k.expiresAt)}.</div>
          <div className="text-muted">When the money arrives, record the payment here.</div>
        </div>
      </div>
    </Card>
  );
}
