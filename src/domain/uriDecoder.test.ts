import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const queryRequire = createRequire(require.resolve('query-string'));
const decode = queryRequire('decode-uri-component') as (input: unknown) => string;
const queryString = require('query-string') as {
  parse: (value: string) => Record<string, unknown>;
};

test('installed URI decoder keeps the CommonJS and previous plus handling contract', () => {
  assert.equal(typeof decode, 'function');
  assert.equal(decode('%EC%84%9C%EC%9A%B8%EC%97%AD'), '서울역');
  assert.equal(decode('서울역'), '서울역');
  assert.equal(decode('a+b'), 'a b');
  assert.equal(decode('%2B'), '+');
  assert.throws(() => decode(null), TypeError);
});

test('malformed UTF-8 does not cause decoded percent escapes to be decoded again', () => {
  assert.equal(decode('%25%32%30%FF'), '%20%FF');
  assert.equal(decode('%E0%A4%A'), '%E0%A4%A');
  assert.equal(decode('%FE%FF'), '\uFFFD\uFFFD');
  assert.equal(decode('%C2'), '\uFFFD');
  assert.equal(decode('%ZZ%'), '%ZZ%');
});

test('the router query-string dependency uses the compatible patched decoder', () => {
  assert.deepEqual(
    { ...queryString.parse('place=%EC%84%9C%EC%9A%B8%EC%97%AD&plus=a+b&escaped=%2B') },
    { place: '서울역', plus: 'a b', escaped: '+' },
  );
  assert.equal(queryString.parse('value=%25%32%30%FF').value, '%20%FF');
});

test('large malformed router query completes in a bounded child process', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=64',
      '-e',
      `
        const query = require(process.argv[1]);
        const value = '%FF'.repeat(100000);
        const result = query.parse('location=' + value);
        if (result.location !== value) process.exit(2);
        process.stdout.write(String(result.location.length));
      `,
      require.resolve('query-string'),
    ],
    { timeout: 5000, encoding: 'utf8' },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '300000');
});
