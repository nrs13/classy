import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function loadLocalEnv(root) {
  const path = join(root, '.env.local');
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function wrapRes(res, done) {
  return {
    statusCode: 200,
    get headersSent() {
      return res.headersSent;
    },
    setHeader(name, value) {
      res.setHeader(name, value);
      return this;
    },
    status(code) {
      this.statusCode = code;
      res.statusCode = code;
      return this;
    },
    json(payload) {
      res.statusCode = this.statusCode;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
      done();
    },
    writeHead(code, headers) {
      res.writeHead(code, headers);
    },
    write(chunk) {
      res.write(chunk);
    },
    end(chunk) {
      res.statusCode = this.statusCode;
      res.end(chunk);
      done();
    },
  };
}

const ROUTES = {
  '/api/chat': 'api/chat.js',
  '/api/catalog': 'api/catalog.js',
  '/api/search': 'api/search.js',
  '/api/seconds': 'api/seconds.js',
  '/api/media': 'api/media.js',
  '/api/object': 'api/object.js',
};

const nativeImport = new Function('specifier', 'return import(specifier)');
const pluginDir = dirname(fileURLToPath(import.meta.url));

export function classyChatApi() {
  return {
    name: 'classy-chat-api',
    configureServer(server) {
      loadLocalEnv(server.config.root);
      server.middlewares.use(async (req, res, next) => {
        const path = req.url?.split('?')[0];
        const file = ROUTES[path];
        if (!file) {
          if (path?.startsWith('/api/')) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'not_found' }));
            return;
          }
          next();
          return;
        }
        try {
          const fullPath = join(pluginDir, file);
          const { default: handler } = await nativeImport(
            `${pathToFileURL(fullPath).href}?v=${statSync(fullPath).mtimeMs}`,
          );
          if (path === '/api/object') {
            await handler({ method: req.method, headers: req.headers, url: req.url }, res);
            return;
          }
          const body = req.method === 'POST' ? await readBody(req) : {};
          await new Promise((resolve, reject) => {
            Promise.resolve(
              handler(
                { method: req.method, headers: req.headers, body, url: req.url },
                wrapRes(res, resolve),
              ),
            ).catch(reject);
          });
        } catch (err) {
          console.error('[classy api]', err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'api_handler_failed' }));
          }
        }
      });
    },
  };
}
