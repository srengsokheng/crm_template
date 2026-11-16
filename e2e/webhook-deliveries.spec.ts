import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('webhook rule: send a test and see it in the delivery log', async ({ page }) => {
  await signUp(page);
  await api(page, 'GET', '/settings/webhooks'); // creates the signing secret
  await api(page, 'PUT', '/settings/webhooks', { allowedHosts: ['hooks.example.invalid'] }); // .invalid never resolves (RFC 2606)
  const meta = await api(page, 'GET', '/meta');
  const pipeline = meta.pipelines.find((p: any) => p.entityType === 'deal');
  await api(page, 'POST', '/automation-rules', { entityType: 'deal', pipelineId: pipeline.id, trigger: 'created', action: 'webhook', config: { url: 'https://hooks.example.invalid/crm' } });

  await page.goto('/settings/automation');
  await page.getByRole('button', { name: /call hooks\.example\.invalid\/crm/ }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Recent deliveries')).toBeVisible();
  await expect(drawer.getByText('No deliveries yet.')).toBeVisible();
  await drawer.getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByText('Can’t resolve hooks.example.invalid').first()).toBeVisible();
  await expect(drawer.getByText('No answer')).toBeVisible();
  await expect(drawer.getByText('Test', { exact: true })).toBeVisible();
});
