"""A 智能取数编排器（方案 A）。

让 AI agent 持有微信/钉钉取数工具，进入 agentic loop：
读调查目标 -> 调工具精准检索 -> 把命中的「小窗口」作为 evidence -> 发现线索再追问上下文 -> 循环。
产出满足 EvidenceSchema 的 Evidence[]，走原有 /parse_chat -> analyze 链路，B/C 零改动。
"""

__all__ = ["config", "evidence", "backends", "tools", "agent", "orchestrator"]
