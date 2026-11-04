# 全面审查修复记录

基线 main：`aeb9b27bdec61fd095b9ebf073cc2391f17e3d16`。保留 Interactive Agent、Autonomous Investigator 与材料分析路径。

| 问题 | 修复与可复现验证 | 状态 |
| --- | --- | --- |
| R1 超200条导入丢材料 | 仅限制模型输入，返回完整材料；201旧+1新回归验证保留和未分析提示。`tests/api-client-budget.test.ts` | 已修复 |
| R2 人工决定丢反证 | 保留所有轮次claims/plan，重算衍生核查；收集缺口作为待重新确认的历史备注保留。`tests/store-review-regressions.test.ts` | 已修复 |
| R3 Python重定向泄漏key | 禁止重定向，固定获准IP、TLS主机验证、限响应体、网络总截止时间；真实本地重定向服务验证目标未收到key。`security_review_test.py` | 已修复 |
| R4 新材料引用无法定位 | 入库获得可信版本后唯一逐字引用绑定；重复引文不猜位置。绑定只验证来源，不证明事实。`tests/store-review-regressions.test.ts` | 已修复 |
| R5 相同版本元数据不一致 | 来源身份/解析器元数据变更新增版本；原对象内容hash和历史引用兼容。`tests/store-review-regressions.test.ts` | 已修复 |
| R6 错令牌仍显示就绪 | 认证健康探针、占端口拒绝二次启动、短令牌启动检查、回环地址一致；真实Python IPv4/IPv6冷启动验证。`tests/ingestion-readiness.test.ts`及`node --import tsx scripts/ingestion-readiness-smoke.mjs [--ipv6]` | 已修复 |
| R7 取消任务复活 | 事务中检查允许状态、同案活动任务和重复决定；lease epoch失效保护。`tests/store-review-regressions.test.ts` | 已修复 |
| R8 渠道暂存无限增长 | 单份/总量/数量/TTL、跨进程锁和失败清理；只管理自有副本。真实临时文件、并发写和活动读取测试。`security_review_test.py` | 已修复 |
| R9 承诺忽略过滤范围 | 案件/归档/标签范围同步承诺，全文查询不误删承诺。`tests/case-search.test.ts` | 已修复 |

核心和安全改动经交叉审查。追加修复了历史缺口丢失、慢滴答超时、TLS socket超时归属及Windows长时间锁竞争。新增Windows/Linux Python安全CI，以及真实Python冷启动CI。原数据结构版本不变；元数据新版本沿用现有历史表，备份内容hash格式不变。已有迁移、历史引用与备份恢复测试随全套单测运行。

本地验证：174项Vitest；lint无错误（既有img性能警告1项）；typecheck与生产build；Python安全13项及审查安全11项；材料解析14套；生产代码离线评估73/73；浏览器三协议、对话持久化/隔离、调查员、渠道导入流程。所有数据均为隔离合成fixture，未使用真实账户、原始材料或真实模型，不能据此宣称模型事实判断质量。

边界：保持本机单用户候选版本。系统DNS超时后后台解析仍等待OS完成，但并发限制8个；JSON解码是受8MiB体积限制的同步CPU工作，不能宣称硬CPU沙箱。旧服务升级需停止重启。Team/Public ACL、真实模型质量评估及真实渠道验收仍需独立完成。
