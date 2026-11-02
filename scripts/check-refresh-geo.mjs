// 只截「会话行」放大看刷新按钮的几何：按钮框、svg 框、是否溢出
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
try {
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /从微信导入/ }).click();
  await page.getByRole("button", { name: "扫描会话" }).click();
  await page.locator(".ci-sess-row").first().waitFor({ timeout: 180000 });
  await page.locator(".ci-sess-all input").click();
  const rows = page.locator(".ci-sess-row");
  await rows.nth(0).locator('input[type="checkbox"]').check();
  await page.locator(".ci-sess-read").click();
  await page.locator(".ci-conv").first().waitFor({ timeout: 240000 });
  await page.waitForTimeout(1200);

  const geo = await page.locator(".ci-conv").first().evaluate(el => {
    const pick = sel => { const n = el.querySelector(sel); if (!n) return null; const b = n.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
    const btn = el.querySelector(".ci-conv-refresh");
    const svg = btn?.querySelector("svg");
    const cs = btn ? getComputedStyle(btn) : null;
    return {
      row: pick(":scope") || (() => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; })(),
      check: pick('input[type="checkbox"]'),
      main: pick(".ci-conv-main"),
      btn: pick(".ci-conv-refresh"),
      svg: svg ? { w: svg.getBoundingClientRect().width, h: svg.getBoundingClientRect().height } : null,
      btnStyle: cs ? { display: cs.display, placeItems: cs.placeItems, padding: cs.padding, boxSizing: cs.boxSizing, alignSelf: cs.alignSelf, marginTop: cs.marginTop } : null,
    };
  });
  console.log(JSON.stringify(geo, null, 2));

  const row = page.locator(".ci-conv").first();
  await row.screenshot({ path: "artifacts/session-switch/row-zoom.png" });
} catch (e) {
  console.log("失败:", String(e).slice(0, 300));
} finally {
  await browser.close();
}
