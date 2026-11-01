import { expect, test } from '@playwright/test';
import { signUp } from './helpers.ts';

test('lead → note & activity → convert → deal → products → won → dashboard', async ({ page }) => {
  await signUp(page);
  // Create a lead from the global "New" menu
  await page.getByRole('button', { name: 'Create new' }).click();
  await page.getByRole('menuitem', { name: 'Lead' }).click();
  const drawer = page.getByRole('dialog', { name: 'New lead' });
  await drawer.getByLabel('First name').fill('Alice');
  await drawer.getByLabel('Last name').fill('Tester');
  await drawer.getByLabel('Company').fill('Acme Robotics');
  await drawer.getByLabel('Email').fill('alice@acme.example.com');
  await drawer.getByLabel('Estimated value').fill('15000');
  await drawer.getByRole('button', { name: 'Create lead' }).click();
  await expect(page.getByRole('heading', { name: 'Acme Robotics' })).toBeVisible();

  // Timeline: note + activity
  await page.getByRole('textbox', { name: 'Note', exact: true }).fill('Wants three robotic arms');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('Wants three robotic arms')).toBeVisible();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('textbox', { name: 'Subject' }).fill('Call Alice to confirm requirements');
  await page.getByRole('button', { name: 'Schedule' }).click();
  await expect(page.getByRole('button', { name: 'Complete Call Alice to confirm requirements' })).toBeVisible();

  // Move stage via the stage bar
  await page.getByRole('listitem').filter({ hasText: 'Qualified' }).first().click();
  await expect(page.getByText(/Moved to Qualified/)).toBeVisible();

  // Convert
  await page.getByRole('button', { name: 'Convert' }).click();
  const dlg = page.getByRole('dialog', { name: 'Convert lead' });
  await expect(dlg.getByText('Create new Alice Tester')).toBeVisible();
  await dlg.getByRole('button', { name: 'Convert' }).click();
  await expect(page).toHaveURL(/\/deals\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Acme Robotics' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Alice Tester' })).toBeVisible();
  // The lead's open activity followed it
  await expect(page.getByRole('button', { name: 'Complete Call Alice to confirm requirements' })).toBeVisible();

  // Products: add two rows, amount recalculates
  await page.getByRole('button', { name: 'Add', exact: true }).last().click();
  await page.getByRole('button', { name: 'Search products or type a name' }).first().click();
  await page.getByRole('textbox', { name: 'Search' }).fill('Robotic Arm X1');
  await page.getByRole('button', { name: 'Create “Robotic Arm X1”' }).click();
  await page.getByLabel('Qty').first().fill('3');
  await page.getByLabel('Unit price').first().fill('4500');
  await page.getByRole('button', { name: 'Save products' }).click();
  await expect(page.getByText('Products saved')).toBeVisible();
  await expect(page.getByText('$13,500').first()).toBeVisible();

  // Win
  await page.getByRole('button', { name: 'Won' }).click();
  await expect(page.getByText(/Won: Acme Robotics/)).toBeVisible();
  await expect(page.getByText(/^Won /).first()).toBeVisible();

  // Dashboard reflects it
  await page.getByRole('link', { name: 'Home' }).first().click();
  await expect(page.getByText('Won this month')).toBeVisible();
  await expect(page.locator('text=$15K').first()).toBeVisible();
});
