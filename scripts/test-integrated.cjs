/* Real HTTP browser verification with a fresh, disposable, key-free backend. */
const { spawn } = require('node:child_process');
const { access, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');

const project = path.dirname(require.resolve('../package.json'));
const port = 18086;
const url = `http://127.0.0.1:${port}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requireFreePort() {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`Test backend port ${port} is occupied.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}

function signal(child, name) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(name);
    else process.kill(-child.pid, name);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function stop(child) {
  if (!child?.pid) return;
  signal(child, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    try {
      if (process.platform === 'win32') {
        if (child.exitCode !== null || child.signalCode !== null) return;
      } else process.kill(-child.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await delay(100);
  }
  signal(child, 'SIGKILL');
}

async function main() {
  await requireFreePort();
  const jar = path.join(project, 'backend-spring', 'target', 'drivemate-api-0.2.0.jar');
  try {
    await access(jar);
  } catch {
    throw new Error('Spring API artifact is missing. Run npm run build:backend first.');
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'drivemate-verification-'));
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /^(DRIVEMATE_|GOOGLE_|KAKAO_|HYUNDAI_|OPENAI_|GEMINI_|SPRING_DATASOURCE_|SERVER_)/.test(key)
    )
      delete env[key];
  Object.assign(env, {
    DRIVEMATE_PROVIDER_MODE: 'mock',
    DRIVEMATE_WEB_TEST_PORT: '18087',
    DRIVEMATE_WEB_STATIC: process.env.DRIVEMATE_WEB_STATIC === '1' ? '1' : '',
    DRIVEMATE_CORS_ORIGINS: 'http://localhost:18087,http://127.0.0.1:18087',
    SPRING_DATASOURCE_URL:
      'jdbc:h2:mem:e2e;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1',
    SERVER_PORT: String(port),
    SERVER_ADDRESS: '127.0.0.1',
  });
  let backend;
  let browser;
  const interrupted = () => {
    signal(browser, 'SIGTERM');
    signal(backend, 'SIGTERM');
    process.exitCode = 130;
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    backend = spawn('java', ['-jar', jar], {
      cwd: directory,
      env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    let spawnError;
    backend.once('error', (error) => {
      spawnError = error;
    });
    let ready = false;
    for (let i = 0; i < 300; i++) {
      if (spawnError) throw spawnError;
      if (backend.exitCode !== null || backend.signalCode !== null)
        throw new Error('The test backend stopped before becoming ready.');
      try {
        const response = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
        const health = await response.json();
        ready = response.ok && health.status === 'ok' && health.provider_mode === 'mock';
      } catch {
        /* Startup is still in progress. */
      }
      if (ready) break;
      await delay(200);
    }
    if (!ready) throw new Error('The mock backend did not become ready within 60 seconds.');
    browser = spawn(
      process.execPath,
      [
        path.join(project, 'node_modules', '@playwright', 'test', 'cli.js'),
        'test',
        ...process.argv.slice(2),
      ],
      {
        cwd: project,
        env: { ...env, DRIVEMATE_BACKEND_URL: url, DRIVEMATE_CATALOG_BACKEND_URL: url },
        stdio: 'inherit',
        detached: process.platform !== 'win32',
      },
    );
    const exit = await new Promise((resolve, reject) => {
      browser.once('error', reject);
      browser.once('exit', (code) => resolve(code ?? 1));
    });
    if (exit !== 0) process.exitCode = exit;
  } finally {
    await stop(browser);
    await stop(backend);
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
