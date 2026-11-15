import type { FastifyInstance } from 'fastify';
import { activityRoutes } from './activities.ts';
import { authRoutes } from './auth.ts';
import { automationRoutes } from './automation.ts';
import { dealRoutes } from './deals.ts';
import { importRoutes } from './imports.ts';
import { leadRoutes } from './leads.ts';
import { metaRoutes } from './meta.ts';
import { partyRoutes } from './parties.ts';
import { productRoutes } from './products.ts';
import { recycleRoutes } from './recycle.ts';
import { reportRoutes } from './reports.ts';
import { searchRoutes } from './search.ts';
import { settingsRoutes } from './settings.ts';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(authRoutes);
  await app.register(metaRoutes);
  await app.register(partyRoutes);
  await app.register(dealRoutes);
  await app.register(leadRoutes);
  await app.register(activityRoutes);
  await app.register(productRoutes);
  await app.register(searchRoutes);
  await app.register(settingsRoutes);
  await app.register(reportRoutes);
  await app.register(automationRoutes);
  await app.register(importRoutes);
  await app.register(recycleRoutes); // generic DELETE /:entity/:id last
}
