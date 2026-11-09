import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

async function start(page: Page, demo = true) {
  await page.goto('/');
  await page
    .getByRole('button', {
      name: demo ? '예시 차량으로 둘러보기' : '내 차량으로 시작하기',
      exact: true,
    })
    .click();
  await expect(page.getByRole('tab', { name: '홈', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '내 차', exact: true }).click();
  await expect(page.getByRole('heading', { name: '내 차', exact: true })).toBeVisible();
}

async function addVehicle(page: Page, name: string, powertrain = '내연기관') {
  await page.getByRole('textbox', { name: '차량 이름', exact: true }).fill(name);
  await page
    .getByRole('textbox', { name: '제조사 · 모델 · 연식', exact: true })
    .fill('현대 아반떼 2023');
  await page.getByRole('textbox', { name: '현재 누적 주행거리 (km)', exact: true }).fill('48,250');
  await page.getByRole('button', { name: powertrain, exact: true }).click();
  await page.getByRole('button', { name: '차량 등록하기', exact: true }).click();
  await expect(page.getByRole('tab', { name: '홈', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '내 차', exact: true }).click();
  await expect(page.getByRole('heading', { name: '내 차', exact: true })).toBeVisible();
}

async function futureDate(page: Page, days = 2) {
  return page.evaluate((offset) => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }, days);
}

async function fillPlan(page: Page) {
  await page.getByRole('textbox', { name: '출발지', exact: true }).fill('서울역');
  await page.getByRole('textbox', { name: '도착지', exact: true }).fill('강남역');
  await page.getByRole('textbox', { name: '일정 이름 (선택)', exact: true }).fill('자정 이후 미팅');
  await page.getByRole('textbox', { name: '도착 날짜', exact: true }).fill(await futureDate(page));
  await page.getByRole('textbox', { name: '도착 시간 · 24시간', exact: true }).fill('00:30');
  await page.getByRole('textbox', { name: '예상 운전 시간 (분)', exact: true }).fill('50');
  await page.getByRole('textbox', { name: '주차 후 도보 (분)', exact: true }).fill('10');
  await page.getByRole('textbox', { name: '여유 시간 (분)', exact: true }).fill('10');
}

// Every test gets a fresh browser context; no seeded localStorage or application dispatches.
test('demo selection keeps vehicle identity consistent and excludes engine maintenance for an EV', async ({
  page,
}) => {
  await start(page);
  await expect(
    page
      .getByRole('button', { name: '차량 선택', exact: true })
      .locator('..')
      .getByTestId('vehicle-odometer'),
  ).toHaveText('48,250');
  await page.getByRole('button', { name: '차량 선택', exact: true }).click();
  await page.getByRole('button', { name: '아이오닉 5', exact: true }).click();
  await expect(
    page
      .getByRole('button', { name: '차량 선택', exact: true })
      .locator('..')
      .getByTestId('vehicle-odometer'),
  ).toHaveText('31,780');
  await page.getByRole('button', { name: '정비·소모품 기록', exact: true }).click();
  await expect(page.getByRole('heading', { name: '소모품 관리', exact: true })).toBeVisible();
  await expect(page.getByText('아이오닉 5 · 31,780 km', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '냉각 시스템 점검 기록하기', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '엔진오일 점검 기록하기', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '엔진 에어필터 점검 기록하기', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '뒤로', exact: true }).click();
  await page.getByRole('button', { name: '차량 선택', exact: true }).click();
  await page.getByRole('button', { name: '우리 집 K5', exact: true }).click();
  await page.getByRole('button', { name: '정비·소모품 기록', exact: true }).click();
  await expect(page.getByText('우리 집 K5 · 26,340 km', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '엔진오일 점검 기록하기', exact: true }),
  ).toBeVisible();
});

