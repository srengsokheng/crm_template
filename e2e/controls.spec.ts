import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('shared controls: tabs and segmented move with the arrow keys; radio groups and switches work', async ({ page }) => {
  await signUp(page);
  await page.goto('/activities');
  const today = page.getByRole('tab', { name: /^Today/ });
  await today.click();
  await expect(today).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  const upcoming = page.getByRole('tab', { name: /^Upcoming/ });
  await expect(upcoming).toHaveAttribute('aria-selected', 'true');
  await expect(upcoming).toBeFocused();
  await expect(page).toHaveURL(/bucket=upcoming/);

  await page.goto('/dev/components');
  const board = page.getByRole('tab', { name: 'Board' }).first();
  await board.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'List' }).first()).toHaveAttribute('aria-selected', 'true');
  // Only the selected tab is in the Tab order.
  await expect(page.getByRole('tab', { name: 'Board' }).first()).toHaveAttribute('tabindex', '-1');

  const sw = page.getByRole('switch', { name: /Email reminders/ });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await page.getByText('Email reminders').click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');

  const group = page.getByRole('group', { name: 'When a row matches an existing contact' });
  await group.getByRole('radio', { name: /Update the existing contact/ }).check();
  await expect(group.getByRole('radio', { name: /Update the existing contact/ })).toBeChecked();
  await expect(group.getByRole('radio', { name: /Create a new contact anyway/ })).toBeDisabled();
});

test('settings that save at once use switches: list options and automation rules', async ({ page }) => {
  await signUp(page);
  const m = await api(page, 'GET', '/meta');
  const source = m.dictionaries.find((d: any) => d.kind === 'lead_source' && d.isActive);
  await page.goto('/settings/lists');
  const sw = page.getByRole('switch', { name: `${source.label} in use` });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(page.getByText('Option hidden from new records')).toBeVisible();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  expect((await api(page, 'GET', '/meta')).dictionaries.find((d: any) => d.id === source.id).isActive).toBe(false);

  const pipe = m.pipelines.find((p: any) => p.entityType === 'deal');
  const rule = await api(page, 'POST', '/automation-rules', { entityType: 'deal', pipelineId: pipe.id, trigger: 'created', action: 'add_note', config: { text: 'Hi' } });
  await page.goto('/settings/automation');
  const ruleSw = page.getByRole('switch', { name: 'Rule 1 on' });
  await expect(ruleSw).toHaveAttribute('aria-checked', 'true');
  await ruleSw.click();
  await expect(ruleSw).toHaveAttribute('aria-checked', 'false');
  const rules = await api(page, 'GET', `/automation-rules?pipelineId=${pipe.id}`);
  expect(rules.data.find((r: any) => r.id === rule.id).isEnabled).toBe(false);
});
