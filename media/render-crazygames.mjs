#!/usr/bin/env node
/**
 * CrazyGames store media: three covers and two preview videos, captured from the production
 * build.
 *
 * Nothing is staged. Every frame is the real game driven by real input (mouse, wheel, keys) in
 * Chromium, and the cursor is never drawn. Playwright's clock is installed frozen and advanced
 * exactly one 1/30 s step per captured frame, so the video is perfectly even however long a
 * frame takes to render. Frames render on the GPU at devicePixelRatio 2 and are downscaled
 * with lanczos.
 *
 * Each video opens on its cover — the same picture with the HUD hidden and the title set over
 * it, as the portal asks — and crossfades into play. Storyboard, 18 s, from 09:18 on sol 1:
 *   0.55  the camera pans the colony into the lane the HUD columns leave clear
 *   0.9   Solar Array from the build bar; the placement ghost glides onto a tile; placed
 *   3.3   the new array selected: the inspector says what it makes
 *   5.9   4×: the founding rocket lifts off at noon while the camera pulls back
 *   9.1   a slow orbit through sunset into night: lights on, batteries carrying the load
 *   13.0  16× through the night, back to 1× on sol 2's morning, slow push-in to the end
 *
 * Framings and click points were tuned at devicePixelRatio 2 and hold only there: held keys
 * and wheel input landing in the same frame do not combine identically at DPR 1.
 *
 * Usage:
 *   npm run render:crazygames
 *
 * Requires macOS (Chromium on Metal; software WebGL would take about an hour) and ffmpeg on
 * PATH. Every file is checked against the portal's requirements
 * (docs.crazygames.com/requirements/game-covers) before it is copied to media/crazygames/;
 * a violation throws and leaves the previous files in place.
 */
/* global document, localStorage -- read inside page.evaluate callbacks, which run in the page */
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {[number, number]} Point */
/** @typedef {{ width: number, height: number }} Size */
/** @typedef {'landscape' | 'portrait'} VideoFormat */
/** @typedef {VideoFormat | 'square'} CoverFormat */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'media', 'crazygames');

const FPS = 30;
const SECONDS = 18;
const DPR = 2;
const GPU_ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
const PREVIEW_PORT = 5300;
/** Any fixed instant: the game only ever sees time advance from it. */
const CLOCK_START = new Date('2026-10-16T08:00:00Z');
/** Morning light on sol 1, before the founding rocket leaves at noon. */
const COVER_HOUR = 9.3;
/** A sol is 60 s at 1×, so at 16× one game hour passes in 156.25 ms. */
const MS_PER_GAME_HOUR_AT_16X = 156.25;

/**
 * Cover framings, reached through real input after the clock is at the cover hour. Drag
 * distances are per viewport height because OrbitControls turns by 2π·dx/height.
 * @type {Record<CoverFormat, { zoom: number, dxPerHeight: number, dyPerHeight: number, pans: Array<[string, number]> }>}
 */
const FRAMINGS = {
  landscape: {
    zoom: 13,
    dxPerHeight: -0.25,
    dyPerHeight: -15 / 1080,
    pans: [
      ['KeyA', 350],
      ['KeyW', 350],
    ],
  },
  portrait: {
    zoom: 9,
    dxPerHeight: -0.25,
    dyPerHeight: -0.02,
    pans: [
      ['KeyD', 250],
      ['KeyW', 450],
    ],
  },
  square: {
    zoom: 12,
    dxPerHeight: -0.25,
    dyPerHeight: -11 / 800,
    pans: [
      ['KeyD', 150],
      ['KeyW', 250],
    ],
  },
};

/**
 * The covers push the colony aside to make room for the title, where in play the HUD columns
 * would hide it. The video's first second pans it back and pulls out, frame by frame.
 * keys: [code, fromFrame, toFrame) held; wheel: [fromFrame, toFrame, deltaPerFrame].
 * @type {Record<VideoFormat, { frames: number, keys: Array<[string, number, number]>, wheel: [number, number, number] }>}
 */
