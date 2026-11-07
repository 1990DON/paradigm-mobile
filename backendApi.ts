import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  EXISTING_NODE_RECORDS,
  parseActivitySessionId,
  parseCanonicalEventId,
  parseCanonicalObservationId,
  CanonicalObservationId,
  parseNodeId,
  parseUserId,
  UserRecord,
} from './canonicalDomain';
import { ScoringPipeline, STAGE6_BASELINE_WALKING_POLICY, UNDEFINED_PARTICIPATION_POLICY, UNDEFINED_PRESENCE_POLICY } from './scoringPipeline';
import { SessionProcessor } from './sessionProcessor';
import { SQLiteSessionPersistence } from './sqlitePersistence';

export const DEFAULT_LOOPBACK_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let rejected = false;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        reject(new Error('REQUEST_BODY_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) return resolve({});
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          reject(new Error('INVALID_JSON_OBJECT'));
          return;
        }
        resolve(value as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error && error.message === 'INVALID_JSON_OBJECT'
          ? error
          : new Error('INVALID_JSON'));
      }
    });
    request.on('error', () => reject(new Error('REQUEST_READ_FAILED')));
  });
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isTrustedFixtureRequest(body: Record<string, unknown>): boolean {
  const expected = process.env.PARADIGM_DEV_TRUSTED_FIXTURE;
  return Boolean(expected) &&
    typeof body.trustedFixture === 'string' &&
    safeTokenMatches(body.trustedFixture, expected);
}

function safeTokenMatches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type DevelopmentBackend = {
  persistence: SQLiteSessionPersistence;
  processor: SessionProcessor;
  pipeline: ScoringPipeline;
  server: ReturnType<typeof createServer>;
};

