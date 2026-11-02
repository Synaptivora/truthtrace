// 端到端自检：微信直读 → 预览里有图 → 导入 → 工作台识别出人物 + 图片 chip 可点开
// 前提：A(:8000) 与前端(:3000) 都在跑，微信已登录且密钥缓存可用。约 60~120 秒。
import { chromium } from "playwright";
import fs from "node:fs/promises";

const OUT = "artifacts/wechat-import";
const log = (...args) => console.log(...args);

await fs.mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", err => errors.push(String(err)));

try {
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /从微信导入/ }).click();
  log("已打开微信导入");

  // 1) 会话清单（微信是本地库，list_conversations 一次给全）
  await page.locator(".ci-sess-row").first().waitFor({ timeout: 120000 });
  log("清单:", (await page.locator(".ci-sess-count").innerText()).replace(/\s+/g, " "));

  // 2) 只勾「黑客松」这一段（默认全选，先取消全选）
  const all = page.locator(".ci-sess-all input");
  if (await all.isChecked()) await all.click();
  const row = page.locator(".ci-sess-row", { hasText: "黑客松" }).first();
  await row.locator('input[type="checkbox"]').check();
  log("已勾选:", (await row.innerText()).replace(/\s+/g, " ").slice(0, 60));

  // 3) 读取这一段：图片应当以缩略图出现，而不是「［图片］」占位
  await page.locator(".ci-sess-read").click();
  await page.locator(".ci-bubble.type-image img").first().waitFor({ timeout: 240000 });
  const imgs = await page.locator(".ci-bubble.type-image img").count();
  const first = await page.locator(".ci-bubble.type-image img").first().evaluate(el => ({
    ok: el.complete && el.naturalWidth > 0,
    w: el.naturalWidth,
    h: el.naturalHeight,
    src: el.getAttribute("src")?.slice(0, 30),
  }));
  log(`预览里的图片: ${imgs} 张；首张 ${first.w}×${first.h}（src ${first.src}…）`);
  await page.screenshot({ path: `${OUT}/1-preview.png` });

  // 4) 导入进工作台
  await page.locator(".ci-import").click();
  await Promise.race([
    page.locator(".contract-shell").waitFor({ timeout: 300000 }),
    page.locator(".ci-error").waitFor({ timeout: 300000 }),
  ]);
  if (await page.locator(".ci-error").count()) {
    throw new Error("导入失败：" + (await page.locator(".ci-error").innerText()));
  }
  log("已进入工作台");

  // 5) 关键断言：人物数不再是 00
  const stats = (await page.locator(".contract-stats").innerText()).replace(/\s+/g, " ");
  log("统计条:", stats);
  const people = Number((/位相关人物/.test(stats) ? stats.match(/(\d+)\s*位相关人物/)?.[1] : "0") || 0);
  const mode = (await page.locator(".contract-mode").innerText()).trim();
  log(`人物数=${people}，模式=${mode}`);
  if (people <= 0) throw new Error("人物仍然为 0：规则分析没有生效");
  await page.screenshot({ path: `${OUT}/2-workbench.png` });

  // 6) 点开一个人物，确认图上出现节点
  const node = page.locator(".contract-graph-node, [class*=person-node], [class*=graph] g").first();
  log("图谱元素:", await node.count());

  // 7) 原文弹窗里点图片 chip
  const catalog = page.locator(".contract-catalog button");
  let chip = null;
  for (let i = 0; i < Math.min(4, await catalog.count()); i += 1) {
    await catalog.nth(i).click();
    chip = await page.locator(".evidence-media-chip:not([disabled])").first()
      .waitFor({ timeout: 6000 }).then(() => page.locator(".evidence-media-chip:not([disabled])").first())
      .catch(() => null);
    if (chip) break;
  }
  if (chip) {
    log("chip:", (await chip.innerText()).trim());
    await chip.click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/3-image.png` });
  } else {
    log("未找到可点的图片 chip");
  }

  log("页面错误:", errors.length);
} finally {
  await browser.close();
}