test('an empty garage validates registration, persists real inputs, and enforces the three-vehicle limit', async ({
  page,
}) => {
  await start(page, false);
  await page.getByRole('button', { name: '첫 차량 등록', exact: true }).click();
  await page.getByRole('button', { name: '차량 등록하기', exact: true }).click();
  await expect(page.getByText('차량 이름을 입력해 주세요.', { exact: true })).toBeVisible();
  await expect(page.getByText('제조사·모델·연식을 입력해 주세요.', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '현재 누적 주행거리 (km)', exact: true }).fill('-10');
  await page.getByRole('button', { name: '차량 등록하기', exact: true }).click();
  await expect(
    page.getByText('누적 주행거리에 0 이상의 숫자를 입력해 주세요.', { exact: true }),
  ).toBeVisible();
  await addVehicle(page, '우리 가족 첫 차');
  await page.reload();
  await expect(
    page.getByText('우리 가족 첫 차', { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(page.getByText('48,250', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '차량 등록', exact: true }).click();
  await addVehicle(page, '주말 하이브리드', '하이브리드');
  await page.getByRole('button', { name: '차량 등록', exact: true }).click();
  await addVehicle(page, '출퇴근 전기차', '전기차');
  await expect(page.getByRole('button', { name: '차량 등록', exact: true })).toBeDisabled();
  await page.goto('/vehicle');
  await expect(
    page.getByRole('heading', { name: '차량은 최대 3대까지', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '차량 등록하기', exact: true })).toHaveCount(0);
});

test('maintenance rejects impossible baselines and persists a successful service record', async ({
  page,
}) => {
  await start(page);
  await page.getByRole('button', { name: '정비·소모품 기록', exact: true }).click();
  await page.getByRole('button', { name: '엔진오일 점검 기록하기', exact: true }).click();
  await page.getByRole('textbox', { name: '점검 당시 주행거리 (km)', exact: true }).fill('48251');
  await page.getByRole('button', { name: '엔진오일 기록 저장', exact: true }).click();
  await expect(
    page.getByText('점검 시 주행거리는 현재 누적 주행거리 이하여야 해요.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: '점검 당시 주행거리 (km)', exact: true }).fill('48250');
  await page
    .getByRole('textbox', { name: '점검일 (YYYY-MM-DD)', exact: true })
    .fill(await futureDate(page));
  await page.getByRole('button', { name: '엔진오일 기록 저장', exact: true }).click();
  await expect(
    page.getByText('미래 날짜의 점검은 완료 기록으로 저장할 수 없어요.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: '점검일 (YYYY-MM-DD)', exact: true })
    .fill(await futureDate(page, 0));
  await page
    .getByRole('textbox', { name: '메모 (선택)', exact: true })
    .fill('정비소에서 오일과 필터 교체');
  await page.getByRole('button', { name: '엔진오일 기록 저장', exact: true }).click();
  await expect(
    page.getByText('점검 기록을 저장했어요. 다음 확인 시기에 반영됩니다.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/^10,000 km 남음 · \d+일 남음$/)).toBeVisible();
  await page.reload();
  await expect(
    page.getByText('48,250 km · 정비소에서 오일과 필터 교체', { exact: true }),
  ).toBeVisible();
});

test('a cross-midnight plan keeps its previous-day departure after saving and reloading', async ({
  page,
}) => {
  await start(page);
  await page.getByRole('button', { name: '이 차량으로 이동 계획', exact: true }).click();
  await fillPlan(page);
  await expect(page.getByText('23:20', { exact: true })).toBeVisible();
  await expect(page.getByText('전날 출발하는 일정이에요', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '계획 저장하고 확인', exact: true }).click();
  await expect(page.getByRole('heading', { name: '강남역으로 이동', exact: true })).toBeVisible();
  await expect(page.getByText('23:20', { exact: true })).toBeVisible();
  await expect(page.getByText('00:30', { exact: true })).toBeVisible();
  await expect(page.getByText('경로 개요 · 실제 지도 아님', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '자정 이후 미팅', exact: true })).toBeVisible();
  await expect(page.getByText('23:20', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '나의 아반떼 · GPS 기록 시작', exact: true }),
  ).toBeVisible();
});

test('a denied location permission explains recovery without claiming a recording has started', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Uses Chromium permission control to test a real denied browser permission.',
  );
  await start(page);
  await page.goto('/route');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Browser.setPermission', {
    permission: { name: 'geolocation' },
    setting: 'denied',
    origin: new URL(page.url()).origin,
  });
  await page.getByRole('button', { name: '나의 아반떼 · GPS 기록 시작', exact: true }).click();
  await expect(page.getByText('잠시 확인해 주세요', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/브라우저 주소창의 사이트 설정에서 위치 권한을 허용한 뒤/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '종료하고 저장', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '나의 아반떼 · GPS 기록 시작', exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(page.getByText('주행 기록 준비', { exact: true })).toBeVisible();
});

test('mobile and desktop retain reachable controls without horizontal overflow', async ({
  page,
}) => {
  await start(page);
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('button', { name: '정비·소모품 기록', exact: true })).toBeVisible();
    // React Native dimensions update asynchronously after the browser viewport changes.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
              window.innerWidth,
          ),
        { message: `Garage horizontal overflow at ${width}px` },
      )
      .toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: '이 차량으로 이동 계획', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '출발지', exact: true })).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
              window.innerWidth,
          ),
        { message: `Plan horizontal overflow at ${width}px` },
      )
      .toBeLessThanOrEqual(1);
    const save = page.getByRole('button', { name: '계획 저장하고 확인', exact: true });
    await expect(save).toBeVisible();
    const bounds = await save.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    await page.getByRole('button', { name: '뒤로', exact: true }).click();
    await expect(page.getByRole('heading', { name: '내 차', exact: true })).toBeVisible();
  }
});

