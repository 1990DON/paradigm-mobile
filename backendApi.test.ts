import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDevelopmentBackend,
  DevelopmentBackend,
  DEFAULT_LOOPBACK_HOST,
} from './backendApi';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function listen(backend: DevelopmentBackend): Promise<{ port: number }> {
  await new Promise<void>((resolve, reject) => {
    backend.server.once('error', reject);
    backend.server.listen(0, DEFAULT_LOOPBACK_HOST, () => resolve());
  });
  const address = backend.server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind.');
  return { port: address.port };
}

async function close(backend: DevelopmentBackend): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    backend.server.close((error) => error ? reject(error) : resolve());
  });
  backend.persistence.close();
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  token = 'stage75-test-token',
): Promise<{ status: number; value: unknown }> {
  const response = await fetch(`http://${DEFAULT_LOOPBACK_HOST}:${port}${path}`, {
    method,
    headers: {
      'x-api-key': token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, value: await response.json() };
}

async function runBackendApiTests(): Promise<void> {
  process.env.PARADIGM_DEV_TOKEN = 'stage75-test-token';
  process.env.PARADIGM_DEV_TRUSTED_FIXTURE = 'stage75-test-fixture';
  const directory = mkdtempSync(join(tmpdir(), 'paradigm-stage75-'));
  const databaseFile = join(directory, 'paradigm.sqlite');

  const first = createDevelopmentBackend(databaseFile);
  const { port } = await listen(first);

  const unauthenticated = await fetch(
    `http://${DEFAULT_LOOPBACK_HOST}:${port}/v1/history`,
  );
  assert(unauthenticated.status === 401, 'Unauthenticated history must fail.');

  const health = await fetch(
    `http://${DEFAULT_LOOPBACK_HOST}:${port}/v1/health`,
  );
  assert(health.status === 200, 'Health endpoint must be available.');

  const untrustedMeasured = await request(port, 'POST', '/v1/sessions', {
    id: 'session-untrusted-measured',
    category: 'walking',
    startedAt: 900,
    walking: { distanceMeters: 5000, distanceSource: 'measured' },
    idempotencyKey: 'untrusted-measured',
  });
  assert(untrustedMeasured.status === 400, 'Client supplied measured evidence must be rejected.');

  const created = await request(port, 'POST', '/v1/sessions', {
    id: 'session-api-integrated',
    category: 'walking',
    startedAt: 1000,
    walking: { distanceMeters: 500, distanceSource: 'measured' },
    idempotencyKey: 'create-integrated',
    trustedFixture: 'stage75-test-fixture',
  });
  assert(created.status === 201, 'Walking session creation should succeed.');

  const createReplay = await request(port, 'POST', '/v1/sessions', {
    id: 'session-api-integrated',
    category: 'walking',
    startedAt: 1000,
    walking: { distanceMeters: 500, distanceSource: 'measured' },
    idempotencyKey: 'create-integrated',
    trustedFixture: 'stage75-test-fixture',
  });
  assert(createReplay.status === 201, 'Exact create replay should remain idempotent.');

  const conflict = await request(port, 'POST', '/v1/sessions', {
    id: 'session-api-integrated-conflict',
    category: 'walking',
    startedAt: 1000,
    walking: { distanceMeters: 500, distanceSource: 'measured' },
    idempotencyKey: 'create-integrated',
  });
  assert(conflict.status === 409, 'Conflicting idempotency replay should fail.');

  assert(
    (await request(port, 'POST', '/v1/sessions/session-api-integrated/activate', {
      idempotencyKey: 'activate-integrated',
    })).status === 200,
    'Session activation should succeed.',
  );
  assert(
    (await request(port, 'POST', '/v1/observations', {
      id: 'observation-api-integrated',
      idempotencyKey: 'observation-api-integrated',
      sessionId: 'session-api-integrated',
      kind: 'walking',
      observedAt: 1200,
      location: { latitude: 0, longitude: 0 },
      evidenceStatus: 'verified',
      source: 'gps',
      trustedFixture: 'stage75-test-fixture',
    })).status === 201,
    'Verified walking observation should persist.',
  );
  assert(
    (await request(port, 'POST', '/v1/events', {
      id: 'event-api-integrated',
      idempotencyKey: 'event-api-integrated',
      sessionId: 'session-api-integrated',
      kind: 'walking_observation',
      occurredAt: 1200,
      evidenceStatus: 'verified',
      observationIds: ['observation-api-integrated'],
      trustedFixture: 'stage75-test-fixture',
    })).status === 201,
    'Canonical walking event should persist.',
  );
  assert(
    (await request(port, 'POST', '/v1/sessions/session-api-integrated/complete', {
      completedAt: 2000,
      idempotencyKey: 'complete-integrated',
    })).status === 200,
    'Session completion should succeed.',
  );
  const score = await request(port, 'POST', '/v1/sessions/session-api-integrated/score', {
    eventId: 'event-api-integrated',
    category: 'walking',
    idempotencyKey: 'score-integrated',
  });
  assert(score.status === 200, 'Legitimate walking scoring fixture should succeed.');
  assert(
    (score.value as { status: string }).status === 'ACCEPTED',
    'Walking fixture should produce an accepted award.',
  );

  const scoreReplay = await request(port, 'POST', '/v1/sessions/session-api-integrated/score', {
    eventId: 'event-api-integrated',
    category: 'walking',
    idempotencyKey: 'score-integrated',
  });
  assert(scoreReplay.status === 200, 'Exact scoring replay should succeed.');

  await close(first);
  const restarted = createDevelopmentBackend(databaseFile);
  const restartedAddress = await listen(restarted);
  const history = await request(restartedAddress.port, 'GET', '/v1/history');
  assert(history.status === 200, 'History should survive restart.');
  const historyValue = history.value as {
    history: { sessions: unknown[]; events: unknown[]; observations: unknown[]; xpEntries: unknown[] };
  };
  assert(historyValue.history.sessions.length === 1, 'Session count should survive restart.');
  assert(historyValue.history.events.length === 1, 'Event count should survive restart.');
  assert(historyValue.history.observations.length >= 1, 'Observation count should survive restart.');
  assert(historyValue.history.xpEntries.length === 1, 'Award count should survive restart without duplication.');

  const replay = await request(restartedAddress.port, 'POST', '/v1/sessions/session-api-integrated/score', {
    eventId: 'event-api-integrated',
    category: 'walking',
    idempotencyKey: 'score-integrated',
  });
  assert(replay.status === 200, 'Replay should remain accepted after restart.');
  const xp = await request(restartedAddress.port, 'GET', '/v1/xp');
  assert(
    ((xp.value as { xpEntries: unknown[] }).xpEntries.length === 1),
    'Restarted XP ledger must contain exactly one award.',
  );

  await close(restarted);
  rmSync(directory, { recursive: true });
  process.stdout.write('Stage 7.5 backend API integration tests: PASS\n');
}

void runBackendApiTests().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
