// 一次性自检脚本（不参与构建）：验证「导入提示横幅」与「聊天图片 chip」在真实页面上生效。
// 用法：node scripts/check-import-notice.mjs
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const OUT = "artifacts/import-notice";
await fs.mkdir(OUT, { recursive: true });

// 造一个「16 个会话 × (chat + 图片) = 32 条证据」的归一化导出：
// 超过 B 的 30 条上限，正好用来验证 C 侧的截断提示。
const png = path.resolve("services/ingestion/testdata/dingtalk_demo/attachments/转账截图.png");
const conversations = [];
for (let i = 1; i <= 16; i += 1) {
  conversations.push({
    name: `合作群 ${String(i).padStart(2, "0")}`,
    messages: [
      { sender: "王五", time: `2026-07-${String(i + 1).padStart(2, "0")} 09:10:00`, type: "image", text: "", media: png },
      { sender: "张三", time: `2026-07-${String(i + 1).padStart(2, "0")} 09:20:00`, type: "text", text: `第 ${i} 笔合作款已确认，稍后转账。` },
    ],
  });
}
const fixture = path.resolve("_notice_fixture.json");
await fs.writeFile(fixture, JSON.stringify({ source: "钉钉", conversations }, null, 2), "utf8");

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const steps = [];

try {
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "手动创建", exact: true }).click();
  await page.locator("#entryCaseName").fill("导入提示自检");
  await page.locator("#entryFiles").setInputFiles(fixture);
  await page.getByRole("button", { name: /开始整理/ }).click();
  // 解析完会先到「材料已就绪」确认页，再进工作台
  const enter = page.getByRole("button", { name: /进入调查工作台/ });
  await enter.waitFor({ timeout: 120_000 });
  steps.push("就绪页：" + (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 80));
  await enter.click();
  await page.locator(".contract-shell").waitFor({ timeout: 60_000 });
  steps.push("工作台已打开");

  const banner = page.locator(".contract-import-notice");
  await banner.waitFor({ timeout: 15_000 });
  steps.push(`横幅文案：${(await banner.innerText()).replace(/\s+/g, " ").slice(0, 120)}`);
  await page.screenshot({ path: `${OUT}/1-banner.png` });

  // 打开第一条 chat 证据，检查图片 chip
  await page.locator(".contract-catalog button").first().click();
  const dialog = page.locator(".contract-source-dialog");
  await dialog.waitFor();
  const chips = dialog.locator(".evidence-media-chip");
  steps.push(`chip 数量：${await chips.count()}`);
  await page.screenshot({ path: `${OUT}/2-chips.png` });

  const enabled = dialog.locator(".evidence-media-chip:not([disabled])").first();
  if (await enabled.count()) {
    await enabled.click();
    await page.waitForTimeout(600);
    steps.push("点击 chip 后打开了图片：" + (await page.locator(".contract-source-dialog h2").innerText()));
    await page.screenshot({ path: `${OUT}/3-image.png` });
  } else {
    steps.push("⚠️ 没有可点的 chip（同名图片证据被裁掉了？）");
  }

  // 关闭横幅
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await banner.locator("button").click();
  steps.push(`关闭横幅后可见：${await banner.isVisible()}`);
} finally {
  console.log(steps.join("\n"));
  console.log("页面错误：", errors.length ? errors : "无");
  await browser.close();
  await fs.rm(fixture, { force: true });
}