export function createDevelopmentBackend(databaseFile: string): DevelopmentBackend {
  const persistence = new SQLiteSessionPersistence(databaseFile);
  const principalIdValue = parseUserId(
    process.env.PARADIGM_DEV_USER ?? 'dev-user',
  );
  if (!principalIdValue) throw new Error('Invalid development principal.');
  const now = Date.now();
  const principal: UserRecord = {
    id: principalIdValue,
    createdAt: now,
    updatedAt: now,
  };
  persistence.db.prepare(
    `INSERT OR IGNORE INTO users(id,record_json,created_at,updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(principal.id, JSON.stringify(principal), now, now);
  for (const node of EXISTING_NODE_RECORDS) {
    persistence.db.prepare(
      'INSERT OR IGNORE INTO nodes(id,record_json) VALUES (?, ?)',
    ).run(node.id, JSON.stringify(node));
  }

  const processor = new SessionProcessor(persistence);
  const pipeline = new ScoringPipeline(processor);
  const replayLocks = new Map<string, Promise<void>>();

  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (method === 'GET' && url.pathname === '/v1/health') {
      json(response, 200, {
        status: 'ok',
        schemaVersion: 1,
        database: 'sqlite-development-reference',
      });
      return;
    }

    const configuredToken = process.env.PARADIGM_DEV_TOKEN;
    if (!configuredToken) {
      json(response, 503, {
        error: { code: 'AUTH_NOT_CONFIGURED', message: 'Development API token is not configured.' },
      });
      return;
    }
    const suppliedToken = request.headers['x-api-key'];
    const token = Array.isArray(suppliedToken) ? suppliedToken[0] : suppliedToken;
    if (!token) {
      json(response, 401, {
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'A development API token is required.' },
      });
      return;
    }
    if (!safeTokenMatches(token, configuredToken)) {
      json(response, 403, {
        error: { code: 'AUTHENTICATION_INVALID', message: 'Development API token is invalid.' },
      });
      return;
    }

    let body: Record<string, unknown> = {};
    try {
      if (method !== 'GET' && method !== 'DELETE') body = await readJson(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'INVALID_JSON';
      const status = message === 'REQUEST_BODY_TOO_LARGE' ? 413 : 400;
      json(response, status, {
        error: { code: message, message: message === 'REQUEST_BODY_TOO_LARGE'
          ? 'Request body exceeds the development limit.'
          : 'Request body must be valid JSON.' },
      });
      return;
    }

    const replayKey = typeof body.idempotencyKey === 'string'
      ? body.idempotencyKey
      : null;
    const route = `${method} ${url.pathname}`;
    let replayRelease: (() => void) | null = null;
    if (method !== 'GET' && replayKey) {
      const previous = replayLocks.get(replayKey) ?? Promise.resolve();
      await previous;
      let releaseReplayLock: (() => void) | undefined;
      const current = new Promise<void>((resolve) => {
        releaseReplayLock = resolve;
      });
      replayLocks.set(replayKey, current);
      replayRelease = () => {
        releaseReplayLock?.();
        if (replayLocks.get(replayKey) === current) replayLocks.delete(replayKey);
      };
      const existing = persistence.db.prepare(
        `SELECT request_hash,response_status,response_json
         FROM http_replays WHERE replay_key=? AND user_id=? AND route=?`,
      ).get(replayKey, principal.id, route) as Record<string, unknown> | undefined;
      const requestHash = hash(body);
      if (existing) {
        if (String(existing.request_hash) !== requestHash) {
          replayRelease?.();
          json(response, 409, {
            error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key was reused with a conflicting payload.' },
          });
          return;
        }
        response.statusCode = Number(existing.response_status);
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(String(existing.response_json));
        replayRelease?.();
        return;
      }
    }

    let status = 200;
    let payload: unknown;
    try {
      const path = url.pathname;
      const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)(\/(activate|complete|score))?$/);
      if (method === 'POST' && path === '/v1/sessions') {
        const id = parseActivitySessionId(typeof body.id === 'string' ? body.id : '');
        const category = body.category;
        if (!id || (category !== 'walking' && category !== 'presence' && category !== 'participation')) {
          status = 400;
          payload = { error: { code: 'INVALID_SESSION', message: 'Session id and category are invalid.' } };
        } else {
          const startedAt = typeof body.startedAt === 'number' ? body.startedAt : Date.now();
          const nodeId = typeof body.nodeId === 'string' ? parseNodeId(body.nodeId) : null;
          const walking = category === 'walking' && body.walking && typeof body.walking === 'object'
            ? body.walking as { distanceMeters: number; distanceSource: 'simulated' | 'manual' | 'measured' }
            : undefined;
          if (walking?.distanceSource === 'measured' && !isTrustedFixtureRequest(body)) {
            status = 400;
            payload = { error: { code: 'MEASURED_EVIDENCE_NOT_AUTHORIZED', message: 'Measured walking evidence requires an explicitly configured trusted development fixture.' } };
          } else {
          const presence = category === 'presence' && nodeId ? { status: 'observed' as const } : undefined;
          const participation = category === 'participation' && nodeId &&
            body.participation && typeof body.participation === 'object'
            ? body.participation as { activityName: string; source: 'self_reported' | 'organized' }
            : undefined;
          const result = processor.createSession({
            id, userId: principal.id, category, startedAt, nodeId: nodeId ?? undefined,
            walking, presence, participation,
          });
          status = result.accepted ? 201 : 400;
          payload = result.accepted
            ? { session: result.value }
            : { error: { code: 'SESSION_REJECTED', message: 'Session could not be created.', errors: result.errors } };
          }
        }
      } else if (method === 'POST' && sessionMatch?.[3] === 'activate') {
        const id = parseActivitySessionId(decodeURIComponent(sessionMatch[1]));
        if (!id) throw new Error('INVALID_ID');
        const result = processor.startSession(id, principal.id);
        status = result.accepted ? 200 : 409;
        payload = result.accepted
          ? { session: result.value }
          : { error: { code: 'LIFECYCLE_REJECTED', errors: result.errors } };
      } else if (method === 'POST' && path === '/v1/observations') {
        const id = parseCanonicalObservationId(typeof body.id === 'string' ? body.id : '');
        const sessionId = parseActivitySessionId(typeof body.sessionId === 'string' ? body.sessionId : '');
        const nodeId = typeof body.nodeId === 'string' ? parseNodeId(body.nodeId) : undefined;
        const kind = body.kind;
        const observedAt = typeof body.observedAt === 'number' ? body.observedAt : NaN;
        if (!id || !sessionId || (kind !== 'walking' && kind !== 'presence' && kind !== 'participation') ||
          typeof body.idempotencyKey !== 'string') {
          status = 400;
          payload = { error: { code: 'INVALID_OBSERVATION', message: 'Observation fields are invalid.' } };
        } else {
          const result = processor.acceptObservation({
            id, idempotencyKey: body.idempotencyKey, userId: principal.id, sessionId,
            kind, nodeId: nodeId ?? undefined,
            observedAt,
            location: body.location && typeof body.location === 'object'
              ? body.location as { latitude: number; longitude: number } : undefined,
            evidenceStatus: body.evidenceStatus === 'verified' && isTrustedFixtureRequest(body) ? 'verified'
              : body.evidenceStatus === 'simulated' ? 'simulated' : 'unverified',
            source: typeof body.source === 'string' ? body.source : 'self_reported',
          });
          status = result.accepted ? 201 : 400;
          payload = result.accepted
            ? { observation: result.value }
            : { error: { code: 'OBSERVATION_REJECTED', errors: result.errors } };
        }
      } else if (method === 'POST' && path === '/v1/events') {
        const id = parseCanonicalEventId(typeof body.id === 'string' ? body.id : '');
        const sessionId = parseActivitySessionId(typeof body.sessionId === 'string' ? body.sessionId : '');
        const kind = body.kind;
        const observationIds = Array.isArray(body.observationIds)
          ? body.observationIds.map((value) => typeof value === 'string'
            ? parseCanonicalObservationId(value) : null)
          : [];
        const validObservationIds = observationIds.filter(
          (value): value is CanonicalObservationId => value !== null,
        );
        if (!id || !sessionId || validObservationIds.length !== observationIds.length ||
          (kind !== 'walking_observation' && kind !== 'presence_observation' && kind !== 'participation_observation') ||
          typeof body.idempotencyKey !== 'string') {
          status = 400;
          payload = { error: { code: 'INVALID_EVENT', message: 'Event fields are invalid.' } };
        } else {
          const nodeId = typeof body.nodeId === 'string' ? parseNodeId(body.nodeId) : undefined;
          const result = processor.acceptEvent({
            id, idempotencyKey: body.idempotencyKey, userId: principal.id, sessionId,
            kind, nodeId: nodeId ?? undefined,
            occurredAt: typeof body.occurredAt === 'number' ? body.occurredAt : NaN,
            evidenceStatus: body.evidenceStatus === 'verified' && isTrustedFixtureRequest(body) ? 'verified'
              : body.evidenceStatus === 'simulated' ? 'simulated' : 'unverified',
            observationIds: validObservationIds,
          });
          status = result.accepted ? 201 : 400;
          payload = result.accepted
            ? { event: result.value }
            : { error: { code: 'EVENT_REJECTED', errors: result.errors } };
        }
      } else if (method === 'POST' && sessionMatch?.[3] === 'complete') {
        const id = parseActivitySessionId(decodeURIComponent(sessionMatch[1]));
        if (!id) throw new Error('INVALID_ID');
        const completedAt = typeof body.completedAt === 'number' ? body.completedAt : Date.now();
        const result = processor.completeSession(id, principal.id, completedAt);
        status = result.accepted ? 200 : 409;
        payload = result.accepted
          ? { session: result.value }
          : { error: { code: 'COMPLETION_REJECTED', errors: result.errors } };
      } else if (method === 'POST' && sessionMatch?.[3] === 'score') {
        const id = parseActivitySessionId(decodeURIComponent(sessionMatch[1]));
        const eventId = parseCanonicalEventId(typeof body.eventId === 'string' ? body.eventId : '');
        const category = body.category === 'presence' ? 'presence'
          : body.category === 'participation' ? 'participation' : 'walking';
        const policy = category === 'presence' ? UNDEFINED_PRESENCE_POLICY
          : category === 'participation' ? UNDEFINED_PARTICIPATION_POLICY
          : STAGE6_BASELINE_WALKING_POLICY;
        if (!id || !eventId) {
          status = 400;
          payload = { error: { code: 'INVALID_SCORE_REQUEST', message: 'Session and event ids are required.' } };
        } else {
          const result = pipeline.evaluate({ userId: principal.id, sessionId: id, eventId, policy });
          status = result.status === 'ACCEPTED' || result.status === 'IDEMPOTENT_REPLAY' ? 200
            : result.status === 'DEFERRED' ? 200 : 400;
          payload = result;
        }
      } else if (method === 'GET' && sessionMatch && !sessionMatch[3]) {
        const id = parseActivitySessionId(decodeURIComponent(sessionMatch[1]));
        const session = id ? processor.getHistory(principal.id).sessions.find((item) => item.activity.id === id) : undefined;
        status = session ? 200 : 404;
        payload = session ? { session } : { error: { code: 'SESSION_NOT_FOUND' } };
      } else if (method === 'GET' && path === '/v1/history') {
        payload = { history: processor.getHistory(principal.id) };
        status = 200;
      } else if (method === 'GET' && path === '/v1/xp') {
        const history = processor.getHistory(principal.id);
        payload = { xpEntries: history.xpEntries, totals: processor.deriveState(principal.id) };
        status = 200;
      } else {
        status = 404;
        payload = { error: { code: 'ROUTE_NOT_FOUND', message: 'The requested API route does not exist.' } };
      }
    } catch (error) {
      status = 400;
      payload = {
        error: {
          code: error instanceof Error ? error.message : 'INVALID_REQUEST',
          message: 'The request could not be processed.',
        },
      };
    }

    if (method !== 'GET' && replayKey && status < 500) {
      persistence.db.prepare(
        `INSERT OR IGNORE INTO http_replays(replay_key,user_id,route,request_hash,response_status,response_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(replayKey, principal.id, route, hash(body), status, JSON.stringify(payload));
    }
    replayRelease?.();
    json(response, status, payload);
  });

  return { persistence, processor, pipeline, server };
}
