// 钉钉侧：进入不再自动扫 → 手动扫一次 → 勾 3 段读 → 左列表可切换
import { chromium } from "playwright";
import fs from "node:fs/promises";

const OUT = "artifacts/session-switch";
await fs.mkdir(OUT, { recursive: true });
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /从钉钉导入/ }).click();
  await page.waitForTimeout(2500);
  const autoRows = await page.locator(".ci-sess-row").count();
  log("进入钉钉导入，自动扫出的会话行:", autoRows, "（应为 0）");
  await page.screenshot({ path: `${OUT}/dt-1-enter.png` });

  const t0 = Date.now();
  await page.getByRole("button", { name: "扫描会话" }).click();
  await page.locator(".ci-sess-row").first().waitFor({ timeout: 240000 });
  log(`扫描耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，会话 ${await page.locator(".ci-sess-row").count()} 段`);
  await page.screenshot({ path: `${OUT}/dt-1b-list.png` });

  await page.locator(".ci-sess-all input").click();
  const rows = page.locator(".ci-sess-row");
  for (const i of [0, 1, 2]) await rows.nth(i).locator('input[type="checkbox"]').check();
  const t1 = Date.now();
  await page.locator(".ci-sess-read").click();
  await page.locator(".ci-body").waitFor({ timeout: 240000 });
  await page.waitForTimeout(2500);
  log(`读取耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s（清单已缓存，只写快照）`);
  log("读取后左列表行数:", await page.locator(".ci-conv").count());
  await page.screenshot({ path: `${OUT}/dt-2-chat.png` });

  const head1 = await page.locator(".ci-chat-head strong").innerText();
  await page.locator(".ci-conv").nth(1).click();
  await page.waitForTimeout(2500);
  const head2 = await page.locator(".ci-chat-head strong").innerText();
  log(`切换: "${head1}" → "${head2}"`, head1 !== head2 ? "成功" : "失败");
  await page.screenshot({ path: `${OUT}/dt-3-switched.png` });
} catch (e) {
  log("失败:", String(e).slice(0, 300));
} finally {
  await browser.close();
}