const RECENTER = {
  landscape: { frames: 20, keys: [['KeyD', 0, 10]], wheel: [0, 20, 7] },
  portrait: {
    frames: 24,
    keys: [
      ['KeyD', 0, 2],
      ['KeyW', 0, 6],
    ],
    wheel: [0, 24, 16],
  },
};

/**
 * Per-format video settings. `place` is a free tile for the new Solar Array; `sky` is where
 * the pointer rests during camera moves, off the buildings so no hover card opens.
 * @type {Record<VideoFormat, Size & { place: Point, sky: Point, pullOut: number }>}
 */
const VIDEOS = {
  landscape: { width: 1920, height: 1080, place: [0.4, 0.7], sky: [0.3, 0.16], pullOut: 7 },
  portrait: { width: 1080, height: 1620, place: [0.35, 0.68], sky: [0.5, 0.2], pullOut: 5 },
};

/** @type {Record<CoverFormat, Size>} */
const CAPTURE_SIZES = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1620 },
  square: { width: 800, height: 800 },
};

/** @type {Array<{ format: CoverFormat, file: string } & Size>} */
const COVERS = [
  { format: 'landscape', file: 'cover-landscape-1920x1080.png', width: 1920, height: 1080 },
  { format: 'portrait', file: 'cover-portrait-800x1200.png', width: 800, height: 1200 },
  { format: 'square', file: 'cover-square-800x800.png', width: 800, height: 800 },
];

/**
 * The game's name only, set like the logo lockup (heavy grotesque, wide tracking, warm white
 * over cyan) on a soft scrim so it reads at thumbnail size against the bright sky.
 * @type {Record<CoverFormat, { scrim: string, box: string, size: string }>}
 */
const TITLE_LAYOUTS = {
  landscape: {
    scrim:
      'radial-gradient(ellipse 62% 70% at 14% 16%, rgba(20,11,8,0.78) 0%, rgba(20,11,8,0.45) 45%, rgba(20,11,8,0) 100%)',
    box: 'left:5.2%;top:8%;text-align:left;',
    size: '6.2vw',
  },
  portrait: {
    scrim:
      'linear-gradient(to top, rgba(20,11,8,0.88) 0%, rgba(20,11,8,0.6) 22%, rgba(20,11,8,0) 44%)',
    box: 'left:0;right:0;bottom:6.5%;text-align:center;',
    size: '9.4vw',
  },
  square: {
    scrim:
      'linear-gradient(to top, rgba(20,11,8,0.88) 0%, rgba(20,11,8,0.55) 26%, rgba(20,11,8,0) 50%)',
    box: 'left:0;right:0;bottom:7%;text-align:center;',
    size: '9.2vw',
  },
};

/** The portal's limits, plus the checks that make "smooth" and "opens on the cover" testable. */
const REQUIREMENTS = {
  videoMinSeconds: 15,
  videoMaxSeconds: 20,
  /** Read as decimal megabytes, the stricter of the two readings of the portal's "50MB". */
  videoMaxBytes: 50_000_000,
  /** Frame 0 against its cover; below this it is a different picture. */
  coverMatchSsim: 0.95,
  /** A frame-to-frame scene score above this is a cut or a jump; the storyboard has none. */
  maxSceneScore: 0.25,
  /** The opening hold on the cover is 0.2 s; any longer frozen run reads as a stall. */
  maxFrozenFrames: 6,
};

const frameAt = (seconds) => Math.round(seconds * FPS);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const scalePoint = ([fx, fy], { width, height }) => [width * fx, height * fy];

// ---------------------------------------------------------------------------------------------
// External tools

