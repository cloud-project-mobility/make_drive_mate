import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const config = require('../../metro.config.js');

test('Metro excludes server data and environment files while allowing app and installed SDK sources', () => {
  const excluded = (name: string) =>
    config.resolver.blockList.some((pattern: RegExp) => pattern.test(path.join(root, name)));
  for (const name of [
    '.env.llm.local',
    '.env.onbid.local',
    'backend/data/onbid/raw.json',
    'backend-spring/src/main/resources/application.properties',
    '.tools/node/bin/node',
    'docs/private.docx',
  ])
    assert.equal(excluded(name), true, name);
  for (const name of [
    'src/app/index.tsx',
    'src/screens/OnbidValuation.tsx',
    'node_modules/expo-router/entry.js',
    'assets/vehicles/avante.jpg',
  ])
    assert.equal(excluded(name), false, name);
});

test('Metro refuses direct or encoded private-file requests before source diagnostics run', () => {
  let reached = false;
  const middleware = config.server.enhanceMiddleware(() => {
    reached = true;
  }, {});
  for (const url of [
    '/.env.llm.local',
    '/%2eenv.llm.local.bundle?platform=web',
    '/backend/scripts/onbid_model.py',
    '/backend-spring/target/drivemate-api.jar',
  ]) {
    let status = 0;
    let body = '';
    middleware(
      { url },
      {
        writeHead: (value: number) => {
          status = value;
        },
        end: (value: string) => {
          body = value;
        },
      },
      () => undefined,
    );
    assert.equal(status, 404);
    assert.equal(body, 'Not found');
    assert.equal(reached, false);
  }
  middleware({ url: '/node_modules/expo-router/entry.bundle?platform=web' }, {}, () => undefined);
  assert.equal(reached, true);
});
