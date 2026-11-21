import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('merge duplicate contacts: suggestion, keep choice, values, result and old link', async ({ page }) => {
  await signUp(page);
  const original = await api(page, 'POST', '/contacts', { firstName: 'Hank', lastName: 'Scorpio', jobTitle: 'CEO', methods: [{ kind: 'email', value: 'hank@globex.example.com' }] });
  await api(page, 'POST', '/deals', { title: 'Globex robots', contactIds: [original.id] });
  const dup = await api(page, 'POST', '/contacts', { firstName: 'Hank', lastName: 'S.', methods: [{ kind: 'email', value: 'HANK@globex.example.com' }, { kind: 'phone', value: '+1 555 0111' }] });
  await api(page, 'POST', '/notes', { entityType: 'contact', entityId: dup.id, body: 'Met at the expo' });

  await page.goto(`/contacts/${dup.id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Merge with…' }).click();
  const dlg = page.getByRole('dialog');
  // Suggested by the shared email; picking it opens the comparison.
  await dlg.getByRole('button', { name: /Hank Scorpio.*same email/ }).click();
  // The record with more attached (the original, with a deal) is kept by default.
  await expect(dlg.getByRole('group', { name: 'Which contact do you keep?' }).getByRole('radio', { name: /Hank Scorpio/ })).toBeChecked();
  await expect(dlg.getByText('CEO')).toBeVisible();
  // Take the duplicate's name instead.
  await dlg.getByRole('radiogroup', { name: 'Name' }).getByRole('radio', { name: 'Hank S.' }).click();
  await dlg.getByRole('button', { name: /^Merge into/ }).click();

  await expect(page).toHaveURL(new RegExp(`/contacts/${original.id}$`));
  await expect(page.getByText('Contacts merged')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Hank S.' })).toBeVisible();
  await expect(page.getByText('+1 555 0111')).toBeVisible();
  await expect(page.getByRole('link', { name: /^Globex robots New/ })).toBeVisible(); // the Deals card (history also links it)
  await expect(page.getByText('Met at the expo')).toBeVisible();
  await expect(page.getByText(/Merged with Hank S\. \(#\d+\) — took Last name/)).toBeVisible();

  // The duplicate's old link explains and leads to the kept record.
  await page.goto(`/contacts/${dup.id}`);
  await expect(page.getByText('This record was merged')).toBeVisible();
  await page.getByRole('button', { name: 'Open the merged record' }).click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${original.id}$`));
  await page.goto('/contacts');
  await expect(page.getByText('1 total')).toBeVisible();
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('merge companies on a phone', async ({ page }) => {
    await signUp(page);
    const keep = await api(page, 'POST', '/companies', { name: 'Initech Logistics', methods: [{ kind: 'website', value: 'www.initech.example.com' }] });
    await api(page, 'POST', '/companies', { name: 'Initech', methods: [{ kind: 'website', value: 'https://initech.example.com' }] });
    await page.goto(`/companies/${keep.id}`);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Merge with…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^Initech same website/ }).click();
    await expect(page.getByRole('dialog').getByText('Which company do you keep?')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.getByRole('dialog').getByRole('button', { name: /^Merge into/ }).click();
    await expect(page.getByText('Companies merged')).toBeVisible();
    await expect(page.getByText('initech.example.com')).toBeVisible();
  });
});
