import { expect, test, type Page } from '@playwright/test';
import { api, signUp } from './helpers.ts';

/** True once a participant's video is really playing (frames arriving, not just an element on the page). */
const playing = (page: Page, name: string) => page.locator(`video[data-peer="${name}"]`).evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.videoWidth > 0);

test('video call: start one from a meeting, a customer joins with the guest link, both see each other; ending logs the meeting', async ({ page, browser, baseURL }) => {
  await signUp(page);
  await api(page, 'POST', '/activities', { kind: 'meeting', subject: 'Demo for Umbrella Foods', dueAt: new Date().toISOString() });
  await page.goto('/activities');
  await page.getByRole('tab', { name: /Today/ }).click();
  await page.getByRole('button', { name: 'Start a video call for Demo for Umbrella Foods' }).click();
  await expect(page.getByRole('heading', { name: 'Demo for Umbrella Foods' })).toBeVisible();
  await expect(page.getByRole('figure', { name: 'Ada Admin (you)' })).toBeVisible(); // camera preview before joining
  await page.getByRole('button', { name: 'Join call' }).click();
  await expect(page.getByText('Waiting for others to join… Send the guest link to the customer.')).toBeVisible();

  // The guest link (as copied with "Copy guest link") opens in another browser, without an account.
  const callId = Number(page.url().split('/').pop());
  const call = await api(page, 'GET', `/calls/${callId}`);
  expect(call.guestUrl).toContain('/join/');
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(call.guestUrl.replace(/^https?:\/\/[^/]+/, baseURL!));
  await expect(guest.getByText('Video call with E2E Robotics')).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Enter your name to join' })).toBeVisible();
  await guest.getByLabel('Your name').fill('Grace');
  await guest.getByRole('button', { name: 'Join call' }).click();

  // Both sides see and hear each other (fake camera: frames really arrive over WebRTC).
  await expect(page.getByRole('figure', { name: 'Grace' })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => playing(page, 'Grace'), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => playing(guest, 'Ada Admin'), { timeout: 15_000 }).toBe(true);

  // Muting and camera off are just toggles; the call carries on.
  await guest.getByRole('button', { name: 'Mute' }).click();
  await expect(guest.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Camera off' }).click();
  await expect(page.getByRole('button', { name: 'Camera on' })).toBeVisible();

  // The guest leaves: the host sees it. The host ends the call for everyone.
  await guest.getByRole('button', { name: 'Leave' }).click();
  await expect(guest.getByText('You left the call')).toBeVisible();
  await expect(page.getByRole('figure', { name: 'Grace' })).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole('button', { name: 'End for everyone' }).click();
  await expect(page.getByText('Call ended for everyone')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'This call has ended' })).toBeVisible();
  await guest.goto(call.guestUrl.replace(/^https?:\/\/[^/]+/, baseURL!));
  await expect(guest.getByText('This call has ended')).toBeVisible();

  // The meeting is done, with the call's length and who took part.
  await page.goto('/activities');
  await page.getByRole('tab', { name: 'Done' }).click();
  await expect(page.getByText('Demo for Umbrella Foods')).toBeVisible();
  const acts = await api(page, 'GET', '/activities?bucket=done');
  expect(acts.data[0]).toMatchObject({ status: 'done', outcome: expect.stringMatching(/^Video call, 1 min, with Ada Admin, Grace$/) });
  await guestCtx.close();
});

test('video call from the Inbox: the customer gets the link in the chat', async ({ page }) => {
  await signUp(page);
  const ch = await api(page, 'POST', '/channels', { kind: 'webchat', name: 'Chat' });
  await page.request.post(`/api/v1/public/webchat/${ch.publicKey}/messages`, { data: { body: 'Can we talk on video?', name: 'Grace' } });
  const convs = await api(page, 'GET', '/inbox/conversations');
  await page.goto(`/inbox/${convs.data[0].id}`);
  await page.getByRole('button', { name: 'Video call' }).click();
  await expect(page.getByRole('heading', { name: 'Call with Grace' })).toBeVisible();
  const thread = await api(page, 'GET', `/inbox/conversations/${convs.data[0].id}`);
  expect(thread.messages.at(-1).body).toMatch(/^Join our video call: http.*\/join\/[A-Za-z0-9_-]{32}$/);
});
