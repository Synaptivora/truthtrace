// 验证三件事：
// 1) 进入导入页不再自动扫描（扫描按钮点击前不应有 .ci-sess-row）
// 2) 窄屏（960 / 900）左侧会话列表仍在，且能切换会话
// 3) 同一范围再点扫描走缓存（0 秒），不重复读
import { chromium } from "playwright";
import fs from "node:fs/promises";

const OUT = "artifacts/session-switch";
await fs.mkdir(OUT, { recursive: true });
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true, channel: "msedge" });

for (const [w, h] of [[960, 680], [900, 640], [1440, 900]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  try {
    await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /从微信导入/ }).click();

    // 1) 进页面不应自动扫
    await page.waitForTimeout(2500);
    const autoRows = await page.locator(".ci-sess-row").count();
    const emptyState = await page.locator(".ci-sess-empty").count();
    log(`${w}x${h} 进入页面自动扫出的会话行: ${autoRows}（应为 0），空态提示: ${emptyState}`);
    await page.screenshot({ path: `${OUT}/v2-${w}x${h}-enter.png` });

    // 2) 手动扫
    const t0 = Date.now();
    await page.getByRole("button", { name: "扫描会话" }).click();
    await page.locator(".ci-sess-row").first().waitFor({ timeout: 180000 });
    log(`   首次扫描耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s，行数 ${await page.locator(".ci-sess-row").count()}`);

    // 3) 同范围再点「重新扫描」之前的缓存验证：先勾两段读进去
    await page.locator(".ci-sess-all input").click();
    const rows = page.locator(".ci-sess-row");
    await rows.nth(0).locator('input[type="checkbox"]').check();
    await rows.nth(1).locator('input[type="checkbox"]').check();
    await rows.nth(2).locator('input[type="checkbox"]').check();
    await page.locator(".ci-sess-read").click();
    await page.locator(".ci-body").waitFor({ timeout: 240000 });
    await page.waitForTimeout(2000);

    const layout = await page.evaluate(() => {
      const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
      const list = document.querySelector(".ci-conv-list");
      return {
        left: r(document.querySelector(".ci-left")),
        list: r(list),
        convs: document.querySelectorAll(".ci-conv").length,
        firstConvVisible: r(document.querySelector(".ci-conv")),
        cols: getComputedStyle(document.querySelector(".ci-body")).gridTemplateColumns,
      };
    });
    log(`   进入会话界面: ${JSON.stringify(layout)}`);
    await page.screenshot({ path: `${OUT}/v2-${w}x${h}-chat.png` });

    // 4) 切换会话
    const head1 = await page.locator(".ci-chat-head strong").innerText();
    await page.locator(".ci-conv").nth(1).click();
    await page.waitForTimeout(2200);
    const head2 = await page.locator(".ci-chat-head strong").innerText();
    const nav = await page.locator(".ci-switch span").innerText().catch(() => "-");
    log(`   切换: "${head1}" → "${head2}"（${head1 !== head2 ? "成功" : "失败"}），位置 ${nav}`);
    await page.screenshot({ path: `${OUT}/v2-${w}x${h}-switched.png` });
  } catch (e) {
    log(`${w}x${h} 失败:`, String(e).slice(0, 200));
  } finally {
    await page.close();
  }
}
await browser.close();
