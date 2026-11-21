import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

// The e2e server uses a fake Telegram (apps/api/test/fakes/telegramUser.ts): +855 11 111 111 has two-step
// verification ("correct horse"), the code is 12345, and after sign-in "Sok Dara" writes to the account.
test('Telegram account: sign in with code and 2FA password in Settings, then messages arrive and replies go out', async ({ page }) => {
  await signUp(page);
  await page.goto('/settings/channels');
  await page.getByRole('button', { name: 'Telegram account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('api_id').fill('123456');
  await dialog.getByLabel('api_hash').fill('0123456789abcdef0123456789abcdef');
  await dialog.getByLabel('Phone number').fill('+855 11 111 111');
  await expect(dialog.getByRole('checkbox', { name: /group chats/ })).not.toBeChecked(); // private chats only by default
  await dialog.getByRole('button', { name: 'Send login code' }).click();
  await expect(page.getByText('Telegram sent a code to the account — enter it on the channel')).toBeVisible();
  await expect(page.getByText('Signing in')).toBeVisible();

  // Wrong code, then the right one, then the 2FA password.
  await page.getByLabel('Login code').fill('11111');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/That code isn’t right/)).toBeVisible();
  await page.getByLabel('Login code').fill('12345');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Two-step verification password').fill('correct horse');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Telegram account connected')).toBeVisible();
  await expect(page.getByText('Signed in as')).toContainText('Bopha');
  await expect(page.getByText('Active', { exact: true })).toBeVisible();

  // The worker connects within seconds; the customer's message arrives, assigned to the owner (me).
  await page.goto('/inbox');
  const list = page.getByRole('complementary', { name: 'Conversations' });
  await expect(list.getByRole('link', { name: /Sok Dara/ })).toBeVisible({ timeout: 15_000 });
  await list.getByRole('link', { name: /Sok Dara/ }).click();
  await expect(page.locator('ol').getByText('Hi! Is the X2 arm still available?')).toBeVisible();
  await expect(page.getByLabel('Assignee')).toHaveValue(/\d+/);
  await page.getByLabel('Reply').fill('Yes, it is.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('ol').getByText('Yes, it is.')).toBeVisible();
  const id = Number(page.url().split('/').pop());
  await expect.poll(async () => (await api(page, 'GET', `/inbox/conversations/${id}`)).messages.at(-1).status, { timeout: 10_000 }).toBe('sent');
});
