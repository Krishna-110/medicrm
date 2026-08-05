import 'dotenv/config';
import { app } from './app.js';
import { prisma } from './db/prisma.js';

// API_PORT, not PORT: dev tooling that forwards a port (this project's preview harness
// included) sets the generic PORT var for whatever it expects to reach at that port — the
// Vite dev server here. concurrently passes that same env to this process too, so reading
// PORT would silently steal Vite's port and break the /api proxy, which is hardcoded to 3001.
const port = Number(process.env.API_PORT ?? 3001);
const server = app.listen(port, () => console.log(`MediCRM API listening on http://localhost:${port}`));

/** Finish in-flight requests before dropping the database connection. */
async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
