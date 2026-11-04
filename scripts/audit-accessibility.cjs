const { chromium } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs');
const path = require('node:path');
const output = process.env.A11Y_OUTPUT_DIR || 'test-results/accessibility';
fs.mkdirSync(output, { recursive: true });
const base = process.env.A11Y_BASE_URL || 'http://127.0.0.1:8081';
(async () => {
  const b = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox'],
  });
  const c = await b.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR' });
  const p = await c.newPage();
  const errors = [];
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const results = [];
  async function scan(screen) {
    let count = 0,
      scrollTop = -1;
    while (count < 8) {
      const result = await new AxeBuilder({ page: p })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const violations = result.violations.map((x) => ({
        id: x.id,
        impact: x.impact,
        help: x.help,
        nodes: x.nodes.map((n) => ({ html: n.html, summary: n.failureSummary })),
      }));
      results.push({ screen, scroll: count, violations });
      console.log(screen, count, JSON.stringify(violations));
      const next = await p.evaluate(() => {
        const scroller = Array.from(document.querySelectorAll('div')).find(
          (x) =>
            x.clientHeight > 200 &&
            x.scrollHeight > x.clientHeight + 5 &&
            ['auto', 'scroll'].includes(getComputedStyle(x).overflowY),
        );
        if (!scroller) return 0;
        scroller.scrollTop = Math.min(
          scroller.scrollTop + scroller.clientHeight * 0.8,
          scroller.scrollHeight - scroller.clientHeight,
        );
        return scroller.scrollTop;
      });
      if (next === scrollTop || next === 0) break;
      scrollTop = next;
      count++;
      await p.waitForTimeout(50);
    }
  }
  await p.goto(base);
  await p.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).waitFor();
  await scan('welcome-desktop');
  await p.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  await p.getByRole('heading', { name: '내 차의 다음 타이밍', exact: true }).waitFor();
  await p.screenshot({ path: path.join(output, 'implementation-desktop.png') });
  await scan('garage-desktop');
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(base);
  await p.getByRole('heading', { name: '내 차의 다음 타이밍', exact: true }).waitFor();
  await p.screenshot({ path: path.join(output, 'implementation-mobile.png') });
  await scan('garage-mobile');
  await p.screenshot({ path: path.join(output, 'implementation-mobile-care.png') });
  for (const route of [
    '/maintenance',
    '/vehicle?id=demo-avante',
    '/plan',
    '/route',
    '/trips',
    '/settings',
    '/notifications',
  ]) {
    await p.goto(base + route);
    await p.getByRole('heading').first().waitFor();
    await scan(route);
  }
  fs.writeFileSync(
    path.join(output, 'accessibility-axe.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        viewportMobile: '390x844',
        viewportDesktop: '1440x1000',
        tags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
        results,
        errors,
      },
      null,
      2,
    ),
  );
  await b.close();
  if (errors.length || results.some((r) => r.violations.length)) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