test('settings validate time limits, persist, and prefill the next plan with honest service status', async ({
  page,
}) => {
  await start(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: '내 계정', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '기기 설정 보기', exact: true }).click();
  await page.getByRole('button', { name: '운전·알림 설정', exact: true }).click();
  await page.getByRole('textbox', { name: '여유 시간 (분)', exact: true }).fill('181');
  await page.getByRole('button', { name: '기본 시간 저장', exact: true }).click();
  await expect(page.getByText('여유 시간은 180 이하여야 해요.', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '여유 시간 (분)', exact: true }).fill('30');
  await page.getByRole('textbox', { name: '도보 시간 (분)', exact: true }).fill('15');
  await page.getByRole('button', { name: '기본 시간 저장', exact: true }).click();
  await expect(
    page.getByText('기본 시간을 저장했어요. 새로 만드는 이동 계획에 적용해요.', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '기기 설정 보기', exact: true }).click();
  await page.getByRole('button', { name: '운전·알림 설정', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '여유 시간 (분)', exact: true })).toHaveValue(
    '30',
  );
  await expect(page.getByRole('textbox', { name: '도보 시간 (분)', exact: true })).toHaveValue(
    '15',
  );
  await expect(page.getByText('백그라운드 측정은 지원하지 않아요', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '서버 설정 펼치기', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /API.?키|API.?Key/i })).toHaveCount(0);
  await page.getByRole('button', { name: '내 출발 알림 관리', exact: true }).click();
  await expect(page.getByRole('heading', { name: '출발 알림', exact: true })).toBeVisible();
  await expect(page.getByText(/웹에서는 기기 알림을 예약할 수 없어요/)).toBeVisible();
  await page.getByRole('button', { name: '이동 계획 만들기', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '주차 후 도보 (분)', exact: true })).toHaveValue(
    '15',
  );
  await expect(page.getByRole('textbox', { name: '여유 시간 (분)', exact: true })).toHaveValue(
    '30',
  );
});

