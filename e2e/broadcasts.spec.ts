import { expect, test } from '@playwright/test';
import pg from 'pg';
import { api, signUp, uniq } from './helpers.ts';

// The e2e server has no mail server, so the test reads the queued email from the jobs table.
async function queuedMail(to: string): Promise<{ subject: string; text: string }> {
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://crm:crm@127.0.0.1:5432/crm_e2e' });
  await c.connect();
  try {
    for (let i = 0; i < 40; i++) {
      const r = await c.query(`SELECT payload->>'subject' AS subject, payload->>'text' AS text FROM jobs WHERE type = 'email.send' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [to]);
      if (r.rows[0]) return r.rows[0];
      await new Promise((res) => setTimeout(res, 250));
    }
    throw new Error('no broadcast email queued');
  } finally { await c.end(); }
}

test('broadcast by email: write, check who gets it, send, see progress; the customer unsubscribes', async ({ page, browser, baseURL }) => {
  await signUp(page);
  const ada = `${uniq('ada')}@umbrella.test`;
  const bo = `${uniq('bo')}@globex.test`;
  await api(page, 'POST', '/contacts', { firstName: 'Ada', lastName: 'Lovelace', methods: [{ kind: 'email', value: ada }] });
  await api(page, 'POST', '/contacts', { firstName: 'Bo', methods: [{ kind: 'email', value: bo }] });

  await page.getByRole('link', { name: 'Broadcasts', exact: true }).locator('visible=true').first().click();
  await expect(page.getByText('No broadcasts yet')).toBeVisible();
  await page.getByRole('button', { name: 'New broadcast' }).first().click();

  await page.getByLabel(/^Name/).fill('November offer');
  await expect(page.getByLabel('Send through')).toHaveValue('email');
  await page.getByLabel('Subject').fill('An offer for {{first_name}}');
  await page.getByLabel('Message').fill('Hello {{first_name}},\n\n10% off robot arms this month.');
  await expect(page.getByText('2 people', { exact: false })).toBeVisible();
  // The preview fills in a sample name.
  await expect(page.getByText('An offer for Dara')).toBeVisible();

  await page.getByRole('button', { name: 'Send…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send to 2 people?' });
  await dialog.getByRole('button', { name: 'Send now' }).click();
  await expect(page.getByText('Sending started')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'November offer' })).toBeVisible();
  await expect(page.getByText('Sent', { exact: true })).toBeVisible({ timeout: 15_000 });
  const people = page.getByRole('list', { name: 'People' });
  await expect(people.getByRole('listitem')).toHaveCount(2);
  await expect(people.getByText('Delivered')).toHaveCount(2);

  const mail = await queuedMail(ada);
  expect(mail.subject).toBe('An offer for Ada');
  expect(mail.text).toContain('Hello Ada,');
  const link = /\/unsubscribe\/[\w-]+/.exec(mail.text)![0];

  // The customer's page asks first (mail scanners open links), then confirms.
  const ctx = await browser.newContext();
  const customer = await ctx.newPage();
  await customer.goto(baseURL + link);
  await expect(customer.getByRole('heading', { name: /^Unsubscribe from .+ emails$/ })).toBeVisible();
  await customer.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(customer.getByText('You’re unsubscribed.')).toBeVisible();
  await customer.reload();
  await expect(customer.getByText('You’re unsubscribed.')).toBeVisible();
  await ctx.close();

  // The next broadcast leaves Ada out.
  await page.getByRole('link', { name: 'All broadcasts' }).click();
  await expect(page.getByRole('list', { name: 'Broadcasts' }).getByText('November offer')).toBeVisible();
  await page.getByRole('button', { name: 'New broadcast' }).click();
  await expect(page.getByText('1 person')).toBeVisible();
  await expect(page.getByText('1 opted out and won’t get it.')).toBeVisible();
});
