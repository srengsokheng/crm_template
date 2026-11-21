import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('record history loads in pages ("Load more"), filtered on the server', async ({ page }) => {
  await signUp(page);
  const deal = await api(page, 'POST', '/deals', { title: 'Busy deal' });
  for (let i = 1; i <= 35; i++) await api(page, 'POST', '/notes', { entityType: 'deal', entityId: deal.id, body: `Call note number ${i}` });
  await page.goto(`/deals/${deal.id}`);
  const history = page.locator('section').filter({ hasText: /^History/ });
  await expect(history.getByText('Call note number 35')).toBeVisible();
  await expect(history.getByText('Call note number 5', { exact: true })).toHaveCount(0); // beyond the first page (30 items)
  await history.getByRole('button', { name: 'Load more' }).click();
  await expect(history.getByText('Call note number 5', { exact: true })).toBeVisible();
  await expect(history.getByText('Call note number 1', { exact: true })).toBeVisible();
  // Filter: only changes (the note pages don't hide them).
  await history.getByRole('tab', { name: 'Changes' }).click();
  await expect(history.getByText('Call note number 35')).toHaveCount(0);
  await expect(history.getByText(/created/i).first()).toBeVisible();
});

test('recycle bin pages with "Load more"', async ({ page }) => {
  await signUp(page);
  for (let i = 1; i <= 55; i++) {
    const c = await api(page, 'POST', '/contacts', { firstName: `Old${i}` });
    await api(page, 'DELETE', `/contacts/${c.id}`);
  }
  await page.goto('/settings/recycle-bin');
  const bin = page.getByRole('list', { name: 'Deleted records' });
  await expect(bin.getByRole('listitem')).toHaveCount(50);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(bin.getByRole('listitem')).toHaveCount(55);
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
});

test('kanban column shows 50 cards, then "Show more" loads the rest of that column', async ({ page }) => {
  await signUp(page);
  for (let i = 1; i <= 53; i++) await api(page, 'POST', '/deals', { title: `Bulk deal ${i}` });
  await page.goto('/deals');
  const col = page.getByRole('region', { name: 'New stage' });
  await expect(col.getByText('Bulk deal 53', { exact: true })).toBeVisible();
  await expect(col.getByText('Bulk deal 1', { exact: true })).toHaveCount(0);
  const more = col.getByRole('button', { name: /Show more in New \(3 not shown\)/ });
  await expect(more).toContainText('Show 3 more');
  await more.click();
  await expect(col.getByText('Bulk deal 1', { exact: true })).toBeVisible();
  await expect(col.getByRole('button', { name: /Show more/ })).toHaveCount(0);
});

test('a company with many deals: 10 shown, total in the title, "Load more" pages the rest', async ({ page }) => {
  await signUp(page);
  const co = await api(page, 'POST', '/companies', { name: 'Busy Co' });
  for (let i = 1; i <= 13; i++) await api(page, 'POST', '/deals', { title: `Order ${i}`, companyId: co.id, amount: '100' });
  await page.goto(`/companies/${co.id}`);
  const card = page.locator('section').filter({ hasText: /^Deals \(13\)/ });
  await expect(card.getByText('Order 13', { exact: true })).toBeVisible();
  await expect(card.getByText('Order 3', { exact: true })).toHaveCount(0);
  await expect(card).toContainText('Open pipeline (13)');
  await expect(card).toContainText('$1,300');
  await card.getByRole('button', { name: /Load more/ }).click();
  await expect(card.getByText('Order 1', { exact: true })).toBeVisible();
  await expect(card.getByRole('link')).toHaveCount(13);
  await expect(card.getByRole('button', { name: /Load more/ })).toHaveCount(0);
});
