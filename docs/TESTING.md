# 测试与证据
基础命令：npm test、npm run typecheck、npm run lint、npm run build。
浏览器：npm run test:investigator、npm run test:journey、npm run test:reliability、npm run test:browser。脚本创建临时目录和随机测试令牌，只调用本地脚本模型与离线渠道fixture，不能代表真实模型质量。
Python：python -X utf8 services/ingestion/tests/security_boundary_test.py；python -X utf8 services/ingestion/tests/run_all.py。不要将旧真实渠道探测当作离线回归运行。
评估：node scripts/eval-fixtures.mjs；node --import tsx scripts/eval-production.mjs；node scripts/eval-compare.mjs evals/baseline-result.json evals/offline-result.json。生产适配实际调用runAgent/runTask，但模型是演示/脚本注入。人工gold目前为AI编写候选，需独立人工审阅；语义支持/反证召回等指标没有测量时必须为NOT_MEASURED。
真实模型脚本须显式opt-in及配置凭据，不在普通CI执行，不提交凭据或私人材料。

每个PR需记录具体SHA、前置复现、命令与退出结果、正反案例、迁移/回滚、未验证范围。集成候选必须重新检查跨模块接线；单模块通过不等于完整功能通过。不得自动合并main。
