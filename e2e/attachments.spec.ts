import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('attach, download and delete a file on a deal', async ({ page }) => {
  await signUp(page);
  const d = await api(page, 'POST', '/deals', { title: 'Deal with files' });
  await page.goto(`/deals/${d.id}`);
  const card = page.locator('section').filter({ hasText: /^Files \(/ });
  await expect(card.getByText('No files yet')).toBeVisible();

  await card.getByLabel('Add files').setInputFiles({ name: 'Quote v2.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 quote') });
  await expect(page.getByText('File added')).toBeVisible();
  await expect(card.getByRole('link', { name: 'Quote v2.pdf', exact: true })).toBeVisible();
  await expect(card.getByText(/14 B/)).toBeVisible();
  await expect(page.getByText('Added file Quote v2.pdf')).toBeVisible(); // timeline

  const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('link', { name: 'Download Quote v2.pdf' }).click()]);
  expect(download.suggestedFilename()).toBe('Quote v2.pdf');
  expect(await readFile(await download.path(), 'utf8')).toBe('%PDF-1.4 quote');

  await card.getByRole('button', { name: 'Delete Quote v2.pdf' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete file' }).click();
  await expect(page.getByText('File deleted')).toBeVisible();
  await expect(card.getByText('No files yet')).toBeVisible();
});
