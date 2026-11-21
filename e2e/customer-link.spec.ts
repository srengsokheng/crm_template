import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('customer link: the customer opens the quote without signing in, accepts it with their name; the team sees it', async ({ page, browser, baseURL }) => {
  await signUp(page);
  const deal = await api(page, 'POST', '/deals', { title: 'Robot arms for Umbrella Foods' });
  await api(page, 'PUT', `/deals/${deal.id}/line-items`, { items: [{ name: 'Robot arm X2', unitPrice: '1250.50', quantity: 2, unit: 'pcs' }] });
  const q = await api(page, 'POST', `/deals/${deal.id}/documents`, { kind: 'quote' });
  await api(page, 'POST', `/documents/${q.id}/status`, { status: 'sent' });

  // The team's page shows the link to send (also in the email).
  await page.goto(`/documents/${q.id}`);
  await expect(page.getByText('Not opened yet.')).toBeVisible();
  const link = await page.getByLabel('Customer link').inputValue();
  expect(link).toMatch(/\/d\/[A-Za-z0-9_-]{32}$/);

  // The customer, in another browser with no account.
  const ctx = await browser.newContext();
  const customer = await ctx.newPage();
  await customer.goto(link.replace(/^https?:\/\/[^/]+/, baseURL!));
  await expect(customer.getByRole('heading', { name: /^Quote Q-\d+$/ })).toBeVisible();
  await expect(customer.getByText('Robot arm X2')).toBeVisible();
  await expect(customer.getByText('$2,501').first()).toBeVisible();
  await customer.getByRole('button', { name: 'Accept quote' }).click();
  const dlg = customer.getByRole('dialog');
  await expect(dlg.getByRole('button', { name: 'Accept' })).toBeDisabled();
  await dlg.getByLabel('Your full name').fill('Carlos Oliveira');
  await dlg.getByLabel('Note (optional)').fill('PO 4471, deliver before Jan 15');
  await dlg.getByRole('button', { name: 'Accept' }).click();
  await expect(customer.getByText('Thank you — the quote is accepted')).toBeVisible();
  await expect(customer.getByText(/Accepted by Carlos Oliveira/)).toBeVisible();
  await expect(customer.getByRole('button', { name: 'Accept quote' })).toHaveCount(0);
  await ctx.close();

  // The team: accepted, by whom, with the note; told in notifications; written in the deal's history.
  await page.reload();
  await expect(page.getByText(/Accepted online by/)).toContainText('Carlos Oliveira');
  await expect(page.getByText('Note: “PO 4471, deliver before Jan 15”.')).toBeVisible();
  await page.getByRole('button', { name: 'Notifications' }).click();
  await expect(page.getByText(/Carlos Oliveira accepted Quote Q-\d+/)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto(`/deals/${deal.id}`);
  await expect(page.getByText(/Quote Q-\d+ accepted online by Carlos Oliveira — “PO 4471, deliver before Jan 15”/)).toBeVisible();
  await expect(page.getByText(/The customer opened quote Q-\d+ from the link/)).toBeVisible();
});
