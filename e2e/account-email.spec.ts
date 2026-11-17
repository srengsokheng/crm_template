import { expect, test } from '@playwright/test';
import pg from 'pg';
import { signUp } from './helpers.ts';

// The e2e server has no mail server, so the test reads the queued email from the jobs table.
async function mailLink(to: string, path: string): Promise<string> {
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://crm:crm@127.0.0.1:5432/crm_e2e' });
  await c.connect();
  try {
    for (let i = 0; i < 20; i++) {
      const r = await c.query(`SELECT payload->>'text' AS text FROM jobs WHERE type = 'email.send' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [to]);
      const m = r.rows[0] && new RegExp(`${path}/[\\w-]+`).exec(r.rows[0].text);
      if (m) return m[0];
      await new Promise((res) => setTimeout(res, 250));
    }
    throw new Error(`no email with ${path} queued for ${to}`);
  } finally { await c.end(); }
}

test('change your sign-in email: confirm from the new address, then sign in with it', async ({ page, browser }) => {
  const email = await signUp(page);
  const next = `new-${Date.now()}@example.com`;
  await page.goto('/settings/account');
  await page.locator('#acc-new-email').fill(next);
  await page.locator('#acc-email-password').fill('password123');
  await page.getByRole('button', { name: 'Send confirmation link' }).click();
  await expect(page.getByRole('status').filter({ hasText: `Check ${next}` })).toBeVisible();
  await expect(page.getByText(`Currently ${email}`)).toBeVisible();

  // Open the link on another device (not signed in) and confirm.
  const link = await mailLink(next, '/confirm-email');
  const other = await browser.newPage();
  await other.goto(link);
  await other.getByRole('button', { name: 'Confirm new email' }).click();
  await expect(other.getByRole('heading', { name: 'Email changed' })).toBeVisible();
  await expect(other.getByText(`You now sign in with ${next}.`)).toBeVisible();
  // The link works once.
  await other.goto(link);
  await other.getByRole('button', { name: 'Confirm new email' }).click();
  await expect(other.getByRole('alert')).toContainText('not valid any more');

  await page.reload();
  await expect(page.getByText(`Currently ${next}`)).toBeVisible();
  await other.goto('/login');
  await other.getByLabel('Email').fill(next);
  await other.getByLabel('Password').fill('password123');
  await other.getByRole('button', { name: 'Sign in' }).click();
  await expect(other).toHaveURL(/\/$/);
});
