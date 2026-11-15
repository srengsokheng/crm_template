import { expect, test } from '@playwright/test';
import { signUp } from './helpers.ts';

test('invitations say whether an email went out, can be re-sent, and the link works', async ({ page, browser }) => {
  await signUp(page);
  await page.goto('/settings/users');
  await page.getByRole('button', { name: 'Invite' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name').fill('Nia New');
  await dlg.getByLabel('Email').fill('nia@example.com');
  await dlg.getByRole('button', { name: 'Create invite' }).click();
  // The e2e server has no mail server, so the admin is told to share the link.
  await expect(dlg.getByText(/Email delivery isn’t set up on this server/)).toBeVisible();
  await expect(dlg.getByText('nia@example.com')).toBeVisible();
  const first = await dlg.getByLabel('Invite link').inputValue();
  expect(first).toMatch(/\/invite\/.+/);
  await dlg.getByRole('button', { name: 'Done' }).click();

  // Resend creates a fresh link and retires the old one.
  await page.getByRole('button', { name: 'Resend invite' }).click();
  const again = page.getByRole('dialog', { name: 'New invitation created' });
  const second = await again.getByLabel('Invite link').inputValue();
  expect(second).not.toBe(first);
  await again.getByRole('button', { name: 'Done' }).click();

  const guest = await browser.newContext();
  const gp = await guest.newPage();
  await gp.goto(new URL(first).pathname);
  await expect(gp.getByText(/invitation link is invalid|no longer valid|expired/i)).toBeVisible();
  await gp.goto(new URL(second).pathname);
  await expect(gp.getByLabel('Password')).toBeVisible();
  await guest.close();

  // A wrong invitation can be cancelled.
  await page.getByRole('button', { name: 'Cancel invite' }).click();
  await expect(page.getByText('Invitation cancelled')).toBeVisible();
  await expect(page.getByText('nia@example.com')).toBeHidden();
});

test('admins see the email delivery status and can send a test; users can turn reminder emails off', async ({ page }) => {
  await signUp(page);
  await page.goto('/settings/workspace');
  const card = page.locator('section', { hasText: 'Email delivery' }).last();
  await expect(card.getByText('Not sending')).toBeVisible();
  await expect(card.getByText(/No mail server is configured/)).toBeVisible();
  await card.getByRole('button', { name: 'Send a test email to me' }).click();
  await expect(page.getByText(/Test message written to the server log/)).toBeVisible();

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Turn off reminder emails' }).click();
  await expect(page.getByText('Reminder emails turned off')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('menuitem', { name: 'Turn on reminder emails' })).toBeVisible();
});
