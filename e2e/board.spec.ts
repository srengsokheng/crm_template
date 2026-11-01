import { expect, test } from '@playwright/test';
import { api, drag, meta, signUp } from './helpers.ts';

test('kanban: drag between stages, required-field prompt, lost reason, undo', async ({ page }) => {
  await signUp(page);
  const m = await meta(page);
  const pipe = m.pipelines.find((p: any) => p.entityType === 'deal');
  const stage = (n: string) => pipe.stages.find((s: any) => s.name === n);
  await api(page, 'POST', '/fields', { entityType: 'deal', label: 'Segment', type: 'select', options: [{ id: 'smb', label: 'SMB' }, { id: 'ent', label: 'Enterprise' }], required: 'from_stage', requiredStageIds: [stage('Proposal').id] });
  await api(page, 'POST', '/deals', { title: 'Drag me', amount: '1200' });
  await api(page, 'POST', '/deals', { title: 'Lose me', amount: '800', stageId: stage('Qualified').id });
  await page.goto('/deals');
  const col = (n: string) => page.getByRole('region', { name: `${n} stage` });
  await expect(col('New').getByText('Drag me')).toBeVisible();
  await expect(col('New')).toContainText('$1.2K');

  // New → Qualified
  await drag(page, col('New').getByText('Drag me'), col('Qualified'));
  await expect(page.getByText('Moved to Qualified: Drag me')).toBeVisible();
  await expect(col('Qualified').getByText('Drag me')).toBeVisible();

  // Qualified → Proposal needs the Segment field
  await drag(page, col('Qualified').getByText('Drag me'), col('Proposal'));
  const dlg = page.getByRole('dialog', { name: 'A few details are needed' });
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('Segment').selectOption('ent');
  await dlg.getByRole('button', { name: 'Save and move' }).click();
  await expect(col('Proposal').getByText('Drag me')).toBeVisible();

  // Undo the last move
  await page.getByText('Moved to Proposal: Drag me').waitFor();
  await page.getByRole('button', { name: 'Undo' }).last().click();
  await expect(col('Qualified').getByText('Drag me')).toBeVisible();

  // Drag to the Lost drop zone → reason dialog
  const card = col('Qualified').getByText('Lose me');
  const a = (await card.boundingBox())!;
  await page.mouse.move(a.x + 20, a.y + 10); await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 40, { steps: 5 });
  const lostZone = page.getByText('Lost', { exact: true }).last();
  const z = (await lostZone.boundingBox())!;
  await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2, { steps: 12 });
  await page.mouse.up();
  const reason = page.getByRole('dialog', { name: 'Mark deal as lost' });
  await reason.getByLabel('Reason').selectOption({ label: 'Price too high' });
  await reason.getByRole('button', { name: 'Mark as lost' }).click();
  await expect(page.getByText('Marked as lost: Lose me')).toBeVisible();
  await expect(col('Qualified').getByText('Lose me')).toHaveCount(0);
  const deals = await api(page, 'GET', '/deals?status=lost');
  expect(deals.data[0]).toMatchObject({ title: 'Lose me' });
});
