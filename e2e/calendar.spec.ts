import { expect, test } from '@playwright/test';
import { api, apiIdle, signUp } from './helpers.ts';

const pad = (n: number) => String(n).padStart(2, '0');
/** A day of the current month as YYYY-MM-DD (local). */
const dayOfMonth = (d: number) => { const t = new Date(); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(d)}`; };

test('calendar: activities and deals on their days; drag to another day keeps the time; Undo; week view', async ({ page }) => {
  await signUp(page);
  const due = new Date(`${dayOfMonth(10)}T09:30:00`); // local 09:30 on the 10th
  const act = await api(page, 'POST', '/activities', { kind: 'call', subject: 'Call Dara', dueAt: due.toISOString() });
  const deal = await api(page, 'POST', '/deals', { title: 'Robot arms', amount: '1200', expectedCloseDate: dayOfMonth(20) });
  await page.goto('/calendar');
  const cell = (d: number) => page.locator(`[data-day="${dayOfMonth(d)}"]`);
  await expect(cell(10).getByText('Call Dara')).toBeVisible();
  await expect(cell(10)).toContainText('9:30a');
  await expect(cell(20).getByText('Robot arms')).toBeVisible();

  // Drag the call from the 10th to the 12th: same time, new day.
  await apiIdle(page);
  const from = (await cell(10).locator('[data-item]').first().boundingBox())!;
  const to = (await cell(12).boundingBox())!;
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + 10 + (to.x + 20 - from.x - 10) * (i / 10), from.y + from.height / 2 + (to.y + 40 - from.y - from.height / 2) * (i / 10));
  await page.mouse.up();
  await expect(page.getByText(/Moved “Call Dara” to/)).toBeVisible();
  await expect(cell(12).getByText('Call Dara')).toBeVisible();
  const moved = new Date((await api(page, 'GET', '/activities?pageSize=50')).data.find((a: any) => a.id === act.id).dueAt);
  expect([moved.getDate(), moved.getHours(), moved.getMinutes()]).toEqual([12, 9, 30]);
  await page.locator('[data-sonner-toast]').filter({ hasText: 'Call Dara' }).getByRole('button', { name: 'Undo' }).click();
  await expect(cell(10).getByText('Call Dara')).toBeVisible();

  // Links open the record; the week view shows the same items.
  await cell(20).getByRole('link', { name: /Robot arms/ }).click();
  await expect(page).toHaveURL(new RegExp(`/deals/${deal.id}$`));
  await page.goto('/calendar');
  await page.getByRole('tab', { name: 'Week' }).click();
  await expect(page.getByRole('heading', { level: 2 })).toContainText('–');
  await page.getByRole('tab', { name: 'Month' }).click();
  await page.getByRole('tab', { name: 'Deals', exact: true }).click();
  await expect(cell(10).getByText('Call Dara')).toHaveCount(0);
  await expect(cell(20).getByText('Robot arms')).toBeVisible();
});

test('calendar on a phone: an agenda of the month', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUp(page);
  await api(page, 'POST', '/activities', { kind: 'meeting', subject: 'Showroom visit', dueAt: new Date(`${dayOfMonth(15)}T14:00:00`).toISOString() });
  await page.goto('/calendar');
  await expect(page.getByRole('link', { name: /Showroom visit/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('calendar: move an item with the keyboard only (grip button, Space, arrows, Space)', async ({ page }) => {
  await signUp(page);
  // A Monday–Friday this month, so "one day right" stays in the same week row whatever the month.
  const t = new Date();
  const d = [8, 9, 10, 11, 12, 13, 14].find((n) => { const w = new Date(t.getFullYear(), t.getMonth(), n).getDay(); return w >= 1 && w <= 5; })!;
  await api(page, 'POST', '/activities', { kind: 'call', subject: 'Keyboard call', dueAt: new Date(`${dayOfMonth(d)}T09:30:00`).toISOString() });
  await page.goto('/calendar');
  const cell = (n: number) => page.locator(`[data-day="${dayOfMonth(n)}"]`);
  await expect(cell(d).getByText('Keyboard call')).toBeVisible();
  await apiIdle(page);
  await page.getByRole('button', { name: 'Move Keyboard call' }).focus();
  for (const key of ['Space', 'ArrowRight', 'Space']) { await page.keyboard.press(key); await page.waitForTimeout(200); }
  await expect(page.getByText(/Moved “Keyboard call” to/)).toBeVisible();
  await expect(cell(d + 1).getByText('Keyboard call')).toBeVisible();
});
