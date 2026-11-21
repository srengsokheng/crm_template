import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('find duplicate leads (same email, similar name), merge three at once choosing a value from the third', async ({ page }) => {
  await signUp(page);
  const a = await api(page, 'POST', '/leads', { title: 'Web form', firstName: 'Kim', lastName: 'Lee', methods: [{ kind: 'email', value: 'kim@lee.test' }] });
  const b = await api(page, 'POST', '/leads', { title: 'Phone call', firstName: 'Kim', lastName: 'Lee', methods: [{ kind: 'email', value: 'kim@lee.test' }] });
  const c = await api(page, 'POST', '/leads', { title: 'Trade show', firstName: 'Kimberly', lastName: 'Lee', companyName: 'Lee Logistics' });

  await page.goto('/leads?view=list');
  await page.getByRole('button', { name: 'Find duplicates' }).click();
  await expect(page.getByRole('heading', { name: 'Find duplicates' })).toBeVisible();
  await expect(page.getByText('Same email: kim@lee.test')).toBeVisible();
  await page.getByRole('button', { name: 'Merge…' }).first().click();

  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText('Which lead do you keep?')).toBeVisible();
  // Add the third lead (similar name, different email).
  await dlg.getByRole('button', { name: /Add another lead/ }).click();
  await page.keyboard.type('Trade');
  await page.getByRole('option', { name: /Trade show/ }).click();
  await expect(dlg.getByText(new RegExp(`^#${c.id} · added`))).toBeVisible();

  // Company name only exists on the third lead → taken automatically; the title: choose the third lead's.
  const company = dlg.getByRole('radiogroup', { name: 'Company name' });
  await expect(company.getByRole('radio', { checked: true })).toContainText('Lee Logistics');
  await dlg.getByRole('radiogroup', { name: 'Lead name' }).getByRole('radio', { name: /Trade show/ }).click();
  await dlg.getByRole('button', { name: /^Merge 3 into/ }).click();
  await expect(page.getByText('3 leads merged')).toBeVisible();

  // The duplicates list is empty now, and the kept lead has the chosen values.
  await expect(page.getByText('No duplicate leads found')).toBeVisible();
  const kept = [a, b, c].map((x) => x.id);
  const leads = await api(page, 'GET', '/leads?pageSize=50');
  expect(leads.data).toHaveLength(1);
  expect(kept).toContain(leads.data[0].id);
  await page.goto(`/leads/${leads.data[0].id}`);
  await expect(page.getByRole('heading', { name: 'Trade show' })).toBeVisible();
  await expect(page.getByText('Lee Logistics').first()).toBeVisible();
  // The removed leads point to the kept one.
  const gone = kept.find((id) => id !== leads.data[0].id)!;
  await page.goto(`/leads/${gone}`);
  await expect(page.getByText('This record was merged')).toBeVisible();
  await page.getByRole('button', { name: 'Open the merged record' }).click();
  await expect(page.getByRole('heading', { name: 'Trade show' })).toBeVisible();
});
