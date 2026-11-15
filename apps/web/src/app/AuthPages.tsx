import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
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
  const notice = (useLocation().state as { notice?: string } | null)?.notice;
  return (
    <AuthShell title="Sign in" subtitle={notice ? <span className="text-emerald-700 dark:text-emerald-300" role="status">{notice}</span> : 'Welcome back.'} footer={<>New here? <Link className="font-medium text-brand-600 hover:underline dark:text-brand-200" to="/signup">Create a workspace</Link></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(formData(e)); }} noValidate>
        <Field label="Email" htmlFor="email" error={errors.email}><Input id="email" name="email" type="email" autoComplete="email" required autoFocus invalid={!!errors.email} /></Field>
        <Field label="Password" htmlFor="password" error={errors.password}><Input id="password" name="password" type="password" autoComplete="current-password" required invalid={!!errors.password} /></Field>
        <div className="-mt-2 text-right"><Link className="text-[13px] font-medium text-brand-600 hover:underline dark:text-brand-200" to="/forgot-password">Forgot password?</Link></div>
        {error && !Object.keys(errors).length && <p className="text-sm text-rose-600" role="alert">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" loading={loading}>Sign in</Button>
      </form>
    </AuthShell>
  );
}

export function SignupPage() {
  const { submit, errors, error, loading } = useAuthSubmit('/auth/signup');
  return (
    <AuthShell title="Create your workspace" subtitle="Start organising your leads, deals and customers." footer={<>Already have an account? <Link className="font-medium text-brand-600 hover:underline dark:text-brand-200" to="/login">Sign in</Link></>}>
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
    return <AuthShell title="Invitation not valid" subtitle={(invite.error as Error).message} footer={<Link className="font-medium text-brand-600 dark:text-brand-200" to="/login">Go to sign in</Link>}><span /></AuthShell>;
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

export function ForgotPasswordPage() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (email: string) => {
    setLoading(true); setErrors({}); setError(null);
    try { await api.post('/auth/forgot-password', { email }); setSentTo(email); }
    catch (e) { if (e instanceof ApiError) { setErrors(e.fields ?? {}); setError(e.message); } else setError('Network error, please try again'); }
    finally { setLoading(false); }
  };
  const back = <Link className="font-medium text-brand-600 hover:underline dark:text-brand-200" to="/login">Back to sign in</Link>;
  if (sentTo) {
    return (
      <AuthShell title="Check your email" footer={back}>
        <p className="text-sm">If <span className="font-medium">{sentTo}</span> has an account, we sent it a link to choose a new password. The link expires in 1 hour.</p>
        <p className="mt-3 text-sm text-muted">Nothing arrived? Check your spam folder, or ask your workspace admin to re-invite you.</p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Forgot your password?" subtitle="Enter your email and we’ll send you a link to choose a new one." footer={back}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(String(formData(e).email ?? '')); }} noValidate>
        <Field label="Email" htmlFor="email" error={errors.email}><Input id="email" name="email" type="email" autoComplete="email" required autoFocus invalid={!!errors.email} /></Field>
        {error && !Object.keys(errors).length && <p className="text-sm text-rose-600" role="alert">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" loading={loading}>Send reset link</Button>
      </form>
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const { token = '' } = useParams();
  const nav = useNavigate();
  const check = useQuery({ queryKey: ['reset', token], queryFn: () => api.get<{ email: string }>(`/auth/reset/${token}`), retry: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  if (check.isLoading) return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>;
  if (check.isError) {
    return (
      <AuthShell title="Link not valid" subtitle={(check.error as Error).message} footer={<Link className="font-medium text-brand-600 hover:underline dark:text-brand-200" to="/login">Back to sign in</Link>}>
        <Link className="inline-flex h-9 w-full items-center justify-center rounded-[var(--radius-control)] bg-brand-600 px-3.5 text-sm font-medium text-white hover:bg-brand-700" to="/forgot-password">Send a new link</Link>
      </AuthShell>
    );
  }
  const submit = async (password: string, confirm: string) => {
    setErrors({}); setError(null);
    if (password !== confirm) { setErrors({ confirm: 'The passwords don’t match' }); return; }
    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      nav('/login', { replace: true, state: { notice: 'Password changed. Sign in with your new password.' } });
    } catch (e) {
      if (e instanceof ApiError) { setErrors(e.fields ?? {}); setError(e.message); } else setError('Network error, please try again');
      setLoading(false);
    }
  };
  return (
    <AuthShell title="Choose a new password" subtitle={`For ${check.data!.email}. You’ll be signed out on other devices.`}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); const d = formData(e); submit(String(d.password ?? ''), String(d.confirm ?? '')); }} noValidate>
        <input type="email" name="username" autoComplete="username" value={check.data!.email} readOnly hidden />
        <Field label="New password" htmlFor="password" error={errors.password} hint="At least 8 characters"><Input id="password" name="password" type="password" autoComplete="new-password" required autoFocus invalid={!!errors.password} /></Field>
        <Field label="Repeat new password" htmlFor="confirm" error={errors.confirm}><Input id="confirm" name="confirm" type="password" autoComplete="new-password" required invalid={!!errors.confirm} /></Field>
        {error && !Object.keys(errors).length && <p className="text-sm text-rose-600" role="alert">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" loading={loading}>Change password</Button>
      </form>
    </AuthShell>
  );
}
