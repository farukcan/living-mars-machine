import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Marketing trailer: play the opening colony and record the page as WebM.
 *
 * This is not a regression test. Playwright config ignores the file unless RENDER_TRAILER=1
 * so `npm run test:e2e` stays a check of behaviour. Reproduce with `npm run render:trailer`.
 *
 * Storyboard: paused dawn with the founding rocket, dismiss orientation, place a Solar Array,
 * lift-off at noon, then nightfall.
 */

const TRAILER_PATH = path.resolve('media/trailer.webm');

test.use({
  viewport: { width: 1280, height: 720 },
  video: { mode: 'on', size: { width: 1280, height: 720 } },
});

async function waitForCanvas(page: Page) {
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect
    .poll(async () => canvas.evaluate((element: HTMLCanvasElement) => element.width), {
      timeout: 45_000,
    })
    .toBeGreaterThan(0);
}

async function hold(page: Page, milliseconds: number) {
  await page.waitForTimeout(milliseconds);
}

/** Reads the HUD clock, e.g. "07:45" → 7.75 hours. */
async function readClockHours(page: Page): Promise<number> {
  const text =
    (await page
      .getByText(/^\d{2}:\d{2}$/)
      .first()
      .textContent()) ?? '00:00';
  const [hours, minutes] = text.split(':').map(Number);
  return (hours ?? 0) + (minutes ?? 0) / 60;
}

async function readStock(page: Page, kind: string): Promise<number> {
  const text = await page.getByTestId(`resource-${kind}-stock`).innerText();
  return Number(text.replace(/[^\d.-]/g, ''));
}

/**
 * Fewer wheel ticks than the screenshot helper: each wheel forces a SwiftShader frame, and
 * the trailer is already recording every one of those frames.
 */
async function frameColony(page: Page): Promise<void> {
  const box = await page.locator('canvas').boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < 6; step++) {
    await page.mouse.wheel(0, -120);
  }
  await page.waitForTimeout(800);
}

async function placeSolarArray(page: Page): Promise<void> {
  const before = await readStock(page, 'minerals');
  await page.getByRole('button', { name: /Solar Array/ }).click();
  await expect(page.getByRole('button', { name: /Cancel placement/ })).toBeVisible();

  const box = await page.locator('canvas').boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  for (const offsetY of [0.62, 0.5, 0.72, 0.42]) {
    for (const offsetX of [-0.3, -0.2, 0.2, 0.3, -0.1, 0.1, 0]) {
      const x = box.x + box.width * (0.5 + offsetX);
      const y = box.y + box.height * offsetY;
      await page.mouse.click(x, y);
      for (let attempt = 0; attempt < 5; attempt++) {
        await page.waitForTimeout(120);
        const after = await readStock(page, 'minerals');
        if (after < before) {
          await page.keyboard.press('Escape');
          await hold(page, 600);
          return;
        }
      }
    }
  }
  throw new Error('No click placed a Solar Array anywhere on the colony');
}

test.afterEach(async ({ page }) => {
  const video = page.video();
  if (!video) return;
  await page.close();
  fs.mkdirSync(path.dirname(TRAILER_PATH), { recursive: true });
  await video.saveAs(TRAILER_PATH);
  expect(fs.statSync(TRAILER_PATH).size).toBeGreaterThan(10_000);
});

test('records a marketing trailer of the opening colony', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await waitForCanvas(page);

  // Pause before the founding rocket walks off the pad at midday.
  await page.getByRole('button', { name: '❚❚' }).click();
  await hold(page, 400);
  await frameColony(page);
  await hold(page, 1200);

  await page.getByRole('button', { name: 'Got it' }).click();
  await hold(page, 500);

  const flows = page.getByRole('button', { name: 'Flows' });
  if (await flows.isVisible()) await flows.click();

  await placeSolarArray(page);

  // 4×: founding rocket lifts off around noon, then the sun sets at 18:00.
  await page.getByRole('button', { name: '4×' }).click();
  await expect
    .poll(async () => readClockHours(page), { timeout: 90_000, intervals: [250] })
    .toBeGreaterThan(12);
  await hold(page, 2000);

  await expect
    .poll(async () => readClockHours(page), { timeout: 90_000, intervals: [250] })
    .toBeGreaterThan(18.5);
  await page.getByRole('button', { name: '❚❚' }).click();
  await hold(page, 2000);
});
