# 计划适用性复核
远端 main：10202a6fc356abcee8e4d6b485bc58be45298875（GitHub connector）。本地：6de389a。compare显示差异仅12个前端文件；安全与核心审查文件未变。最新关键前端另按远端SHA读取。静态审查未运行漏洞复现或质量评估。

|任务|结论与证据|
|---|---|
|00|适用；先冻结契约，Git同步失败尚不能冻结实施基线|
|01|server.py:1322 CORS默认*；1427全量读取；已有basename防护，不能说完全无路径保护|
|02|http.ts:1已有流式限额；analyze:27、evidence/parse:11、source代理:49仍直接全读；setup:84纳入盘点|
|03|providers:51已有HTTPS限制；transport:63已有redirect:error及AbortSignal，64已有错误映射；补DNS/IP与目的地授权，不重复实现|
|04|runtime:12全量ArtifactSchema，54仅模型侧阶段字段，181兼容submit_artifact；补服务端严格阶段策略|
|05|runtime:17已有版本/读取/引用检查；runner:74只拒未读标签，需统一三路径；不是从零做引用校验|
|06|store:22已有WAL，26版本证据，29报告修订，92租约检查；补fencing/CAS和写放大，不重复建表|
|07|已有测试脚本；尚无独立evals人工gold体系，适用|
|08|runner:27和runtime:156字符串检索；必须新增runner/runtime集成依赖|
|09|远端agent-panel:199明确页内存储，持久化适用；保留195的事实核实提示|
|10|runtime:37禁止提取后新增claims，183单向推进；安全验收后有界扩展|
|11|远端evidence-content:74前缀匹配；workbench:72一秒revoke，78只整文件导航；拆为媒体快修与后置版本定位|
|12|独立跨案搜索仍待建设；实施前补完整路由和现有筛选清单|
|13|远端workbench:109已有承诺展示；新增版本化投影而非重做卡片|
|14|已有case-view:21 Markdown renderer；纳入所有权和兼容入口|
|15|PR16已改关系图及缩略图；保留最新UI再扩展，不能覆盖为旧版|
|16|README历史边界与当前功能混杂；需整理部署/隐私/测试文档|

## 当前验证和阻塞
原工作区干净。已确认17个独立任务工作树/分支创建；命令输出读取发生Windows编码异常，随后用git worktree list核对全部存在。各工作树暂在旧本地SHA，禁止代码实施，网络恢复后fetch固定SHA并逐树更新；TT00文档提交需rebase。未读取或复制.truthtace私人运行数据，未运行模型或服务。
本轮不启动业务修改、不创建虚假的修复PR、不合并main。下一步是同步Git对象、审阅RFC、首批按所有权派发。PR验证必须有真实命令输出，当前没有测试通过声明。
