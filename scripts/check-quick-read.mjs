// 「跳过清单，直接读取全部会话」这条路：只读一次，直接进会话界面
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
try {
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /从微信导入/ }).click();
  await page.waitForTimeout(1500);
  const t0 = Date.now();
  await page.getByRole("button", { name: /跳过清单，直接读取全部会话/ }).click();
  await page.locator(".ci-body").waitFor({ timeout: 300000 });
  await page.waitForTimeout(2500);
  console.log(`一次读取耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("左列表会话数:", await page.locator(".ci-conv").count());
  console.log("首段标题:", await page.locator(".ci-chat-head strong").innerText());
  await page.screenshot({ path: "artifacts/session-switch/quick-read.png" });
} catch (e) {
  console.log("失败:", String(e).slice(0, 300));
} finally {
  await browser.close();
}
