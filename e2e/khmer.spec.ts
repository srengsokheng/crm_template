import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('Khmer for customers: the setting turns the quote page, accepting, and the website chat into Khmer', async ({ page, browser, baseURL }) => {
  await signUp(page);
  await page.goto('/settings/documents');
  await page.getByLabel('Language for customers').selectOption('km');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();

  const deal = await api(page, 'POST', '/deals', { title: 'Robot arms' });
  await api(page, 'PUT', `/deals/${deal.id}/line-items`, { items: [{ name: 'ដៃរ៉ូបូត X2', unitPrice: '1250.50', quantity: 2, unit: 'pcs' }] });
  const q = await api(page, 'POST', `/deals/${deal.id}/documents`, { kind: 'quote' });
  const sent = await api(page, 'POST', `/documents/${q.id}/status`, { status: 'sent' });

  // The customer's page, in Khmer.
  const ctx = await browser.newContext();
  const customer = await ctx.newPage();
  await customer.goto(sent.customerUrl.replace(/^https?:\/\/[^/]+/, baseURL!));
  await expect(customer.getByRole('heading', { name: /^សម្រង់តម្លៃ Q-\d+$/ })).toBeVisible();
  await expect(customer.locator('main')).toHaveAttribute('lang', 'km');
  await expect(customer.getByText('ទាញយក PDF')).toBeVisible();
  await customer.getByRole('button', { name: 'ទទួលយកសម្រង់តម្លៃ' }).click();
  await customer.getByLabel('ឈ្មោះពេញរបស់អ្នក').fill('សុខ ដារា');
  await customer.getByRole('dialog').getByRole('button', { name: 'ទទួលយក', exact: true }).click();
  await expect(customer.getByText('សូមអរគុណ — សម្រង់តម្លៃត្រូវបានទទួលយក')).toBeVisible();
  await expect(customer.getByText(/ទទួលយកដោយ សុខ ដារា/)).toBeVisible();

  // The website chat on the customer's site speaks Khmer too.
  const ch = await api(page, 'POST', '/channels', { kind: 'webchat', name: 'Acme' });
  const site = await ctx.newPage();
  await site.setContent(`<!doctype html><html><body><script src="${baseURL}/widget.js" data-key="${ch.publicKey}" async></script></body></html>`);
  await site.getByRole('button', { name: 'បើកការជជែក' }).click();
  await expect(site.getByPlaceholder('សរសេរសារ…')).toBeVisible();
  await expect(site.getByRole('button', { name: 'ផ្ញើ' })).toBeVisible();
  await ctx.close();

  // The team's own screens stay in English.
  await page.goto(`/documents/${q.id}`);
  await expect(page.getByText(/Accepted online by/)).toBeVisible();
});
