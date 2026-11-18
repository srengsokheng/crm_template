import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('KHQR: set up in Settings, the sent invoice shows a QR for the balance due, part payment updates it', async ({ page }) => {
  await signUp(page);
  // An invoice that has been sent.
  const deal = await api(page, 'POST', '/deals', { title: 'Robot arm for Umbrella Foods', currency: 'USD' });
  await api(page, 'PUT', `/deals/${deal.id}/line-items`, { items: [{ name: 'Robot arm X2', unitPrice: '1250.50', quantity: 1, unit: 'pcs' }] });
  const inv = await api(page, 'POST', `/deals/${deal.id}/documents`, { kind: 'invoice' });
  await api(page, 'POST', `/documents/${inv.id}/status`, { status: 'sent' });

  // Before setup, the admin is pointed to Settings.
  await page.goto(`/documents/${inv.id}`);
  await page.getByRole('link', { name: 'Set it up' }).click();
  await expect(page).toHaveURL(/\/settings\/documents$/);
  await page.getByRole('checkbox', { name: /Show a KHQR on sent invoices/ }).check();
  await page.getByLabel('Bakong account ID').fill('not an id');
  await page.getByLabel('Name the payer sees').fill('Acme Robotics');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Use the Bakong account ID, like name@aclb').first()).toBeVisible();
  await page.getByLabel('Bakong account ID').fill('sreng_sokheng@aclb');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();

  // The invoice shows the QR for the full amount.
  await page.goto(`/documents/${inv.id}`);
  const qr = page.getByRole('img', { name: 'KHQR to pay $1,250.50 to Acme Robotics' });
  await expect(qr).toBeVisible();
  await expect(page.getByText('(sreng_sokheng@aclb)')).toBeVisible();
  expect(await qr.locator('path').getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);

  // A part payment by KHQR: the QR now asks for what's left.
  await page.getByRole('button', { name: 'Record payment' }).first().click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Amount').fill('1000');
  await dlg.getByLabel('Method').fill('KHQR');
  await dlg.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText(/Payment recorded — \$250\.50 still due/)).toBeVisible();
  await expect(page.getByRole('img', { name: 'KHQR to pay $250.50 to Acme Robotics' })).toBeVisible();

  // The PDF carries it too.
  const pdf = await page.request.get(`/api/v1/documents/${inv.id}/pdf`);
  expect((await pdf.body()).toString('latin1')).toContain('PAY WITH KHQR');
});