const runTool = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}: ${result.stderr.slice(-2000)}`,
    );
  }
  return result;
};

const ffmpeg = (args) => runTool('ffmpeg', ['-hide_banner', '-nostdin', ...args]).stderr;

const probe = (path) =>
  JSON.parse(
    runTool('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      path,
    ]).stdout,
  );

/** Checked up front so a missing tool fails now, not after minutes of capture. */
const assertTools = () => {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const result = spawnSync(tool, ['-version']);
    if (result.error) {
      throw new Error(
        `${tool} is required on PATH to encode and check the videos (brew install ffmpeg): ${result.error.message}`,
      );
    }
  }
};

/** Software WebGL renders a 4K frame in seconds; refuse to start rather than run for an hour. */
const assertHardwareWebgl = async () => {
  const browser = await chromium.launch({ args: GPU_ARGS });
  try {
    const page = await browser.newPage();
    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
    });
    if (/swiftshader|llvmpipe|unavailable/i.test(renderer)) {
      throw new Error(
        `Chromium has no hardware WebGL (renderer: ${renderer}); this script needs macOS with Metal`,
      );
    }
    console.log('webgl', { renderer });
  } finally {
    await browser.close();
  }
};

/** Builds the game into `workDir` and serves it the way a portal would: static files only. */
const serveBuild = async (workDir) => {
  const outDir = join(workDir, 'build');
  await build({ root: ROOT, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
  const server = await preview({
    root: ROOT,
    logLevel: 'warn',
    build: { outDir },
    preview: { host: '127.0.0.1', port: PREVIEW_PORT, strictPort: true, open: false },
  });
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error(`vite preview reported no local URL for ${outDir}`);
  return { url, close: () => server.close() };
};

// ---------------------------------------------------------------------------------------------
// Driving the game

/**
 * Opens the game with onboarding seen and its clock frozen; everything moves through `step`.
 * `close` returns the errors the page threw, which callers report with any capture failure.
 */
const openGame = async (url, { width, height }) => {
  const browser = await chromium.launch({ args: GPU_ARGS });
  try {
    return await prepareGame(browser, url, { width, height });
  } catch (error) {
    await browser.close();
    throw error;
  }
};

const prepareGame = async (browser, url, { width, height }) => {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: DPR });
  await context.addInitScript(() => localStorage.setItem('living-machine.onboarding.seen', '1'));
  const page = await context.newPage();
  /** @type {string[]} */
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.clock.install({ time: CLOCK_START });
  await page.goto(url);
  // The clock runs in real time until paused, and Playwright cannot pause it in the past: on
  // a slow load, pause just ahead of where it already is.
  const pageNow = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(Math.max(CLOCK_START.getTime() + 1000, pageNow + 250)));
  await page.waitForSelector('canvas');
  await page.clock.runFor(500);
  const cdp = await context.newCDPSession(page);

  const game = {
    page,
    size: { width, height },
    /** Advances game and render time together; rAF fires every 16 ms of virtual time. */
    step: (ms) => page.clock.runFor(ms),
    /** Without an explicit clip scale CDP returns CSS-pixel size and drops the 2× render. */
    shot: async (format) => {
      const { data } = await cdp.send('Page.captureScreenshot', {
        format,
        ...(format === 'jpeg' ? { quality: 95 } : {}),
        clip: { x: 0, y: 0, width, height, scale: DPR },
      });
      return Buffer.from(data, 'base64');
    },
    /** The HUD layer is the one element the app scales with an inline transform. */
    hideHud: (hidden) =>
      page.evaluate((hide) => {
        let style = document.getElementById('capture-hide-hud');
        if (!style) {
          style = document.createElement('style');
          style.id = 'capture-hide-hud';
          document.head.appendChild(style);
        }
        style.textContent = hide ? 'div[style*="scale("] { visibility: hidden !important; }' : '';
      }, hidden),
    clockHours: async () => {
      const [hours, minutes] = (
        await page
          .getByText(/^\d{2}:\d{2}$/)
          .first()
          .innerText()
      )
        .split(':')
        .map(Number);
      return hours + minutes / 60;
    },
    sol: async () => Number(await page.getByTestId('sol-counter').innerText()),
    minerals: async () =>
      Number(
        (await page.getByTestId('resource-minerals-stock').innerText()).replace(/[^\d.-]/g, ''),
      ),
    button: (name) => page.getByRole('button', { name, exact: true }),
    center: async (locator) => {
      const box = await locator.boundingBox();
      if (!box) throw new Error(`no bounding box for ${locator}`);
      return [box.x + box.width / 2, box.y + box.height / 2];
    },
    speed: (label) => game.button(label).click({ force: true }),
    /**
     * Runs to `hours` on `sol`, then pauses. The HUD clock refreshes at 4 Hz — over an hour
     * of game time at 16× — so it is read only while paused and the run is a computed span.
     */
    advanceTo: async (sol, hours) => {
      await game.speed('❚❚');
      await game.step(300);
      const gameHours = (sol - (await game.sol())) * 24 + (hours - (await game.clockHours()));
      if (gameHours <= 0) return;
      await game.speed('16×');
      await game.step(gameHours * MS_PER_GAME_HOUR_AT_16X);
      await game.speed('❚❚');
      await game.step(300);
    },
    /** Chromium divides a dispatched wheel delta by the emulated DPR, so it is pre-multiplied. */
    wheel: (deltaY) => page.mouse.wheel(0, deltaY * DPR),
    holdKey: async (code, ms) => {
      await page.keyboard.down(code);
      await game.step(ms);
      await page.keyboard.up(code);
    },
    close: async () => {
      await browser.close();
      return [...pageErrors];
    },
  };
  return game;
};

/**
 * Opens the game at a format's cover framing, runs `capture` on it and always closes the
 * browser. Errors the page threw are reported alongside whatever failed: they are usually why.
 */
const withScene = async (url, format, capture) => {
  const game = await openGame(url, CAPTURE_SIZES[format]);
  let result;
  try {
    await frameScene(game, format);
    result = await capture(game);
  } catch (error) {
    const pageErrors = await game.close();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${format} capture failed: ${[reason, ...pageErrors.map((e) => `page error: ${e}`)].join(' | ')}`,
      { cause: error },
    );
  }
  const pageErrors = await game.close();
  if (pageErrors.length > 0) {
    throw new Error(`${format}: the game threw during capture: ${pageErrors.join(' | ')}`);
  }
  return result;
};

