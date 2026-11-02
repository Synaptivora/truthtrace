// 端到端自检：钉钉直读 → 预览里有图 → 导入 → 工作台原文里的图片 chip 能点开
// 前提：A(:8000) 与前端(:3000) 都在跑，且 dws 已登录。约 60~90 秒。
import { chromium } from "playwright";
import fs from "node:fs/promises";

const OUT = "artifacts/dingtalk-media";
const log = (...args) => console.log(...args);

await fs.mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", err => errors.push(String(err)));

try {
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /从钉钉导入/ }).click();
  log("已打开钉钉导入");

  // 1) 等第一步清单扫出来
  await page.locator(".ci-sess-row").first().waitFor({ timeout: 180000 });
  log("清单:", (await page.locator(".ci-sess-count").innerText()).replace(/\s+/g, " "));

  // 2) 只留「黑客松」这一群（默认全选，先取消全选）
  const all = page.locator(".ci-sess-all input");
  if (await all.isChecked()) await all.click();
  const row = page.locator(".ci-sess-row", { hasText: "黑客松" }).first();
  await row.locator('input[type="checkbox"]').check();
  log("已勾选:", (await row.innerText()).replace(/\s+/g, " ").slice(0, 60));

  // 3) 读取这一段
  await page.locator(".ci-sess-read").click();
  await page.locator(".ci-bubble.type-image img").first().waitFor({ timeout: 180000 });
  const imgs = await page.locator(".ci-bubble.type-image img").count();
  const real = await page.locator(".ci-bubble.type-image img").first().evaluate(el => ({
    ok: el.complete && el.naturalWidth > 0, w: el.naturalWidth, h: el.naturalHeight,
    src: el.getAttribute("src")?.slice(0, 30),
  }));
  log(`预览里的图片: ${imgs} 张；首张 naturalWidth=${real.w} 高=${real.h}（src ${real.src}…）`);
  await page.screenshot({ path: `${OUT}/1-preview.png` });

  // 4) 导入进工作台（渠道导入成功后直接 onReady，没有「确认页」）
  await page.locator(".ci-import").click();
  await Promise.race([
    page.locator(".contract-shell").waitFor({ timeout: 300000 }),
    page.locator(".ci-error").waitFor({ timeout: 300000 }),
  ]);
  const failed = await page.locator(".ci-error").count();
  if (failed) throw new Error("导入失败：" + (await page.locator(".ci-error").innerText()));
  log("已进入工作台");

  // 5) 打开聊天原文，点图片 chip（chips 只在 chat 证据里，前几条里找一条）
  const catalog = page.locator(".contract-catalog button");
  let chip = null;
  for (let i = 0; i < Math.min(4, await catalog.count()); i += 1) {
    await catalog.nth(i).click();
    chip = await page.locator(".evidence-media-chip:not([disabled])").first()
      .waitFor({ timeout: 6000 }).then(() => page.locator(".evidence-media-chip:not([disabled])").first())
      .catch(() => null);
    if (chip) break;
    await page.locator('.contract-source-dialog button[aria-label="关闭原文"]').click();
  }
  if (!chip) throw new Error("4 条证据里都没找到可点的图片 chip");
  log("chip 文案:", (await chip.innerText()).trim());
  await chip.click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/2-workbench-image.png` });

  const dialogImg = page.locator(".contract-source-dialog img");
  const dlg = await dialogImg.count() ? await dialogImg.first().evaluate(el => ({
    ok: el.complete && el.naturalWidth > 0, w: el.naturalWidth,
  })) : { ok: false, w: 0 };
  log(`弹窗里的图: ${dlg.ok ? "已渲染" : "没渲染"}（宽 ${dlg.w}）`);
  log("页面错误:", errors.length ? errors.slice(0, 3) : "无");
} finally {
  await browser.close();
}
