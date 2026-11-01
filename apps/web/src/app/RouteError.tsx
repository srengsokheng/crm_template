import { Link, useRouteError } from 'react-router';
import { Button } from '../components/ui/primitives.tsx';

export function RouteError() {
  const err = useRouteError() as { message?: string } | undefined;
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted">{err?.message ?? 'An unexpected error occurred.'}</p>
      <Button variant="primary" onClick={() => window.location.assign('/')}>Back to home</Button>
    </div>
  );
}

export function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="text-sm text-muted">The page you are looking for doesn’t exist or was moved.</p>
      <Link to="/" className="text-sm font-medium text-brand-600 hover:underline">Go to home</Link>
    </div>
  );
}