/** The cover framing: clock to the cover hour, then zoom, orbit and pan by real input. */
const frameScene = async (game, format) => {
  const size = CAPTURE_SIZES[format];
  const framing = FRAMINGS[format];
  await game.advanceTo(1, COVER_HOUR);

  await game.page.mouse.move(size.width / 2, size.height / 2);
  for (let tick = 0; tick < framing.zoom; tick++) {
    await game.wheel(-120);
    await game.step(50);
  }
  await game.step(1500);

  const [x0, y0] = [size.width * 0.5, size.height * 0.85];
  const [dx, dy] = [framing.dxPerHeight * size.height, framing.dyPerHeight * size.height];
  await game.page.mouse.move(x0, y0);
  await game.page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await game.page.mouse.move(x0 + (dx * i) / 20, y0 + (dy * i) / 20);
    await game.step(16);
  }
  await game.page.mouse.up();
  await game.step(1500);

  for (const [code, ms] of framing.pans) {
    await game.holdKey(code, ms);
    await game.step(1200);
  }
};

/** The cover still: HUD hidden, title over the scene. Leaves the scene as it found it. */
const captureCover = async (game, format) => {
  await game.hideHud(true);
  await game.page.evaluate(
    ({ layout, id }) => {
      const root = document.createElement('div');
      root.id = id;
      root.setAttribute(
        'style',
        `position:fixed;inset:0;z-index:100;pointer-events:none;background:${layout.scrim};`,
      );
      const title = document.createElement('div');
      title.setAttribute(
        'style',
        `position:absolute;${layout.box}font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;` +
          `font-weight:700;font-size:${layout.size};line-height:1.02;letter-spacing:0.09em;` +
          'text-shadow:0 0.04em 0.18em rgba(0,0,0,0.55);',
      );
      title.innerHTML =
        '<div style="color:#F2EDE6">LIVING MARS</div><div style="color:#4FC3F7">MACHINE</div>';
      root.appendChild(title);
      document.body.appendChild(root);
    },
    { layout: TITLE_LAYOUTS[format], id: 'cover-title' },
  );
  await game.step(50);
  const png = await game.shot('png');
  await game.page.evaluate(() => document.getElementById('cover-title')?.remove());
  await game.hideHud(false);
  await game.step(50);
  return png;
};

