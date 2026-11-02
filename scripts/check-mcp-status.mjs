// 打开数据源 MCP 配置，核对「就绪」是不是真探测：截图 + 打印四个渠道的真实状态
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
try {
  const seen = [];
  page.on("response", async res => {
    const url = res.url();
    if (url.includes("/api/source/status") || url.endsWith("/api/source/list")) {
      const body = await res.json().catch(() => null);
      if (body) seen.push({ url: url.split("/api")[1], body });
    }
  });

  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.locator(".agent-launcher").click();
  await page.locator(".agent-mcp-trigger").click();
  await page.locator(".mcp-guide").waitFor({ timeout: 60000 });
  await page.waitForTimeout(3500);

  for (const item of seen) {
    if (item.url.includes("/list")) {
      console.log("list →", item.body.sources.map(s => `${s.id}:${s.status}`).join(" "));
    } else {
      const b = item.body;
      console.log(`${b.source} → ${b.status} | ${b.detail} | checked ${b.checked_at} | count ${b.count}`);
    }
  }

  const cards = await page.locator(".mcp-channel").allInnerTexts();
  console.log("卡片:", cards.map(t => t.replace(/\s+/g, " ")).join(" || "));
  await page.screenshot({ path: "artifacts/session-switch/mcp-status.png", fullPage: false });

  // 钉钉选中态
  await page.locator(".mcp-channel", { hasText: "钉钉" }).click();
  await page.waitForTimeout(2500);
  console.log("钉钉状态框:", (await page.locator(".mcp-status").innerText()).replace(/\s+/g, " "));
  await page.screenshot({ path: "artifacts/session-switch/mcp-dingtalk.png" });

  // 微信选中态
  await page.locator(".mcp-channel", { hasText: "微信" }).click();
  await page.waitForTimeout(2500);
  console.log("微信状态框:", (await page.locator(".mcp-status").innerText()).replace(/\s+/g, " "));

  // 飞书
  await page.locator(".mcp-channel", { hasText: "飞书" }).click();
  await page.waitForTimeout(2500);
  console.log("飞书状态框:", (await page.locator(".mcp-status").innerText()).replace(/\s+/g, " "));
  await page.screenshot({ path: "artifacts/session-switch/mcp-feishu.png" });
} catch (e) {
  console.log("失败:", String(e).slice(0, 300));
} finally {
  await browser.close();
}
