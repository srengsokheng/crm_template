import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('bottom navigation, more sheet, and record page work on a phone', async ({ page }) => {
    await signUp(page);
    const d = await api(page, 'POST', '/deals', { title: 'Phone deal', amount: '500' });
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).last()).toBeVisible();
    await expect(page.locator('aside')).toBeHidden();
    await page.getByRole('navigation', { name: 'Main navigation' }).last().getByRole('link', { name: 'Deals' }).click();
    await expect(page.getByRole('heading', { name: 'Deals' })).toBeVisible();
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('dialog', { name: 'More navigation' }).getByRole('link', { name: 'Reports' }).click();
    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
    await page.goto(`/deals/${d.id}`);
    await expect(page.getByRole('heading', { name: 'Phone deal' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('mobile import', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('CSV import mapping and review fit a phone', async ({ page }) => {
    await signUp(page);
    await page.goto('/import/contact');
    await page.getByLabel('CSV file').setInputFiles({ name: 'p.csv', mimeType: 'text/csv', buffer: Buffer.from(['First name,Last name,Email', 'Ada,Lovelace,ada@example.com'].join('\n')) });
    await expect(page.getByLabel('Import column Email as')).toHaveValue('email');
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Review import' }).click();
    await page.getByRole('button', { name: 'Import 1 row' }).click();
    await expect(page.getByText('Import finished')).toBeVisible({ timeout: 20_000 });
    overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('tablet', () => {
  test.use({ viewport: { width: 834, height: 1112 } });
  test('collapsed icon rail navigation', async ({ page }) => {
    await signUp(page);
    await expect(page.locator('aside')).toBeVisible();
    await page.locator('aside').getByTitle('Contacts').click();
    await expect(page.getByRole('heading', { name: 'Contacts', exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
