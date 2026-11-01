# A 智能取数编排器（方案 A）

让 AI agent 持有微信 / 钉钉取数工具，进入 **agentic loop**：读调查目标 → 调工具精准检索 →
把命中的「小窗口」直接作为 evidence → 发现线索再追问上下文 → 循环。产出满足 `EvidenceSchema` 的
`Evidence[]`，走原有 `/parse_chat → analyze` 链路，**B / C 零改动**。

设计文档见项目根 [`A智能取数编排方案（方案A）.md`](../../A智能取数编排方案（方案A）.md)。

## 目录

```
ai_ingest/
  config.py       # env 配置 + 零依赖 OpenAI 兼容 LLM 客户端（无 key 自动降级）
  evidence.py     # 复用 server.py 内联标记约定，产出合规 Evidence + 轻量校验
  backends.py     # MockBackend / DingTalkBackend / WeChatBackend（统一 search/get_window/list_transfers）
  tools.py        # 5 个统一工具的注册与分发（JSON Schema 给 LLM）
  agent.py        # OpenAIAgent（function-calling）+ MockAgent（确定性 planner）
  orchestrator.py # CLI 入口
  output/         # 运行产物 evidence_bundle.json
```

## 运行

在项目根目录执行（模块方式，保证相对导入正常）：

```bash
# 1) 无凭证演示：mock 数据集，产出聚焦 evidence_bundle.json
python -m ai_ingest.orchestrator   # 在 services/ingestion/ 下执行 --source mock

# 2) 自定义目标
python -m ai_ingest.orchestrator   # 在 services/ingestion/ 下执行 \
    --goal "查王五和张三之间关于合作款、转账的沟通，找出承诺与履约差异" \
    --source mock --out services/ingestion/ai_ingest/output

# 3) 真实钉钉：先 dws 导出 messages.json，再让 AI 精准切片
python -m ai_ingest.orchestrator   # 在 services/ingestion/ 下执行 --source dingtalk --source-data exports/群.json

# 4) 真实微信：wechat-ai-memory 的 Version 1 JSON
python -m ai_ingest.orchestrator   # 在 services/ingestion/ 下执行 --source wechat --source-data export.json

# 5) 接解析服务做服务端契约校验（可选）
python -m ai_ingest.orchestrator   # 在 services/ingestion/ 下执行 --source mock --post http://localhost:8000/parse_chat
```

## LLM 配置（可选）

无 `SYNAPSE_LLM_API_KEY` 时自动用 `MockAgent`（确定性、可复现、可演示）。有 key 时启用 `OpenAIAgent`：

```bash
export SYNAPSE_LLM_BASE_URL="https://api.openai.com/v1"   # 任意 OpenAI 兼容端点
export SYNAPSE_LLM_API_KEY="sk-..."
export SYNAPSE_LLM_MODEL="gpt-4o-mini"
```

## 与旧链路的差异

| | 旧链路 | 方案 A |
|---|---|---|
| 取数 | 整段导出 → 整段归一化 | AI 按需检索、精准切片 |
| 证据形态 | 1 个巨型 chat evidence | N 个聚焦窗口（chat + 媒体独立） |
| 中段丢失 | 必然（3 万字符预算砍中段） | 天然规避（每条都在高召回区） |
| AI 角色 | 只做最后一棒文本分析 | 持有工具、驱动取数、循环追问 |
| B / C | — | 零改动 |
