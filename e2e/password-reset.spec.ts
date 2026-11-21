import { expect, test } from '@playwright/test';
import pg from 'pg';
import { signUp } from './helpers.ts';

// The e2e server has no mail server, so the test reads the queued email from the jobs table.
async function resetLink(email: string): Promise<string> {
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://crm:crm@127.0.0.1:5432/crm_e2e' });
  await c.connect();
  try {
    for (let i = 0; i < 20; i++) {
      const r = await c.query(`SELECT payload->>'text' AS text FROM jobs WHERE type = 'email.send' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [email]);
      const m = r.rows[0] && /\/reset-password\/[\w-]+/.exec(r.rows[0].text);
      if (m) return m[0];
      await new Promise((res) => setTimeout(res, 250));
    }
    throw new Error('no reset email queued');
  } finally { await c.end(); }
}

test('forgot password → email link → new password → sign in', async ({ page, browser }) => {
  const email = await signUp(page);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  const link = await resetLink(email);
  await page.goto(link);
  await expect(page.getByText(`For ${email}.`)).toBeVisible();
  await page.getByLabel('New password', { exact: true }).fill('brand-new-pass');
  await page.getByLabel('Repeat new password').fill('different-pass');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('The passwords don’t match')).toBeVisible();
  await page.getByLabel('Repeat new password').fill('brand-new-pass');
  await page.getByRole('button', { name: 'Change password' }).click();

  await expect(page.getByText('Password changed. Sign in with your new password.')).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('brand-new-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();

  // The link can't be used twice.
  const other = await browser.newPage();
  await other.goto(link);
  await expect(other.getByRole('heading', { name: 'Link not valid' })).toBeVisible();
  await expect(other.getByRole('link', { name: 'Send a new link' })).toBeVisible();
  await other.close();
});
