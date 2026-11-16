import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('website chat: a visitor writes from another site, the team replies from the Inbox, the visitor sees it', async ({ page, context, baseURL }) => {
  await signUp(page);
  // Settings → Channels: add the website chat and read its embed code.
  await page.goto('/settings/channels');
  await expect(page.getByText('No channels yet')).toBeVisible();
  await page.getByRole('button', { name: 'Website chat' }).click();
  await page.getByLabel('Name shown to visitors').fill('Acme help');
  await page.getByRole('dialog').getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Website chat added')).toBeVisible();
  const snippet = (await page.locator('code').first().textContent())!;
  expect(snippet).toContain(`${baseURL}/widget.js`);

  // The inbox starts empty.
  await page.goto('/inbox');
  await expect(page.getByText('No open conversations')).toBeVisible();

  // A customer's website (a blank page on another origin) embeds the widget.
  const site = await context.newPage();
  await site.setContent(`<!doctype html><html><body><h1>Shop</h1>${snippet}</body></html>`);
  await site.getByRole('button', { name: 'Open chat' }).click();
  await expect(site.getByText('Hi! How can we help?')).toBeVisible();
  await site.getByPlaceholder('Your name (optional)').fill('Grace');
  await site.getByLabel('Message').fill('Do you deliver on Sundays?');
  await site.getByLabel('Message').press('Enter');
  await expect(site.getByText('Do you deliver on Sundays?')).toBeVisible();

  // The team sees it (sidebar badge, list), opens it and replies.
  const list = page.getByRole('complementary', { name: 'Conversations' });
  await expect(list.getByRole('link', { name: /Grace/ })).toBeVisible({ timeout: 10_000 }); // the list refreshes by itself
  await page.reload();
  await expect(page.getByRole('complementary', { name: 'Main navigation' }).getByRole('link', { name: /Inbox/ })).toContainText('1');
  await list.getByRole('link', { name: /Grace/ }).click();
  await expect(page.getByRole('heading', { name: 'Grace' })).toBeVisible();
  await expect(page.locator('ol').getByText('Do you deliver on Sundays?')).toBeVisible();
  await page.getByLabel('Reply').fill('Yes, 9am–5pm.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('ol').getByText('Yes, 9am–5pm.')).toBeVisible();
  await expect(page.getByLabel('Assignee')).toHaveValue(/\d+/); // replying took the conversation

  // The visitor's widget shows the reply with the agent's first name.
  await expect(site.getByText('Yes, 9am–5pm.')).toBeVisible({ timeout: 10_000 });
  await expect(site.getByText('Ada', { exact: true })).toBeVisible();

  // Create a contact from the chat, then close the conversation.
  await page.getByRole('button', { name: 'Create contact' }).click();
  await expect(page.getByRole('region', { name: 'Conversation' }).getByRole('link', { name: 'Grace', exact: true })).toHaveAttribute('href', /\/contacts\/\d+/);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByText('Conversation closed')).toBeVisible();
  await expect(page.getByText('No open conversations')).toBeVisible();
  await page.getByRole('tab', { name: 'Closed' }).click();
  await expect(list.getByRole('link', { name: /Grace/ })).toBeVisible();

  // The contact page lists the conversation.
  const contacts = await api(page, 'GET', '/contacts?q=Grace');
  await page.goto(`/contacts/${contacts.data[0].id}`);
  await expect(page.getByText('Conversations (1)')).toBeVisible();
  await expect(page.getByRole('link', { name: /Grace.*closed/ })).toBeVisible();
});

test('channels settings: Telegram token errors are explained; roles show the Inbox permission', async ({ page }) => {
  await signUp(page);
  await page.goto('/settings/channels');
  await page.getByRole('button', { name: 'Telegram bot' }).click();
  await page.getByLabel('Bot token').fill('not-a-token');
  await page.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByText(/Paste the token @BotFather gave you/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  await page.goto('/settings/roles');
  await page.getByRole('button', { name: /Sales rep/ }).click();
  await expect(page.getByLabel('Inbox view')).toHaveValue('team');
  await expect(page.getByLabel('Inbox edit')).toHaveValue('team');
  await expect(page.getByLabel('Inbox delete')).toHaveCount(0);
});