/** Pipes JPEG frames into an x264 encode at near-lossless quality; `finish` awaits the file. */
const startEncoder = (outPath, { width, height }) => {
  const encoder = spawn(
    'ffmpeg',
    // prettier-ignore
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      // CDP JPEGs are full-range BT.601; the delivery is TV-range BT.709.
      '-vf', `scale=${width}:${height}:flags=lanczos:in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '10', '-an',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      outPath,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  /** @type {Error | null} */
  let pipeError = null;
  // EPIPE once ffmpeg has died; the exit below reports it together with the exit status.
  encoder.stdin.on('error', (error) => (pipeError = error));
  const closed = new Promise((resolve, reject) => {
    encoder.on('error', reject);
    encoder.on('close', (code, signal) =>
      code === 0
        ? resolve(undefined)
        : reject(
            new Error(
              `ffmpeg encode of ${outPath} exited ${code ?? signal}${pipeError ? ` (${pipeError.message})` : ''}`,
            ),
          ),
    );
  });
  // Awaited by write and finish; this only keeps an early exit from crashing the process as
  // an unhandled rejection before either has awaited it.
  closed.catch(() => undefined);
  return {
    /** Waits for the pipe to drain, or rejects with the exit if ffmpeg died. */
    write: async (frame) => {
      if (encoder.stdin.write(frame)) return;
      await Promise.race([new Promise((resolve) => encoder.stdin.once('drain', resolve)), closed]);
    },
    finish: async () => {
      encoder.stdin.end();
      await closed;
    },
    /** For a failed capture: the partial file is discarded with the work directory. */
    abort: async () => {
      encoder.kill('SIGKILL');
      await closed.catch(() => undefined);
    },
  };
};

/** Captures one format from its cover framing: the cover still and the 18 s storyboard. */
const captureVideo = async (game, format, workDir) => {
  const video = VIDEOS[format];
  const recenter = RECENTER[format];
  const { page } = game;
  const coverPath = join(workDir, `${format}-cover.png`);
  const gameplayPath = join(workDir, `${format}-gameplay.mp4`);
  writeFileSync(coverPath, await captureCover(game, format));
  // Unpause without stepping the clock: gameplay frame 0 is still the cover's scene.
  await page.mouse.click(...(await game.center(game.button('1×'))));

  const place = scalePoint(video.place, video);
  const sky = scalePoint(video.sky, video);
  let pointer = [video.width / 2, video.height / 2];
  /** @type {{ from: Point, to: Point, start: number, end: number } | null} */
  let tween = null;
  const glide = (to, seconds, frame) => {
    tween = { from: pointer, to, start: frame, end: frame + frameAt(seconds) };
  };
  let mode = 'play';
  let dragging = false;
  let pushIn = false;
  let mineralsBefore = 0;

  /** @type {Map<number, (frame: number) => Promise<unknown>>} */
  const events = new Map();
  const on = (seconds, action) => {
    const frame = frameAt(seconds);
    if (events.has(frame)) throw new Error(`two storyboard events land on frame ${frame}`);
    events.set(frame, action);
  };
  on(0.9, async (f) =>
    glide(await game.center(page.getByRole('button', { name: /^Solar Array/ })), 0.55, f),
  );
  on(1.5, () => page.mouse.click(...pointer));
  on(1.65, async (f) => glide(place, 1.05, f));
  on(2.7, async () => (mineralsBefore = await game.minerals()));
  // Escape in the click's frame: leaving build mode at once keeps the ghost from turning red
  // over the tile it has just filled.
  on(2.8, async () => {
    await page.mouse.click(...place);
    await page.keyboard.press('Escape');
  });
  on(3.25, async () => {
    const after = await game.minerals();
    if (!(after < mineralsBefore)) {
      throw new Error(
        `${format}: no Solar Array was placed at ${video.place} (minerals ${mineralsBefore} -> ${after})`,
      );
    }
  });
  // A click must hit the array's mesh: the tile in front of it clears the selection instead.
  // Walk up from the tile until the hover card names the array. The probe is never drawn.
  on(3.3, async () => {
    for (const dy of [0, -0.02, -0.04, -0.06, -0.08, -0.1, -0.12]) {
      const probePoint = [place[0], place[1] + dy * video.height];
      await page.mouse.move(...probePoint);
      await page.waitForTimeout(80);
      const hint = page.getByText('Click for details');
      if (
        (await hint.isVisible()) &&
        (await hint.locator('..').innerText()).includes('Solar Array')
      ) {
        await page.mouse.click(...probePoint);
        pointer = probePoint;
        return;
      }
    }
    throw new Error(`${format}: no point above ${video.place} hovers the new Solar Array`);
  });
  on(3.8, async () => {
    if (!(await game.button('Idle').isVisible())) {
      throw new Error(`${format}: selecting the new Solar Array did not open the inspector`);
    }
  });
  on(5.55, () => page.keyboard.press('Escape'));
  on(5.65, async (f) => glide(await game.center(game.button('4×')), 0.25, f));
  on(5.95, () => page.mouse.click(...pointer));
  on(6.2, async (f) => glide(sky, 0.35, f));
  on(6.75, async () => (mode = 'pull-out'));
  on(8.95, async () => (mode = 'play'));
  on(9.1, async () => {
    await page.mouse.down();
    dragging = true;
  });
  on(12.6, async () => {
    await page.mouse.up();
    dragging = false;
  });
  on(12.75, async (f) => glide(await game.center(game.button('16×')), 0.2, f));
  on(13.0, async () => {
    await page.mouse.click(...pointer);
    mode = 'to-morning';
  });
  on(13.1, async (f) => glide(sky, 0.25, f));
  on(13.4, async () => (pushIn = true));

  const recenterStart = frameAt(0.55);
  const encoder = startEncoder(gameplayPath, video);
  try {
    const total = frameAt(SECONDS);
    for (let frame = 0; frame < total; frame++) {
      // Frame 0 is captured before anything moves, so it matches the cover.
      if (frame > 0) {
        const r = frame - recenterStart;
        if (r >= 0 && r <= recenter.frames) {
          if (r === 0) {
            pointer = sky;
            await page.mouse.move(...sky);
          }
          for (const [code, from, to] of recenter.keys) {
            if (r === from) await page.keyboard.down(code);
            if (r === to) await page.keyboard.up(code);
          }
          const [wheelFrom, wheelTo, delta] = recenter.wheel;
          if (r >= wheelFrom && r < wheelTo) await game.wheel(delta);
        }

        const action = events.get(frame);
        if (action) await action(frame);

        if (tween) {
          const t = Math.min(1, (frame - tween.start) / (tween.end - tween.start));
          const k = easeInOutCubic(t);
          pointer = [
            tween.from[0] + (tween.to[0] - tween.from[0]) * k,
            tween.from[1] + (tween.to[1] - tween.from[1]) * k,
          ];
          await page.mouse.move(...pointer);
          if (t >= 1) tween = null;
        }
        if (mode === 'pull-out') await game.wheel(video.pullOut);
        if (dragging) {
          pointer = [pointer[0] + 0.3 * (video.height / 1080), pointer[1]];
          await page.mouse.move(...pointer);
        }
        if (mode === 'to-morning') {
          const hours = await game.clockHours();
          if ((await game.sol()) >= 2 && hours >= 7.9 && hours < 12) {
            // The cursor is never drawn, so the hop to the button and back does not show.
            await page.mouse.click(...(await game.center(game.button('1×'))));
            await page.mouse.move(...pointer);
            mode = 'play';
          }
        }
        // A slow push-in carries the last seconds, so the closing morning is never a still.
        if (pushIn && !tween) await game.wheel(-3);
        await game.step(1000 / FPS);
      }
      await encoder.write(await game.shot('jpeg'));
    }
    if (mode === 'to-morning') {
      throw new Error(
        `${format}: sol 2's morning never came within ${SECONDS} s; the video ends at 16×`,
      );
    }
  } catch (error) {
    await encoder.abort();
    throw error;
  }
  await encoder.finish();
  return { coverPath, gameplayPath };
};

