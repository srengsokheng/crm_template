import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('signing a quote: required by the setting, drawn by the customer, shown to the team and on the PDF', async ({ page, browser, baseURL }) => {
  await signUp(page);
  await page.goto('/settings/documents');
  await page.getByLabel('Customers must sign (draw their signature) to accept a quote online').check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();

  const deal = await api(page, 'POST', '/deals', { title: 'Robot arms' });
  await api(page, 'PUT', `/deals/${deal.id}/line-items`, { items: [{ name: 'Robot arm', unitPrice: '1250', quantity: 2, unit: 'pcs' }] });
  const q = await api(page, 'POST', `/deals/${deal.id}/documents`, { kind: 'quote' });
  const sent = await api(page, 'POST', `/documents/${q.id}/status`, { status: 'sent' });

  const ctx = await browser.newContext();
  const customer = await ctx.newPage();
  await customer.goto(sent.customerUrl.replace(/^https?:\/\/[^/]+/, baseURL!));
  await customer.getByRole('button', { name: 'Accept quote' }).click();
  const dialog = customer.getByRole('dialog');
  await dialog.getByLabel('Your full name').fill('Dara Sok');
  const accept = dialog.getByRole('button', { name: 'Accept', exact: true });
  await expect(accept).toBeDisabled(); // no signature yet

  // Draw two strokes on the pad.
  const pad = dialog.getByTestId('signature-pad');
  const box = (await pad.boundingBox())!;
  const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
  await customer.mouse.move(...at(0.1, 0.7));
  await customer.mouse.down();
  for (const [fx, fy] of [[0.2, 0.3], [0.3, 0.75], [0.4, 0.35], [0.5, 0.7]]) await customer.mouse.move(...at(fx, fy), { steps: 4 });
  await customer.mouse.up();
  await customer.mouse.move(...at(0.55, 0.6));
  await customer.mouse.down();
  await customer.mouse.move(...at(0.85, 0.55), { steps: 6 });
  await customer.mouse.up();
  await expect(dialog.getByRole('button', { name: 'Clear' })).toBeVisible();
  await expect(accept).toBeEnabled();
  await accept.click();
  await expect(customer.getByText('Thank you — the quote is accepted')).toBeVisible();
  await expect(customer.getByText(/^Signed by Dara Sok on /)).toBeVisible();
  await expect(customer.getByRole('img', { name: 'Signature' })).toBeVisible();
  await ctx.close();

  // The team sees the signature, and it's on the PDF.
  await page.goto(`/documents/${q.id}`);
  await expect(page.getByRole('img', { name: 'Signature of Dara Sok' })).toBeVisible();
  await expect(page.getByText(/^Signed online from IP /)).toBeVisible();
  const pdf = await page.request.get(`/api/v1/documents/${q.id}/pdf`);
  expect(pdf.ok()).toBe(true);
  const raw = (await pdf.body()).toString('latin1');
  expect(raw).toContain(' 1 J 1 j '); // the drawn strokes
  expect(raw.match(/ 1 J 1 j /g)!.length).toBe(2);
});
