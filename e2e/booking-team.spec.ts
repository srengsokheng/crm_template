import { expect, test } from '@playwright/test';
import pg from 'pg';
import { api, signUp, uniq } from './helpers.ts';

async function mailsTo(to: string): Promise<{ subject: string; text: string }[]> {
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://crm:crm@127.0.0.1:5432/crm_e2e' });
  await c.connect();
  try {
    return (await c.query(`SELECT payload->>'subject' AS subject, payload->>'text' AS text FROM jobs WHERE type = 'email.send' AND payload->>'to' = $1 ORDER BY id`, [to])).rows;
  } finally { await c.end(); }
}

test('the team moves and cancels a booking from Settings → Booking pages; the customer is emailed each time', async ({ page }) => {
  await signUp(page);
  const me = await api(page, 'GET', '/auth/me');
  const slug = uniq('demo');
  const bp = await api(page, 'POST', '/booking-pages', { title: 'Product demo', slug, hostId: me.user.id, durationMinutes: 30, days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:30', minNoticeHours: 1, daysAhead: 5, video: false, location: 'Office' });
  const info = await (await page.request.get(`/api/v1/public/book/${slug}`)).json();
  const email = `${uniq('dara')}@example-customer.test`;
  const r = await page.request.post(`/api/v1/public/book/${slug}`, { data: { start: info.days[0].slots[0], name: 'Dara Sok', email } });
  expect(r.status()).toBe(201);

  await page.goto('/settings/booking');
  await page.getByRole('button', { name: '1 upcoming' }).click();
  await page.getByRole('button', { name: 'Move Dara Sok’s booking' }).click();
  const d = new Date(Date.now() + 2 * 86_400_000);
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T10:15`;
  await page.getByLabel('New date and time').fill(local);
  await page.getByRole('button', { name: 'Move and email' }).click();
  await expect(page.getByText('Moved — Dara Sok was emailed the new time')).toBeVisible();
  const moved = (await mailsTo(email)).at(-1)!;
  expect(moved.subject).toMatch(/^Moved: Product demo to /);
  expect(moved.text).toContain(`${me.user.name} moved your booking.`);

  await page.getByRole('button', { name: 'Cancel Dara Sok’s booking' }).click();
  await page.getByLabel('Message to the customer (optional)').fill('Sorry, the office is closed that day. Please pick another time.');
  await page.getByRole('button', { name: 'Cancel and email' }).click();
  await expect(page.getByText('Canceled — Dara Sok was emailed')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Bookings' }).getByText('Canceled', { exact: true })).toBeVisible();
  const canceled = (await mailsTo(email)).at(-1)!;
  expect(canceled.subject).toMatch(/^Canceled: Product demo on /);
  expect(canceled.text).toContain('Sorry, the office is closed that day.');
  expect(bp.id).toBeTruthy();
});
