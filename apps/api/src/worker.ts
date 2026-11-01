import { startWorker } from './automation/engine.ts';
import { migrate } from './db/migrate.ts';

await migrate((m) => console.log(m));
const stop = startWorker((m) => console.log(new Date().toISOString(), m));
console.log('worker started');
const shutdown = () => { stop(); setTimeout(() => process.exit(0), 200); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
