import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createDevelopmentBackend, DEFAULT_LOOPBACK_HOST } from './backendApi';

const databaseFile = resolve(
  process.env.PARADIGM_DB_PATH ?? '.data/paradigm-stage75.sqlite',
);
mkdirSync(dirname(databaseFile), { recursive: true });
const port = Number(process.env.PARADIGM_PORT ?? '8787');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PARADIGM_PORT must be a valid TCP port.');
}

const backend = createDevelopmentBackend(databaseFile);
backend.server.listen(port, DEFAULT_LOOPBACK_HOST, () => {
  process.stdout.write(
    `Paradigm Stage 7.5 development API listening on http://${DEFAULT_LOOPBACK_HOST}:${port}\n`,
  );
});

function shutdown(): void {
  backend.server.close(() => {
    backend.persistence.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
