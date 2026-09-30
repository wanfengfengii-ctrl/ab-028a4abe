import {createServer, type Server, type IncomingMessage, type ServerResponse} from 'node:http';
import {BusinessError} from './types.js';
import {validateRequest} from './validation.js';
import {solve} from './solver.js';

const MAX_BODY_BYTES = 1_000_000;

/** Read and JSON-parse a request body with a hard size cap. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BusinessError('INVALID_REQUEST', 'request body too large', {
          position: -1,
          reason: 'body_too_large',
          detail: `limit is ${MAX_BODY_BYTES} bytes`,
        }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new BusinessError('INVALID_REQUEST', 'request body is not valid JSON', {
          position: -1,
          reason: 'invalid_json',
          detail: 'body must be a JSON object',
        }));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function createApp(): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/health')) {
      sendJson(res, 200, {status: 'ok', service: 'buoy-telemetry-reorder'});
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      sendJson(res, 200, {
        service: 'buoy-telemetry-reorder',
        endpoints: {
          health: 'GET /healthz',
          recover: 'POST /api/v1/recover',
        },
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/recover') {
      try {
        const body = await readJsonBody(req);
        const request = validateRequest(body);
        const result = solve(request);
        sendJson(res, 200, result);
      } catch (err) {
        if (err instanceof BusinessError) {
          const status = err.code === 'INVALID_REQUEST' ? 400 : 422;
          sendJson(res, status, {
            error: {
              code: err.code,
              message: err.message,
              evidence: err.evidence ?? null,
            },
          });
          return;
        }
        sendJson(res, 500, {
          error: {
            code: 'INTERNAL_ERROR',
            message: err instanceof Error ? err.message : 'unexpected error',
          },
        });
      }
      return;
    }

    sendJson(res, 404, {error: {code: 'NOT_FOUND', message: `no route for ${req.method ?? '?'} ${url.pathname}`}});
  });

  return server;
}
