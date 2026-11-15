import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

const CSV = [
  'Full name,Email,Mobile,Company,Job title',
  'Old Contact,dup@example.com,+1 555 0200,,CTO',
  'Ada Lovelace,ada@example.com,+44 20 7946 0001,Analytical Engines,Head of Engineering',
  'Grace Hopper,grace@example.com,,,Rear Admiral',
  'Bad Email,not-an-email,,,',
].join('\n');

test('import contacts: upload, map, review, import, report, failed rows, undo', async ({ page }) => {
  await signUp(page);
  const existing = await api(page, 'POST', '/contacts', { firstName: 'Old', lastName: 'Contact', jobTitle: 'Old title', methods: [{ kind: 'email', value: 'dup@example.com' }] });

  await page.goto('/contacts');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('heading', { name: 'Import contacts' })).toBeVisible();
  await page.getByLabel('CSV file').setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });

  // Mapping was suggested from the headers.
  await expect(page.getByText('5 of 5 columns will be imported')).toBeVisible();
  await expect(page.getByLabel('Import column Mobile as')).toHaveValue('phone');
  await expect(page.getByLabel('Import column Full name as')).toHaveValue('fullName');
  await page.getByLabel('Update the existing contact').check();
  await page.getByRole('button', { name: 'Review import' }).click();

  // Review: counts and the problem row, nothing written yet.
  await expect(page.getByText('New contacts')).toBeVisible();
  await expect(page.getByText('Rows with problems (1)')).toBeVisible();
  await expect(page.getByText('Email: Invalid email address ("not-an-email")').first()).toBeVisible();
  await expect(page.getByText(`Updates`).locator('..')).toContainText('1');
  await page.getByRole('button', { name: 'Import 3 rows' }).click();

  // Report.
  await expect(page.getByText('Import finished')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Created').locator('..')).toContainText('2');
  await expect(page.getByText('Rows not imported (1)')).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Failed rows (CSV)' }).click()]);
  expect(download.suggestedFilename()).toBe('people-errors.csv');
  const errorsCsv = await readFile(await download.path(), 'utf8');
  expect(errorsCsv).toContain('Full name,Email,Mobile,Company,Job title,Import error');
  expect(errorsCsv).toContain('Bad Email,not-an-email');

  // The existing contact was updated, with history saying where the change came from.
  await page.goto(`/contacts/${existing.id}`);
  await expect(page.getByText('CTO').first()).toBeVisible();
  await expect(page.getByText(/by import of people\.csv/).first()).toBeVisible();

  // Undo removes only the created contacts.
  await page.goBack();
  await page.getByRole('button', { name: 'Undo import' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Move to recycle bin' }).click();
  await expect(page.getByText('2 contacts moved to the recycle bin')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo import' })).toBeHidden();
  await page.goto('/contacts');
  await expect(page.getByText('1 total')).toBeVisible();
});

test('import history reopens a draft; bad files are explained', async ({ page }) => {
  await signUp(page);
  const up = await api(page, 'POST', '/imports', { entityType: 'company', fileName: 'orgs.csv', content: 'Company\nGlobex\n' });
  await page.goto('/import/company');
  await expect(page.getByRole('link', { name: /orgs\.csv/ })).toBeVisible();
  await page.getByRole('link', { name: /orgs\.csv/ }).click();
  await expect(page).toHaveURL(new RegExp(`/imports/${up.id}$`));
  await expect(page.getByText('1 of 1 columns will be imported')).toBeVisible();
  // A bad file is explained on the upload page.
  await page.goto('/import/company');
  await page.getByLabel('CSV file').setInputFiles({ name: 'orgs.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
  await expect(page.getByRole('alert')).toContainText('Choose a .csv file');
  await page.getByLabel('CSV file').setInputFiles({ name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.from('Company\n') });
  await expect(page.getByRole('alert')).toContainText('The file has a header row but no data rows');
});
