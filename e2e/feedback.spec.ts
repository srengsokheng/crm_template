import { expect, test } from '@playwright/test';
import pg from 'pg';
import { api, signUp, uniq } from './helpers.ts';

async function rateLink(to: string): Promise<string> {
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://crm:crm@127.0.0.1:5432/crm_e2e' });
  await c.connect();
  try {
    for (let i = 0; i < 40; i++) {
      const r = await c.query(`SELECT payload->>'text' AS text FROM jobs WHERE type = 'email.send' AND payload->>'to' = $1 ORDER BY id DESC LIMIT 1`, [to]);
      const m = r.rows[0] && /\/r\/[\w-]+/.exec(r.rows[0].text);
      if (m) return m[0];
      await new Promise((res) => setTimeout(res, 250));
    }
    throw new Error('no feedback email queued');
  } finally { await c.end(); }
}

test('customer feedback: turn it on, ask on a won deal, the customer rates, the team sees it', async ({ page, browser, baseURL }) => {
  await signUp(page);
  await page.goto('/settings/feedback');
  await page.getByLabel('Ask customers for feedback automatically after a deal is won').check();
  await page.getByLabel('When').selectOption('1');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();

  const email = `${uniq('dara')}@umbrella.test`;
  const contact = await api(page, 'POST', '/contacts', { firstName: 'Dara', lastName: 'Sok', methods: [{ kind: 'email', value: email }] });
  const deal = await api(page, 'POST', '/deals', { title: 'Robot arms', contactIds: [contact.id] });
  await api(page, 'POST', `/deals/${deal.id}/close`, { outcome: 'won' });

  await page.goto(`/deals/${deal.id}`);
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Customer feedback' }) });
  await expect(card).toContainText('Not asked yet — it goes out 1 day after the win');
  await card.getByRole('button', { name: 'Ask now' }).click();
  await expect(page.getByText('Feedback request sent')).toBeVisible();
  await expect(card).toContainText(`Asked ${email}`);

  // The customer rates.
  const link = await rateLink(email);
  const ctx = await browser.newContext();
  const customer = await ctx.newPage();
  await customer.goto(baseURL + link);
  await expect(customer.getByRole('heading', { name: /^How was your experience with / })).toBeVisible();
  await customer.getByRole('radio', { name: /^2 out of 5/ }).click();
  await customer.getByLabel('Tell us more (optional)').fill('Delivery was late');
  await customer.getByRole('button', { name: 'Send feedback' }).click();
  await expect(customer.getByRole('heading', { name: 'Thank you for your feedback!' })).toBeVisible();
  await expect(customer.getByText(/we’re sorry it wasn’t better\. Ada Admin will get in touch/)).toBeVisible();
  // Changed their mind.
  await customer.getByRole('button', { name: 'Change my answer' }).click();
  await customer.getByRole('radio', { name: /^4 out of 5/ }).click();
  await customer.getByLabel('Tell us more (optional)').fill('Late, but they fixed it quickly');
  await customer.getByRole('button', { name: 'Send feedback' }).click();
  await expect(customer.getByRole('heading', { name: 'Thank you for your feedback!' })).toBeVisible();
  await ctx.close();

  await page.reload();
  await expect(card).toContainText('4/5');
  await expect(card).toContainText('“Late, but they fixed it quickly”');
  await expect(page.getByText('Customer changed their rating to 4/5: “Late, but they fixed it quickly”')).toBeVisible();

  await page.goto('/');
  const home = page.locator('section', { has: page.getByRole('heading', { name: 'Customer rating' }) });
  await expect(home).toContainText('4.0');
  await expect(home).toContainText('1 of 1 answered');
});
