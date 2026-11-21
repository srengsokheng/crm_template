import { expect, test } from '@playwright/test';
import { signUp } from './helpers.ts';

test('admins see where attachments are stored and whether uploads are virus-scanned', async ({ page }) => {
  await signUp(page);
  await page.goto('/settings/workspace');
  const card = page.locator('section').filter({ has: page.getByText('File storage', { exact: true }) });
  await expect(card.getByText('No virus scanning')).toBeVisible(); // the test server has no ClamAV configured
  await expect(card.getByText(/Attachments are stored on the server disk, up to 10 MB per file\./)).toBeVisible();
  await expect(card.getByText(/set CLAMAV_HOST/)).toBeVisible();
});