// ---------------------------------------------------------------------------------------------
// Delivery

const downscale = (input, output, { width, height }) =>
  ffmpeg([
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-vf',
    `scale=${width}:${height}:flags=lanczos`,
    output,
  ]);

/** The cover held 0.2 s, a 0.5 s crossfade into play; H.264 High, BT.709, no audio track. */
const composeVideo = (coverPath, gameplayPath, output) =>
  // prettier-ignore
  ffmpeg([
    '-loglevel', 'error', '-y',
    '-loop', '1', '-framerate', String(FPS), '-t', '0.7', '-i', coverPath,
    '-i', gameplayPath,
    '-filter_complex',
    `[0:v]fps=${FPS},scale=out_range=tv:out_color_matrix=bt709,format=yuv420p,setsar=1,settb=AVTB[c];` +
      `[1:v]fps=${FPS},format=yuv420p,setsar=1,settb=AVTB[g];` +
      '[c][g]xfade=transition=fade:duration=0.5:offset=0.2,format=yuv420p,' +
      'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[v]',
    '-map', '[v]', '-an',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-r', String(FPS),
    output,
  ]);

const verifyCover = (path, { width, height }) => {
  const stream = probe(path).streams[0];
  if (stream?.width !== width || stream?.height !== height) {
    throw new Error(`${path} is ${stream?.width}x${stream?.height}, expected ${width}x${height}`);
  }
  console.log('verified cover', {
    file: path,
    width,
    height,
    kilobytes: Math.round(statSync(path).size / 1024),
  });
};

