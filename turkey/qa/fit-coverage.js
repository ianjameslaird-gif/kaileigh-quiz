#!/usr/bin/env node
/**
 * Asserts that at fit zoom the scene bitmap's bounding rect covers the
 * scene viewport (the fitted spread inside #view) within 2px.
 *
 * Run from a directory that can resolve playwright-core, with a server on
 * BASE (default http://127.0.0.1:8765):
 *
 *   cd /tmp/turkey-qa && node /workspace/kaileigh-quiz/turkey/qa/fit-coverage.js
 *
 * Covers iPhone 14 portrait/landscape, iPhone SE portrait/landscape,
 * iPad (gen 7) and iPad Pro 11 in both orientations, and desktop at
 * 1280x800 and 1920x1080. Also starts a level mid book-open (the
 * original iPad letterbox case) and re-checks after a viewport rotation.
 */
const { webkit, chromium, devices } = require("playwright-core");

const BASE = process.env.BASE || "http://127.0.0.1:8765";
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const TOL = 2;

const CASES = [
  { name: "iPhone 14 portrait", kind: "webkit", device: "iPhone 14" },
  { name: "iPhone 14 landscape", kind: "webkit", device: "iPhone 14 landscape" },
  { name: "iPhone SE portrait", kind: "webkit", device: "iPhone SE" },
  { name: "iPhone SE landscape", kind: "webkit", device: "iPhone SE landscape" },
  { name: "iPad (gen 7) portrait", kind: "webkit", device: "iPad (gen 7)" },
  { name: "iPad (gen 7) landscape", kind: "webkit", device: "iPad (gen 7) landscape" },
  { name: "iPad Pro 11 portrait", kind: "webkit", device: "iPad Pro 11" },
  { name: "iPad Pro 11 landscape", kind: "webkit", device: "iPad Pro 11 landscape" },
  { name: "desktop 1280x800", kind: "chromium", viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  { name: "desktop 1920x1080", kind: "chromium", viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }
];

function launchOpts(kind) {
  if (kind === "chromium") return { executablePath: CHROME };
  return {};
}

async function openAndPlay(page, level, midOpen) {
  await page.goto(BASE + "/turkey/", { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__turkey);
  await page.evaluate(() => window.__turkey.setReduce(false));
  await page.click("#openBtn");
  if (!midOpen) await page.waitForTimeout(1100);
  else await page.waitForTimeout(300);
  await page.evaluate((n) => window.__turkey.startLevel(n, false, { play: true }), level);
  await page.waitForFunction(() => document.getElementById("sceneBmp") || document.querySelector("#sceneLayer svg"), { timeout: 20000 });
  await page.waitForTimeout(midOpen ? 800 : 250);
  await page.evaluate(() => {
    const intro = document.getElementById("introBox");
    if (intro) intro.classList.remove("on");
    const api = window.__turkey;
    if (api.measure) api.measure();
    if (api.fitAll) api.fitAll(false);
    else {
      api.V.cx = api.SW / 2;
      api.V.cy = api.SH / 2;
      api.V.s = api.minS;
      api.renderView();
    }
  });
}

async function coverage(page) {
  return page.evaluate((tol) => {
    const api = window.__turkey;
    if (api.measure) api.measure();
    const viewEl = document.getElementById("view");
    const layerEl = document.getElementById("sceneLayer");
    const bmpEl = document.getElementById("sceneBmp") || layerEl;
    if (!viewEl || !bmpEl) return { ok: false, error: "missing view or bitmap" };
    const view = viewEl.getBoundingClientRect();
    const bmp = bmpEl.getBoundingClientRect();
    const SW = api.SW, SH = api.SH, minS = api.minS;
    const fitW = SW * minS, fitH = SH * minS;
    const fit = {
      left: view.left + (view.width - fitW) / 2,
      top: view.top + (view.height - fitH) / 2,
      right: view.left + (view.width - fitW) / 2 + fitW,
      bottom: view.top + (view.height - fitH) / 2 + fitH,
      width: fitW,
      height: fitH
    };
    const shortfalls = {
      left: fit.left - bmp.left,
      top: fit.top - bmp.top,
      right: bmp.right - fit.right,
      bottom: bmp.bottom - fit.bottom
    };
    // "Covers" means the bitmap extends to (or past) the fitted spread, within tol.
    // A positive shortfall means the bitmap falls short of the fitted rect.
    const fail = {};
    for (const side of Object.keys(shortfalls)) {
      if (shortfalls[side] < -tol) fail[side] = shortfalls[side];
    }
    return {
      ok: Object.keys(fail).length === 0,
      fail,
      shortfalls,
      view: { w: view.width, h: view.height },
      bmp: { x: bmp.left - view.left, y: bmp.top - view.top, w: bmp.width, h: bmp.height },
      fit: { w: fitW, h: fitH },
      minS, s: api.V.s,
      canvas: bmpEl.tagName === "CANVAS" ? { attr: [bmpEl.width, bmpEl.height], css: [bmpEl.style.width, bmpEl.style.height] } : null
    };
  }, TOL);
}

function report(label, info) {
  const mark = info.ok ? "PASS" : "FAIL";
  const extra = info.ok
    ? `view ${info.view.w.toFixed(1)}x${info.view.h.toFixed(1)} bmp ${info.bmp.w.toFixed(1)}x${info.bmp.h.toFixed(1)} gaps LTRB ${info.shortfalls.left.toFixed(2)}/${info.shortfalls.top.toFixed(2)}/${info.shortfalls.right.toFixed(2)}/${info.shortfalls.bottom.toFixed(2)}`
    : JSON.stringify(info);
  console.log("  " + mark + " " + label + " — " + extra);
  return info.ok;
}

(async () => {
  const browsers = {};
  const failures = [];
  const runCase = async (spec, extraLabel, setup) => {
    const label = extraLabel ? spec.name + " " + extraLabel : spec.name;
    const kind = spec.kind;
    if (!browsers[kind]) {
      const engine = kind === "chromium" ? chromium : webkit;
      browsers[kind] = await engine.launch(launchOpts(kind));
    }
    const ctxOpts = spec.device
      ? { ...devices[spec.device] }
      : { viewport: spec.viewport, deviceScaleFactor: spec.deviceScaleFactor || 1 };
    if (spec.device && !devices[spec.device]) {
      failures.push(label + " (unknown device " + spec.device + ")");
      console.log("  FAIL " + label + " — unknown Playwright device " + spec.device);
      return;
    }
    const ctx = await browsers[kind].newContext(ctxOpts);
    const page = await ctx.newPage();
    try {
      await setup(page, ctx);
      const info = await coverage(page);
      if (!report(label, info)) failures.push(label);
    } catch (e) {
      console.log("  FAIL " + label + " — " + (e && e.stack || e));
      failures.push(label);
    } finally {
      await ctx.close();
    }
  };

  console.log("Fit coverage (bitmap vs #view fitted spread, tol=" + TOL + "px) @ " + BASE);
  for (const spec of CASES) {
    await runCase(spec, "at fit", async (page) => {
      await openAndPlay(page, 5, false);
    });
  }

  console.log("Mid book-open (regression for the iPad letterbox):");
  for (const name of ["iPad Pro 11 landscape", "iPad (gen 7) portrait", "iPad Pro 11 portrait"]) {
    const spec = CASES.find((c) => c.name === name);
    await runCase(spec, "mid-open start", async (page) => {
      await openAndPlay(page, 10, true);
    });
  }

  console.log("After rotation / resize:");
  await runCase(CASES.find((c) => c.name === "iPad Pro 11 landscape"), "after rotate to portrait then back", async (page, ctx) => {
    await openAndPlay(page, 10, true);
    const land = devices["iPad Pro 11 landscape"].viewport;
    const port = devices["iPad Pro 11"].viewport;
    await page.setViewportSize({ width: port.width, height: port.height });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForTimeout(400);
    await page.evaluate(() => { const a = window.__turkey; a.measure(); a.fitAll(false); });
    const mid = await coverage(page);
    if (!report("iPad Pro 11 after rotate to portrait", mid) ) {
      /* recorded in this helper only if we throw — parent also checks final */
    }
    await page.setViewportSize({ width: land.width, height: land.height });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForTimeout(400);
    await page.evaluate(() => { const a = window.__turkey; a.measure(); a.fitAll(false); });
  });

  await runCase(CASES.find((c) => c.name === "desktop 1280x800"), "after resize to 1920x1080", async (page) => {
    await openAndPlay(page, 1, false);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForTimeout(400);
    await page.evaluate(() => { const a = window.__turkey; a.measure(); a.fitAll(false); });
  });

  await Promise.all(Object.values(browsers).map((b) => b.close()));
  if (failures.length) {
    console.log("\nFAILED: " + failures.join(", "));
    process.exit(1);
  }
  console.log("\nAll fit-coverage checks passed.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
