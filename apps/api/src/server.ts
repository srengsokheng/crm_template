import { buildApp } from './app.ts';
import { config } from './config.ts';
import { migrate } from './db/migrate.ts';
import { startWorker } from './automation/engine.ts';

await migrate((m) => console.log(m));
const app = await buildApp();
await app.listen({ port: config.port, host: config.host });
// Background jobs run inline by default (single-process deploys). Set INLINE_WORKER=false and run `npm run worker` to split them out.
const stopWorker = process.env.INLINE_WORKER === 'false' ? () => {} : startWorker((m) => app.log.info(m));
const shutdown = async () => { stopWorker(); await app.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
