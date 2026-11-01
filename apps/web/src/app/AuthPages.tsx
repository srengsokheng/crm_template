import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.ts';
import { Button, Field, Input, Spinner } from '../components/ui/primitives.tsx';

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="text-lg font-semibold">Acme CRM</span>
        </div>
        <div className="surface rounded-[14px] border border-base p-6 shadow-sm">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <p className="mt-4 text-center text-sm text-muted">{footer}</p>}
      </div>
    </div>
  );
}

function useAuthSubmit(path: string, after = '/') {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (body: Record<string, unknown>) => {
    setLoading(true); setErrors({}); setError(null);
    try {
      await api.post(path, body);
      qc.clear();
      nav(after, { replace: true });
    } catch (e) {
      if (e instanceof ApiError) { setErrors(e.fields ?? {}); setError(e.message); } else setError('Network error, please try again');
    } finally { setLoading(false); }
  };
  return { submit, errors, error, loading };
}

const formData = (e: FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries());

export function LoginPage() {
  const { submit, errors, error, loading } = useAuthSubmit('/auth/login');
  return (
    <AuthShell title="Sign in" subtitle="Welcome back." footer={<>New here? <Link className="font-medium text-brand-600 hover:underline" to="/signup">Create a workspace</Link></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(formData(e)); }} noValidate>
        <Field label="Email" htmlFor="email" error={errors.email}><Input id="email" name="email" type="email" autoComplete="email" required autoFocus invalid={!!errors.email} /></Field>
        <Field label="Password" htmlFor="password" error={errors.password}><Input id="password" name="password" type="password" autoComplete="current-password" required invalid={!!errors.password} /></Field>
        {error && !Object.keys(errors).length && <p className="text-sm text-rose-600" role="alert">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" loading={loading}>Sign in</Button>
      </form>
    </AuthShell>
  );
}

export function SignupPage() {
  const { submit, errors, error, loading } = useAuthSubmit('/auth/signup');
  return (
    <AuthShell title="Create your workspace" subtitle="Start organising your leads, deals and customers." footer={<>Already have an account? <Link className="font-medium text-brand-600 hover:underline" to="/login">Sign in</Link></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(formData(e)); }} noValidate>
        <Field label="Company / workspace name" htmlFor="ws" error={errors.workspaceName}><Input id="ws" name="workspaceName" required autoFocus invalid={!!errors.workspaceName} /></Field>
        <Field label="Your name" htmlFor="name" error={errors.name}><Input id="name" name="name" autoComplete="name" required invalid={!!errors.name} /></Field>
        <Field label="Work email" htmlFor="email" error={errors.email}><Input id="email" name="email" type="email" autoComplete="email" required invalid={!!errors.email} /></Field>
        <Field label="Password" htmlFor="password" error={errors.password} hint="At least 8 characters"><Input id="password" name="password" type="password" autoComplete="new-password" required invalid={!!errors.password} /></Field>
        {error && !Object.keys(errors).length && <p className="text-sm text-rose-600" role="alert">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" loading={loading}>Create workspace</Button>
      </form>
    </AuthShell>
  );
}

export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const invite = useQuery({ queryKey: ['invite', token], queryFn: () => api.get<{ email: string; name: string; workspace: string }>(`/auth/invite/${token}`), retry: false });
  const { submit, errors, error, loading } = useAuthSubmit('/auth/accept-invite');
  if (invite.isLoading) return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>;
  if (invite.isError) {
    return <AuthShell title="Invitation not valid" subtitle={(invite.error as Error).message} footer={<Link className="font-medium text-brand-600" to="/login">Go to sign in</Link>}><span /></AuthShell>;
  }
  return (
    <AuthShell title={`Join ${invite.data!.workspace}`} subtitle={`You were invited as ${invite.data!.email}.`}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit({ ...formData(e), token }); }} noValidate>
        <Field label="Your name" htmlFor="name" error={errors.name}><Input id="name" name="name" defaultValue={invite.data!.name} required invalid={!!errors.name} /></Field>
        <Field label="Choose a password" htmlFor="password" error={errors.password} hint="At least 8 characters"><Input id="password" name="password" type="password" autoComplete="new-password" required autoFocus invalid={!!errors.password} /></Field>
        {error && !Object.keys(errors).length && <p className="text-sm text-rose-600" role="alert">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" loading={loading}>Join workspace</Button>
      </form>
    </AuthShell>
  );
}
