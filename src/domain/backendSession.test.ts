import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import {
  BackendClient,
  BackendError,
  normalizeBackendUrl,
  type BackendSession,
} from '../services/backend';

type Scope = ReturnType<typeof import('../state/BackendProvider').useBackend>;
type RequestHandler = (url: string, options?: RequestInit) => Promise<Response>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function session(id: string): BackendSession {
  return {
    access_token: `synthetic-session-${id}`,
    token_type: 'bearer',
    user: { id, email: `${id}@example.test` },
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/** Run the real provider body with committed hook slots and controlled I/O, without React Native. */
function providerHarness(
  handle: RequestHandler,
  write: () => Promise<void> = async () => undefined,
  surface: { platform: string; origin?: string } = { platform: 'ios' },
) {
  interface Slot {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: () => void;
  }
  const slots: Slot[] = [];
  const effects: (() => void)[] = [];
  const timers: { run: () => void; delay: number }[] = [];
  let cursor = 0;
  let scope!: Scope;
  const changed = (before: readonly unknown[] | undefined, after: readonly unknown[]) =>
    !before ||
    before.length !== after.length ||
    after.some((value, i) => !Object.is(value, before[i]));
  const hooks = {
    createContext: () => ({ Provider: Symbol('provider') }),
    createElement: (_type: unknown, props: { value: Scope }) => props.value,
    useContext: () => scope,
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!slots[index])
        slots[index] = { value: typeof initial === 'function' ? (initial as () => T)() : initial };
      const set = (next: T | ((previous: T) => T)) => {
        slots[index].value =
          typeof next === 'function' ? (next as (previous: T) => T)(slots[index].value as T) : next;
      };
      return [slots[index].value as T, set];
    },
    useRef<T>(initial: T) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: { current: initial } };
      return slots[index].value as { current: T };
    },
    useMemo<T>(compute: () => T, deps: readonly unknown[]) {
      const index = cursor++;
      if (!slots[index] || changed(slots[index].deps, deps))
        slots[index] = { value: compute(), deps };
      return slots[index].value as T;
    },
    useCallback<T>(callback: T, deps: readonly unknown[]) {
      return hooks.useMemo(() => callback, deps);
    },
    useEffect(effect: () => (() => void) | void, deps: readonly unknown[]) {
      const index = cursor++;
      const slot = slots[index] ?? (slots[index] = {});
      if (changed(slot.deps, deps)) {
        slot.deps = deps;
        effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = effect() || undefined;
        });
      }
    },
    useLayoutEffect(effect: () => (() => void) | void, deps: readonly unknown[]) {
      hooks.useEffect(effect, deps);
    },
  };
  class ControlledClient extends BackendClient {
    constructor(url: string, token?: string, fetcher?: typeof fetch, onUnauthorized?: () => void) {
      super(
        url,
        token,
        fetcher ?? ((input, options) => handle(String(input), options)),
        onUnauthorized,
      );
    }
  }
  const source = readFileSync(
    fileURLToPath(new URL('../state/BackendProvider.tsx', import.meta.url)),
    'utf8',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
    },
  }).outputText;
  const module = { exports: {} as { BackendProvider: (props: { children: null }) => Scope } };
  const requireModule = (name: string) => {
    if (name === 'react') return { __esModule: true, default: hooks, ...hooks };
    if (name === 'react-native') return { Platform: { OS: surface.platform } };
    if (name === '@react-native-async-storage/async-storage')
      return { __esModule: true, default: { getItem: async () => null, setItem: write } };
    if (name === '../services/backend')
      return { BackendClient: ControlledClient, BackendError, normalizeBackendUrl };
    throw new Error(`Unexpected provider dependency: ${name}`);
  };
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', 'window', output)(
    requireModule,
    module,
    module.exports,
    (run: () => void, delay: number) => {
      timers.push({ run, delay });
      return timers.length;
    },
    () => undefined,
    surface.origin ? { location: new URL(surface.origin) } : undefined,
  );
  function render() {
    cursor = 0;
    scope = module.exports.BackendProvider({ children: null });
    while (effects.length) effects.shift()!();
    return scope;
  }
  return { render, timers };
}

test('HTTPS web uses its own API origin while local web and native retain the development default', () => {
  for (const [platform, origin, expected] of [
    ['web', 'https://drivemate.example.test', 'https://drivemate.example.test'],
    ['web', 'http://127.0.0.1:8081', 'http://127.0.0.1:18085'],
    ['ios', undefined, 'http://127.0.0.1:18085'],
  ] as const) {
    const harness = providerHarness(async () => json({}), undefined, { platform, origin });
    assert.equal(harness.render().url, expected);
  }
});

