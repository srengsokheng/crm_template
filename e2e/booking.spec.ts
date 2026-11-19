import { expect, test } from '@playwright/test';
import pg from 'pg';
import { signUp, uniq } from './helpers.ts';

async function manageLink(to: string): Promise<string> {
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://crm:crm@127.0.0.1:5432/crm_e2e' });
  await c.connect();
  try {
    for (let i = 0; i < 40; i++) {
      const r = await c.query(`SELECT payload->>'text' AS text FROM jobs WHERE type = 'email.send' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [to]);
      const m = r.rows[0] && /\/booking\/[\w-]+/.exec(r.rows[0].text);
      if (m) return m[0];
      await new Promise((res) => setTimeout(res, 250));
    }
    throw new Error('no booking email queued');
  } finally { await c.end(); }
}

test('online booking: set up a page, a customer books a time, the meeting appears, the customer cancels', async ({ page, browser, baseURL }) => {
  await signUp(page);
  await page.goto('/settings/booking');
  await expect(page.getByText('No booking pages yet')).toBeVisible();
  await page.getByRole('button', { name: 'New booking page' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New booking page' });
  const slug = uniq('showroom');
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Showroom visit');
  await dialog.getByRole('textbox', { name: 'Link' }).fill(slug);
  for (const d of ['Sat', 'Sun']) await dialog.getByLabel(d, { exact: true }).check();
  await dialog.getByLabel('From').fill('00:00');
  await dialog.getByLabel('Until').fill('23:30');
  await dialog.getByLabel('Notice (hours)').fill('1');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Booking page created')).toBeVisible();
  const list = page.getByRole('list', { name: 'Booking pages' });
  await expect(list.getByText('Showroom visit')).toBeVisible();
  await expect(list.getByRole('link', { name: new RegExp(`/book/${slug}$`) })).toBeVisible();

  // The customer, in a separate browser.
  const ctx = await browser.newContext();
  const customer = await ctx.newPage();
  await customer.goto(`${baseURL}/book/${slug}`);
  await expect(customer.getByRole('heading', { name: 'Showroom visit' })).toBeVisible();
  await expect(customer.getByText('Video call — the link comes by email')).toBeVisible();
  const firstTime = customer.getByRole('button', { name: /^\d\d:\d\d$/ }).first();
  const time = (await firstTime.textContent())!;
  await firstTime.click();
  await customer.getByLabel('Your name').fill('Dara Sok');
  const email = `${uniq('dara')}@example-customer.test`;
  await customer.getByLabel('Email').fill(email);
  await customer.getByLabel('Anything we should know? (optional)').fill('Interested in the X2 arm');
  await customer.getByRole('button', { name: `Book ${time}` }).click();
  await expect(customer.getByRole('heading', { name: 'You’re booked!' })).toBeVisible();
  await expect(customer.getByText(`We sent the details to ${email}.`)).toBeVisible();

  // The team sees it: upcoming count, the booking, the meeting with the contact.
  await page.reload();
  await page.getByRole('button', { name: '1 upcoming' }).click();
  await expect(page.getByRole('dialog').getByText(`Dara Sok · ${email}`)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/contacts');
  await page.getByRole('row', { name: /Dara Sok/ }).getByText('Dara Sok', { exact: true }).click();
  await expect(page.getByText(/^Booked “Showroom visit” online for /)).toBeVisible();

  // The customer cancels from the email link.
  const link = await manageLink(email);
  await customer.goto(baseURL + link);
  await expect(customer.getByRole('link', { name: 'Join the video call' })).toBeVisible();
  await customer.getByRole('button', { name: 'Cancel booking' }).click();
  await customer.getByRole('dialog').getByRole('button', { name: 'Cancel booking' }).click();
  await expect(customer.getByText(/Your booking is canceled\./)).toBeVisible();
  await ctx.close();

  await page.reload();
  await expect(page.getByText(/^Canceled their online booking “Showroom visit”/)).toBeVisible();
});
