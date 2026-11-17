import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('website chat is live both ways: "typing…" on each side, replies arrive without waiting for polling', async ({ page, context, baseURL }) => {
  await signUp(page);
  const ch = await api(page, 'POST', '/channels', { kind: 'webchat', name: 'Acme help' });

  const site = await context.newPage();
  await site.setContent(`<!doctype html><html><body><script src="${baseURL}/widget.js" data-key="${ch.publicKey}" async></script></body></html>`);
  await site.getByRole('button', { name: 'Open chat' }).click();
  await site.getByPlaceholder('Your name (optional)').fill('Grace');
  await site.getByLabel('Message').fill('Do you deliver on Sundays?');
  await site.getByLabel('Message').press('Enter');
  await expect(site.getByText('Do you deliver on Sundays?')).toBeVisible();

  const convs = await api(page, 'GET', '/inbox/conversations');
  await page.goto(`/inbox/${convs.data[0].id}`);
  await expect(page.locator('ol').getByText('Do you deliver on Sundays?')).toBeVisible();

  // The visitor types: the agent sees it.
  await site.getByLabel('Message').fill('Also Saturdays');
  await expect(page.getByText('Grace is typing…')).toBeVisible({ timeout: 5000 });

  // The agent types: the visitor sees it with the agent's first name.
  await page.getByLabel('Reply').fill('Yes');
  await expect(site.getByText('Ada is typing…')).toBeVisible({ timeout: 5000 });

  // The reply reaches the widget through the live connection (polling would take 30 s while it's up).
  await page.getByLabel('Reply').fill('Yes, every day 9am–5pm.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(site.getByText('Yes, every day 9am–5pm.')).toBeVisible({ timeout: 3000 });
  await expect(site.getByText('Ada is typing…')).toBeHidden();
});