test('logout hides the current account immediately and its late response cannot clear a newer login', async () => {
  const logoutReply = deferred<Response>();
  let account = 'first';
  const harness = providerHarness(async (url) =>
    url.endsWith('/auth/logout') ? logoutReply.promise : json(session(account)),
  );
  let scope = harness.render();
  await scope.authenticate('login', 'first@example.test', 'synthetic-test-password');
  scope = harness.render();
  const firstClient = scope.client;
  assert.equal(scope.isCurrentClient(firstClient), true);
  const logout = scope.logout();
  assert.equal(scope.isCurrentClient(firstClient), false);
  scope = harness.render();
  assert.equal(scope.session, null);
  account = 'second';
  await scope.authenticate('login', 'second@example.test', 'synthetic-test-password');
  scope = harness.render();
  assert.equal(scope.session?.user.id, 'second');
  logoutReply.resolve(json({ ok: true }));
  await logout;
  scope = harness.render();
  assert.equal(scope.session?.user.id, 'second');
  assert.equal(scope.isCurrentClient(scope.client), true);
});

test('authentication cannot start while a different server address is being persisted', async () => {
  const write = deferred<void>();
  const requestedUrls: string[] = [];
  const harness = providerHarness(
    async (url) => {
      requestedUrls.push(url);
      return json(session('new-server'));
    },
    () => write.promise,
  );
  let scope = harness.render();
  const configuring = scope.configure('http://127.0.0.1:18088');
  await assert.rejects(
    scope.authenticate('login', 'new@example.test', 'synthetic-test-password'),
    /서버 주소를 저장하는 중/,
  );
  assert.deepEqual(requestedUrls, []);
  write.resolve();
  await configuring;
  scope = harness.render();
  assert.equal(scope.url, 'http://127.0.0.1:18088');
  await scope.authenticate('login', 'new@example.test', 'synthetic-test-password');
  assert.deepEqual(requestedUrls, ['http://127.0.0.1:18088/api/v1/auth/login']);
});

test('a login superseded by a server change discards and revokes its late token at the original server', async () => {
  const authReply = deferred<Response>();
  const requests: { url: string; bearer: string | null }[] = [];
  const harness = providerHarness(async (url, options) => {
    requests.push({ url, bearer: new Headers(options?.headers).get('Authorization') });
    return url.endsWith('/auth/login') ? authReply.promise : json({ ok: true });
  });
  let scope = harness.render();
  const originalUrl = scope.url;
  const authentication = scope.authenticate('login', 'old@example.test', 'synthetic-test-password');
  const rejected = assert.rejects(authentication, /서버 설정이 변경/);
  await scope.configure('http://127.0.0.1:18088');
  authReply.resolve(json(session('old-server')));
  await rejected;
  await new Promise<void>((done) => setImmediate(done));
  scope = harness.render();
  assert.equal(scope.session, null);
  assert.equal(scope.url, 'http://127.0.0.1:18088');
  assert.deepEqual(requests, [
    { url: `${originalUrl}/api/v1/auth/login`, bearer: null },
    { url: `${originalUrl}/api/v1/auth/logout`, bearer: 'Bearer synthetic-session-old-server' },
  ]);
});

test('old session timers and unauthorized responses cannot invalidate a newer account', async () => {
  let account = 'first';
  const harness = providerHarness(async (url) => {
    if (url.endsWith('/state'))
      return json({ error: { code: 'unauthorized', message: 'old session' } }, 401);
    if (url.endsWith('/auth/logout')) return json({ ok: true });
    return json(session(account));
  });
  let scope = harness.render();
  await scope.authenticate('login', 'first@example.test', 'synthetic-test-password');
  scope = harness.render();
  const firstClient = scope.client;
  const staleTimer = harness.timers.at(-1)!;
  await scope.logout();
  scope = harness.render();
  account = 'second';
  await scope.authenticate('login', 'second@example.test', 'synthetic-test-password');
  scope = harness.render();
  staleTimer.run();
  await assert.rejects(firstClient.snapshot(), /old session/);
  scope = harness.render();
  assert.equal(scope.session?.user.id, 'second');
  assert.equal(scope.isCurrentClient(scope.client), true);
  harness.timers.at(-1)!.run();
  assert.equal(scope.isCurrentClient(scope.client), false);
  assert.equal(harness.render().session, null);
});
