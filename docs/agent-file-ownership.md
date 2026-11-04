# 文件所有权与任务看板

远端基线 10202a6fc356abcee8e4d6b485bc58be45298875。Git fetch已成功，所有工作树已同步目标基线。原工作区保持不变。

只读审查完成，01/03/07已分派实现，其他角色按依赖排队，最多三名子Agent活跃；不是17名同时施工。

|任务|负责人角色|独占路径|依赖|状态|
|---|---|---|---|---|
|TT-00|总控架构 Agent|docs/architecture-contract-v2.md; docs/agent-file-ownership.md; 三套contracts|无|待审查|
|TT-01|Python安全 Agent|services/ingestion/server.py; services/ingestion/tests/security_*|00|进行中|
|TT-02|API安全 Agent|src/app/api/**; src/lib/agent/http.ts|00;01契约|待开始|
|TT-03|连接安全 Agent|src/lib/agent/providers.ts; transport.ts; src/lib/investigator/connections.ts|00|进行中|
|TT-04|阶段授权 Agent|src/lib/investigator/runtime.ts; tests/agent-stage-*|00;03契约|待开始|
|TT-05|引用验证 Agent|src/lib/agent/runner.ts; src/lib/ai/validate.ts; shared-model.ts|04|待开始|
|TT-06|存储恢复 Agent|src/lib/investigator/store.ts; scripts/investigator-worker.ts; migrations|04|待开始|
|TT-07|评估 Agent|evals/**; scripts/eval-*; .github/workflows/agent-evals.yml|00|进行中|
|TT-08|检索 Agent|src/lib/evidence-index/**; src/lib/search/**|05;06|待开始|
|TT-09|会话 Agent|src/lib/conversation/**; src/components/truthtrace/agent-panel.tsx|05;06|待开始|
|TT-10|动态规划 Agent|src/lib/investigator/runtime.ts; plan/**|04;05;06;07;08|待开始|
|TT-11|媒体引用UI Agent|src/components/truthtrace/evidence-content.tsx; contract-workbench.tsx|00 locator;历史定位等05/06|待开始|
|TT-12|案件搜索 Agent|src/components/truthtrace/case-search/**; API释放后新搜索路由|02;06;08|待开始|
|TT-13|承诺 Agent|src/lib/commitments/**; src/components/truthtrace/commitments/**|05;06|待开始|
|TT-14|导出 Agent|src/lib/report-render/**; report-preview/**; src/components/truthtrace/case-view.ts; src/components/truthtrace/case-view.test.ts|05;06;11释放导出接线|待开始|
|TT-15|可视化 Agent|src/components/relationship-graph.tsx; timeline.tsx|05;12|待开始|
|TT-16|部署文档 Agent|README.md; docs/DEPLOYMENT.md; PRIVACY.md; TESTING.md|已实施任务验收|待开始|

## 依赖与调度
```mermaid
graph TD
TT00 --> TT01
TT00 --> TT03
TT00 --> TT07
TT00 --> TT11
TT01 --> TT02
TT03 --> TT04
TT04 --> TT05
TT04 --> TT06
TT05 --> TT08
TT06 --> TT08
TT05 --> TT09
TT06 --> TT09
TT08 --> TT10
TT07 --> TT10
TT02 --> TT12
TT08 --> TT12
TT06 --> TT13
TT05 --> TT13
TT05 --> TT14
TT06 --> TT14
TT12 --> TT15
TT15 --> TT16
TT14 --> TT16
```
边表示契约或验收门槛，并非所有节点都必须等待完整实现。首批建议01/03/07开始；03契约冻结后04，01契约冻结后02；11仅稳定ID与歧义提示可并行，历史版本定位等05/06。实际最多3个实现Agent。
第一批安全与正确性回归完成再启动05/06/08及后续任务。
runtime：04完成并释放后10；runner：05完成后09。08接入runner/runtime必须交给当期所有者或独立串行集成PR。store只有06写；其他模块提接口需求。API由02释放后其他任务才可新增路由。
公共schema由00管理 src/lib/contracts.ts、src/lib/agent/contracts.ts、src/lib/investigator/contracts.ts。contract-workbench由11独占，13/14接线串行。package.json/锁文件/公共测试配置由00协调，不并发编辑。
PR顺序：00文档审查→各安全PR独立审查→整合回归→05/06→08→后续。每PR附复现、测试、兼容、风险与回滚。维护待开始/进行中/待审查/阻塞/已完成状态，不把分派标为完成。