test('controlled browser GPS survives pause and reload, excludes the paused gap, and saves once', async ({
  page,
  context,
}) => {
  // These coordinates are browser test inputs, not evidence from a real road drive.
  await context.grantPermissions(['geolocation']);
  // Chromium's CDP setGeolocation can emit an intermediate POSITION_UNAVAILABLE while
  // changing its override. That correctly pauses the production recorder. Use explicit
  // successful sensor samples here; recorder-errors.spec.ts independently checks failures.
  await page.addInitScript(() => {
    const key = 'drivemate-test-gps-point';
    const initial = { latitude: 37.5665, longitude: 126.978, accuracy: 5 };
    if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify(initial));
    const callbacks = new Map<number, PositionCallback>();
    let nextId = 100;
    const sample = () =>
      ({
        timestamp: Date.now(),
        coords: {
          ...JSON.parse(sessionStorage.getItem(key)!),
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
      }) as GeolocationPosition;
    Object.defineProperty(navigator.geolocation, 'watchPosition', {
      configurable: true,
      value: (callback: PositionCallback) => {
        const id = ++nextId;
        callbacks.set(id, callback);
        queueMicrotask(() => {
          if (callbacks.has(id)) callback(sample());
        });
        return id;
      },
    });
    Object.defineProperty(navigator.geolocation, 'clearWatch', {
      configurable: true,
      value: (id: number) => callbacks.delete(id),
    });
    Object.assign(window, {
      __setSuccessfulGps: (point: typeof initial) => {
        sessionStorage.setItem(key, JSON.stringify(point));
        callbacks.forEach((callback) => callback(sample()));
      },
    });
  });
  const setCoordinates = async (latitude: number) =>
    page.evaluate((value) => {
      (
        window as unknown as {
          __setSuccessfulGps: (point: {
            latitude: number;
            longitude: number;
            accuracy: number;
          }) => void;
        }
      ).__setSuccessfulGps({ latitude: value, longitude: 126.978, accuracy: 5 });
    }, latitude);
  await start(page);
  await page.goto('/route');
  await page.getByRole('button', { name: '나의 아반떼 · GPS 기록 시작', exact: true }).click();
  await expect(page.getByText('GPS 측정 중', { exact: true })).toBeVisible();
  await expect(page.getByText('약 5m', { exact: true })).toBeVisible();
  // Allow realistic elapsed time so the production jump filter accepts a ~111m segment.
  await expect(page.getByText(/^0분 [2-9]초$/)).toBeVisible({ timeout: 10_000 });
  await setCoordinates(37.5675);
  await expect(page.getByText(/^0\.11\s*km$/)).toBeVisible();
  await page.getByRole('button', { name: '일시 정지', exact: true }).click();
  await expect(page.getByText('기록 일시 정지', { exact: true })).toBeVisible();
  // Moving while paused must not be joined to the next segment after recovery.
  await setCoordinates(37.58);
  await page.reload();
  await expect(page.getByText('기록 일시 정지', { exact: true })).toBeVisible();
  await expect(page.getByText(/^0\.11\s*km$/)).toBeVisible();
  await page.getByRole('button', { name: '기록 재개', exact: true }).click();
  await expect(page.getByText('GPS 측정 중', { exact: true })).toBeVisible();
  await expect(page.getByText('약 5m', { exact: true })).toBeVisible();
  await expect(page.getByText(/^0분 [4-9]초$/)).toBeVisible({ timeout: 10_000 });
  await setCoordinates(37.581);
  await expect(page.getByText(/^0\.22\s*km$/)).toBeVisible();
  await page.getByRole('button', { name: '종료하고 저장', exact: true }).click();
  await page.getByRole('button', { name: '주행 종료 · 기록 저장', exact: true }).click();
  await expect(page.getByText('주행 기록을 저장했어요', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '주행 종료 · 기록 저장', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '저장한 주행 기록 보기', exact: true }).click();
  await page.getByRole('tab', { name: '완료', exact: true }).click();
  await expect(page.getByText('GPS 측정', { exact: true })).toBeVisible();
  await expect(page.getByText(/^0\.22\s*km$/).filter({ visible: true })).toBeVisible();
  await page.goto('/');
  await expect(page.getByText('48,250.2', { exact: true }).filter({ visible: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('48,250.2', { exact: true }).filter({ visible: true })).toBeVisible();
});

test('backup export and reviewed restore preserve data and reject invalid content', async ({
  page,
}, testInfo) => {
  await start(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: '기기 설정 보기', exact: true }).click();
  await page.getByRole('button', { name: '운전·알림 설정', exact: true }).click();
  await page.getByRole('button', { name: '기기 데이터 관리', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '내 데이터 백업 내보내기', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^drivemate-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const backupPath = testInfo.outputPath('drivemate-backup.json');
  await download.saveAs(backupPath);
  const backupText = await readFile(backupPath, 'utf8');
  const backup = JSON.parse(backupText);
  expect(backup.vehicles).toHaveLength(3);
  expect(backup.settings.bufferMinutes).toBe(10);
  await page.getByRole('textbox', { name: '여유 시간 (분)', exact: true }).fill('30');
  await page.getByRole('button', { name: '기본 시간 저장', exact: true }).click();
  await page.getByRole('button', { name: '백업에서 복원하기', exact: true }).click();
  await page
    .getByRole('textbox', { name: '백업 내용 붙여넣기', exact: true })
    .fill('not valid JSON');
  await page.getByRole('button', { name: '백업 확인하기', exact: true }).click();
  await expect(page.getByText('백업을 확인해 주세요', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '현재 데이터를 백업으로 교체', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '여유 시간 (분)', exact: true })).toHaveValue(
    '30',
  );
  await page.getByRole('textbox', { name: '백업 내용 붙여넣기', exact: true }).fill(backupText);
  await page.getByRole('button', { name: '백업 확인하기', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '이 백업으로 바꿀까요?', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('현재 데이터 전체를 교체해요', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '현재 데이터를 백업으로 교체', exact: true }).click();
  await expect(
    page.getByText('백업을 복원했어요. 기기 출발 알림은 필요한 일정에서 다시 켜 주세요.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: '여유 시간 (분)', exact: true })).toHaveValue(
    '10',
  );
  await page.reload();
  await page.getByRole('button', { name: '기기 설정 보기', exact: true }).click();
  await page.getByRole('button', { name: '운전·알림 설정', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '여유 시간 (분)', exact: true })).toHaveValue(
    '10',
  );
  await page.goto('/');
  await page.getByRole('button', { name: '차량 선택', exact: true }).click();
  await expect(page.getByRole('button', { name: '나의 아반떼', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '아이오닉 5', exact: true })).toBeVisible();
});
