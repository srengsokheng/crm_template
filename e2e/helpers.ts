import { expect, type Page } from '@playwright/test';

let n = 0;
export const uniq = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

/** Create a workspace through the sign-up page; leaves the page signed in on Home. */
export async function signUp(page: Page, name = 'Ada Admin') {
  const email = `${uniq('e2e')}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Company / workspace name').fill('E2E Robotics');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`, ${name.split(' ')[0]}`) })).toBeVisible();
  return email;
}

/** Call the API with the page's session (for test setup only). */
export async function api<T = any>(page: Page, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { 'x-requested-with': 'crm' } });
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function meta(page: Page) { return api(page, 'GET', '/meta'); }

/** Drag with real pointer events (dnd-kit needs intermediate moves). */
export async function drag(page: Page, from: ReturnType<Page['locator']>, to: ReturnType<Page['locator']>) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + 20);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + a.width / 2 + ((b.x + b.width / 2) - (a.x + a.width / 2)) * (i / 12), a.y + 20 + ((b.y + 60) - (a.y + 20)) * (i / 12));
  await page.waitForTimeout(150);
  await page.mouse.up();
}
