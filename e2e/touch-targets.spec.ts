import { expect, test, type Page } from '@playwright/test';
import { api, signUp } from './helpers.ts';

/** A phone (touch, pointer: coarse) at 390px. */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** Controls whose tap area (the element or its ::after hit area) is under 44×44 (24×24 for checkboxes/radios). */
async function smallTargets(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], [role="tab"], [role="switch"], input[type="checkbox"], input[type="radio"]'))) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
      const a = getComputedStyle(el, '::after');
      const hit = a.content !== 'none' && a.position === 'absolute';
      const w = Math.max(r.width, hit ? parseFloat(a.width) || 0 : 0);
      const h = Math.max(r.height, hit ? parseFloat(a.height) || 0 : 0);
      const min = el.matches('input') ? 24 : 44;
      if (w < min - 0.5 || h < min - 0.5) out.push(`${Math.round(w)}×${Math.round(h)} ${el.tagName} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}"`);
    }
    return out;
  });
}

test('phone: every control has a 44px tap area (checkboxes 24px), without horizontal scroll', async ({ page }) => {
  await signUp(page);
  const d = await api(page, 'POST', '/deals', { title: 'Touch deal', amount: '1234' });
  const c = await api(page, 'POST', '/contacts', { firstName: 'Touch' });
  for (const path of ['/', '/deals', `/deals/${d.id}`, '/contacts', `/contacts/${c.id}`, '/activities', '/inbox', '/settings']) {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await smallTargets(page), path).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(390);
  }
  // The bigger hit areas don't swallow taps meant for the control next to them.
  await page.goto(`/deals/${d.id}`);
  await page.getByRole('button', { name: 'Edit Amount' }).tap();
  await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value ?? '')).toMatch(/^1,?234(\.00)?$/);
});
