/**
 * Accessibility: an axe scan (WCAG 2.1 A/AA rules) of every main screen in light and dark, on desktop and phone, plus
 * open dialogs and menus. Serious and critical violations fail the build (docs/UI-RULES.md §8). Automated scans find
 * only part of the problems; keyboard and screen-reader checks are still done by hand for new flows.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { api, signUp } from './helpers.ts';

async function scan(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = bad.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n    ')}`).join('\n');
  expect(bad, `${name}\n${report}`).toEqual([]);
}

async function seed(page: Page, baseURL: string) {
  const co = await api(page, 'POST', '/companies', { name: 'Globex' });
  const contact = await api(page, 'POST', '/contacts', { firstName: 'Ada', lastName: 'Lovelace', methods: [{ kind: 'email', value: 'ada@x.test' }] });
  const deal = await api(page, 'POST', '/deals', { title: 'Robots', companyId: co.id, contactIds: [contact.id] });
  await api(page, 'PUT', `/deals/${deal.id}/line-items`, { items: [{ name: 'Arm', unitPrice: '100', quantity: 1, unit: 'pc' }] });
  const doc = await api(page, 'POST', `/deals/${deal.id}/documents`, { kind: 'invoice' });
  const lead = await api(page, 'POST', '/leads', { title: 'Lead one', firstName: 'Bob' });
  const ch = await api(page, 'POST', '/channels', { kind: 'webchat', name: 'Chat' });
  await page.request.post(`${baseURL}/api/v1/public/webchat/${ch.publicKey}/messages`, { data: { body: 'Hello', name: 'Grace' }, headers: { 'x-requested-with': 'crm' } });
  const conv = (await api(page, 'GET', '/inbox/conversations')).data[0];
  await api(page, 'POST', '/activities', { kind: 'call', subject: 'Call Ada', dueAt: new Date(Date.now() + 3600_000).toISOString() });
  return { co, contact, deal, doc, lead, conv };
}

test('every main screen passes the accessibility scan, light and dark', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  await page.goto('/login');
  await scan(page, 'login');
  await page.goto('/confirm-email/aaaaaaaaaaaaaaaaaaaaaaaa');
  await scan(page, 'confirm email');
  await signUp(page);
  const s = await seed(page, baseURL!);
  const screens: [string, string][] = [
    ['home', '/'], ['inbox', `/inbox/${s.conv.id}`], ['activities', '/activities'], ['leads', '/leads'], ['lead', `/leads/${s.lead.id}`],
    ['deals', '/deals'], ['deal', `/deals/${s.deal.id}`], ['contacts', '/contacts'], ['contact', `/contacts/${s.contact.id}`],
    ['companies', '/companies'], ['company', `/companies/${s.co.id}`], ['products', '/products'], ['invoices', '/documents'],
    ['invoice', `/documents/${s.doc.id}`], ['reports', '/reports'], ['import', '/import/contact'], ['broadcasts', '/broadcasts'], ['new broadcast', '/broadcasts/new'],
    ['settings/account', '/settings/account'], ['settings/workspace', '/settings/workspace'], ['settings/pipelines', '/settings/pipelines'], ['settings/fields', '/settings/fields'],
    ['settings/lists', '/settings/lists'], ['settings/currencies', '/settings/currencies'], ['settings/documents', '/settings/documents'],
    ['settings/channels', '/settings/channels'], ['settings/booking', '/settings/booking'], ['settings/users', '/settings/users'], ['settings/roles', '/settings/roles'],
    ['settings/automation', '/settings/automation'], ['settings/audit-log', '/settings/audit-log'], ['settings/recycle-bin', '/settings/recycle-bin'],
  ];
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => localStorage.setItem('crm-theme', t), theme);
    for (const [name, path] of screens) { await page.goto(path); await scan(page, `${theme} ${name}`); }
  }
});

test('phone layouts, dialogs and menus pass the accessibility scan', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await signUp(page);
  const s = await seed(page, baseURL!);
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => localStorage.setItem('crm-theme', t), theme);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [name, path] of [['home', '/'], ['deals', '/deals'], ['deal', `/deals/${s.deal.id}`], ['inbox', `/inbox/${s.conv.id}`], ['contacts', '/contacts']] as const) {
      await page.goto(path);
      await scan(page, `${theme} phone ${name}`);
    }
    await page.goto('/');
    await page.getByRole('button', { name: 'More' }).click();
    await scan(page, `${theme} phone "More" menu`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/contacts');
    await page.getByRole('button', { name: /^New/ }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await scan(page, `${theme} "New" dialog`);
    await page.keyboard.press('Escape');
    await page.goto(`/inbox/${s.conv.id}`);
    await page.getByRole('button', { name: 'Saved replies' }).click();
    await scan(page, `${theme} saved replies menu`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await scan(page, `${theme} notifications`);
    await page.keyboard.press('Escape');
  }
});