/** Checks one delivered video against the portal's rules and the storyboard's own promises. */
const verifyVideo = (path, coverPath, { width, height }, workDir) => {
  const facts = probe(path);
  const video = facts.streams.filter((s) => s.codec_type === 'video');
  const audio = facts.streams.filter((s) => s.codec_type === 'audio');
  const seconds = Number(facts.format.duration);
  const bytes = Number(facts.format.size);
  const stream = video[0];
  const problems = [
    video.length !== 1 && `${video.length} video streams`,
    audio.length !== 0 && 'has an audio track',
    stream?.codec_name !== 'h264' && `codec ${stream?.codec_name}`,
    stream?.pix_fmt !== 'yuv420p' && `pixel format ${stream?.pix_fmt}`,
    (stream?.width !== width || stream?.height !== height) && `${stream?.width}x${stream?.height}`,
    stream?.r_frame_rate !== `${FPS}/1` && `frame rate ${stream?.r_frame_rate}`,
    (seconds < REQUIREMENTS.videoMinSeconds || seconds > REQUIREMENTS.videoMaxSeconds) &&
      `${seconds} s long`,
    bytes > REQUIREMENTS.videoMaxBytes && `${bytes} bytes`,
  ].filter(Boolean);

  const frame0 = join(workDir, 'frame0.png');
  ffmpeg(['-loglevel', 'error', '-y', '-i', path, '-frames:v', '1', frame0]);
  const ssim = Number(
    /All:([\d.]+)/.exec(
      ffmpeg(['-i', frame0, '-i', coverPath, '-lavfi', 'ssim', '-f', 'null', '-']),
    )?.[1],
  );
  if (!(ssim >= REQUIREMENTS.coverMatchSsim))
    problems.push(`frame 0 does not match the cover (SSIM ${ssim})`);

  const scenes = join(workDir, 'scenes.txt');
  ffmpeg([
    '-loglevel',
    'error',
    '-i',
    path,
    '-vf',
    `select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=${scenes}`,
    '-f',
    'null',
    '-',
  ]);
  const scores = [...readFileSync(scenes, 'utf8').matchAll(/scene_score=([\d.]+)/g)].map((m) =>
    Number(m[1]),
  );
  const frameCount = Number(stream?.nb_frames);
  // An empty or partial read must not pass as "no jumps".
  if (scores.length !== frameCount) {
    problems.push(`scene scores read for ${scores.length} of ${frameCount} frames`);
  }
  const maxScene = Math.max(0, ...scores);
  if (!(maxScene < REQUIREMENTS.maxSceneScore))
    problems.push(`a jump between frames (scene score ${maxScene})`);

  // mpdecimate drops near-identical frames; the gaps between the survivors are frozen runs.
  const kept = [
    ...ffmpeg(['-i', path, '-vf', 'mpdecimate,showinfo', '-f', 'null', '-']).matchAll(
      /pts_time:([\d.]+)/g,
    ),
  ].map((m) => Number(m[1]));
  if (kept.length === 0) problems.push('mpdecimate reported no frames');
  // The end of the video closes the last gap, so a freeze at the tail is measured too.
  const marks = [...kept, seconds];
  const longestFreeze = Math.max(
    0,
    ...marks.slice(1).map((t, i) => Math.round((t - (marks[i] ?? 0)) * FPS) - 1),
  );
  if (longestFreeze > REQUIREMENTS.maxFrozenFrames)
    problems.push(`frozen for ${longestFreeze} frames`);

  if (problems.length > 0)
    throw new Error(`${path} fails the CrazyGames checks: ${problems.join('; ')}`);
  console.log('verified video', {
    file: path,
    seconds,
    megabytes: Number((bytes / 1e6).toFixed(1)),
    coverSsim: Number(ssim.toFixed(3)),
    maxSceneScore: Number(maxScene.toFixed(3)),
    longestFreezeFrames: longestFreeze,
  });
};

