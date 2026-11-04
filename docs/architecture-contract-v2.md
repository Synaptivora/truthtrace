# TruthTrace V2 架构契约 RFC
日期：2026-11-04。远端 main 已由 GitHub connector 确认：10202a6fc356abcee8e4d6b485bc58be45298875。原工作区干净，HEAD=6de389a63776ec108031f603bc49c1387a254d59。已于本轮通过本机代理同步Git对象，17个工作树均已rebase至目标SHA。TT00批准以下接口作为第一批实施契约；不表示功能已实现。

## 执行边界
保留 Interactive runner、Autonomous runtime、材料分析三条路径及三协议、SQLite、Python ingestion。不引入新的 Agent 框架。共享身份/权限、连接、安全错误、引用、预算薄层。

## 安全契约
默认 local：Node/Python 仅回环绑定；精确 Host/Origin allowlist，本机会话令牌保护敏感读写。Origin 不是身份凭据；缺失 Origin 只允许已认证机器调用，null 拒绝。代理头仅信任显式受信代理。remote 在身份与案件 ACL 未实现前启动失败，不降级匿名。
服务端 authorize(principal, action, caseId) 在案件、报告、图片、下载、检索、工具入口调用；资源 ID 必须从授权案件解析。Python 由 Next 使用独立服务凭据调用，浏览器不获得服务密钥。
请求限制提案：JSON 2 MiB、解析上传 25 MiB、归档 100 MiB；前后端一致，部署可降低。读取流累计计数，超额立即取消并 413；不能依赖 Content-Length。解析并发、超时、解压后体积、像素和页数独立预算，TT01提交实测默认值。大材料受控归档并明确未解析。
连接目的地由管理员配置；DNS解析与实际连接目标一致，禁止元数据/非授权私网，重定向默认拒绝。回环/局域模型必须显式授权，密钥绑定连接ID及origin，不跟随任意目的地址。

## 证据契约
EvidenceRefV2: schemaVersion=2, caseId, evidenceId, version, segmentId|null, originalHash|null, parserVersion|null, locator, quote|null, verificationMethod。
locator 为严格判别联合：whole_file；chat_message(messageId)；pdf_page(page>=1)；text_range(start,end)；image_region(page|null,bbox,coordinateSpace)。字符范围按原始规范文本 UTF-16 半开区间，bbox 必须声明像素或归一化坐标及原图尺寸。无位置使用 whole_file，不推断坐标。
sourceSupport = unchecked / supported / unsupported / ambiguous；factualVerification = not_checked / corroborated / contradicted / unresolved。前者文本支持也不等于客观事实真实。程序引用验证另记 identity/version/range/quote 的结果，不能据此设置 corroborated。
coverage 保存 read/total、unread、truncated、dropped、OCR不确定和原因。没有找到不等于不存在。模型输出关键证据字段错误须拒绝并返回安全错误，不能静默 strip。
旧 E1 仅作会话展示绑定；无法恢复稳定ID/版本时标 legacy_unresolved。历史 locator 字符串保留为提示，不伪造坐标；旧任务保留旧执行器或显式适配。

## 工具、错误、预算和状态
StagePolicy 由服务端确定 allowedNames、strict input schema、allowedFields、case scope、imageConsent、maxCalls/maxBytes。submit_artifact 别名同样校验；非法调用不得推进step。
SafeError={code,message,traceId,retryable}；400/401/403/413/429/502/504 分开。日志不含密钥、私人原文、上游原始错误或内部路径。
Budget={maxCalls,maxTokens,maxBytes,deadline,maxReplans,consumed} 持久化；重试/恢复不重置累计预算。外部调用不承诺恰好一次。
任务状态区分 queued/running/waiting_user/paused/insufficient/completed/failed/cancelled。TT06负责与现有枚举适配；写入校验 revision+lease fencing token；幂等键为 task/revision/step/attempt。新证据令依赖结果 stale，旧报告保留。

## 迁移与验证门槛
TT00批准schema后TT05/06实施双读、版本化写入和幂等事务迁移。迁移前一致性备份数据库及WAL/SHM、objects/originals和密钥元信息；不在运行中随意复制数据库，不把私人数据带入worktree。失败回滚旧应用及完整备份，禁止破坏性自动降级。
所有 PR 必须有变更前失败复现、正反测试、迁移/回滚、未验证范围。npm test/typecheck/lint/build及investigator/journey/reliability/browser和Python回归按变更执行，集成候选完整执行。确定性测试、人工gold离线评估、真实模型评估分开报告。
Local验收：回环、会话、限体积、工具授权、来源与恢复、上传告知。Team额外认证/ACL/审计/隔离/备份恢复。Public额外独立安全审查/配额/恶意文件隔离；未通过不得公开接收敏感材料。

## 第一批接线补充
Python服务认证使用 TRUTHTRACE_INGESTION_TOKEN 与 Authorization: Bearer；health仅可信回环Host可匿名。浏览器不获取服务密钥。Python无Content-Length返回411，chunked拒绝400，Next转发必须提供确定长度。TT03保持modelStep调用签名，扩展可选usage和安全错误属性。