/** Captures, composes and verifies in `workDir`; only files that pass reach media/crazygames. */
const render = async (workDir) => {
  const server = await serveBuild(workDir);
  /** @type {Record<CoverFormat, string>} */
  const rawCovers = { landscape: '', portrait: '', square: '' };
  /** @type {Record<VideoFormat, string>} */
  const gameplay = { landscape: '', portrait: '' };
  try {
    for (const format of /** @type {VideoFormat[]} */ (['landscape', 'portrait'])) {
      const started = Date.now();
      const capture = await withScene(server.url, format, (game) =>
        captureVideo(game, format, workDir),
      );
      rawCovers[format] = capture.coverPath;
      gameplay[format] = capture.gameplayPath;
      console.log('captured', {
        format,
        frames: frameAt(SECONDS),
        seconds: Math.round((Date.now() - started) / 1000),
      });
    }
    rawCovers.square = await withScene(server.url, 'square', async (game) => {
      const path = join(workDir, 'square-cover.png');
      writeFileSync(path, await captureCover(game, 'square'));
      return path;
    });
  } finally {
    await server.close();
  }

  const stage = join(workDir, 'out');
  mkdirSync(stage, { recursive: true });
  for (const cover of COVERS) downscale(rawCovers[cover.format], join(stage, cover.file), cover);
  // Each video opens on its cover at the video's own size.
  const landscapeStill = join(stage, 'cover-landscape-1920x1080.png');
  const portraitStill = join(workDir, 'portrait-still-1080x1620.png');
  downscale(rawCovers.portrait, portraitStill, VIDEOS.portrait);
  const videos = [
    { file: 'preview-landscape-1920x1080.mp4', still: landscapeStill, format: 'landscape' },
    { file: 'preview-portrait-1080x1620.mp4', still: portraitStill, format: 'portrait' },
  ];
  for (const { file, still, format } of videos) {
    composeVideo(still, gameplay[format], join(stage, file));
  }

  for (const cover of COVERS) verifyCover(join(stage, cover.file), cover);
  for (const { file, still, format } of videos) {
    verifyVideo(join(stage, file), still, VIDEOS[format], workDir);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  for (const file of [...COVERS.map((cover) => cover.file), ...videos.map((v) => v.file)]) {
    copyFileSync(join(stage, file), join(OUT_DIR, file));
  }
  console.log('delivered', { dir: OUT_DIR });
};

const main = async () => {
  assertTools();
  await assertHardwareWebgl();
  const workDir = mkdtempSync(join(tmpdir(), 'lmm-crazygames-'));
  try {
    await render(workDir);
  } catch (error) {
    console.error('render failed; intermediate files kept for inspection', { workDir });
    throw error;
  }
  rmSync(workDir, { recursive: true, force: true });
};

await main();
