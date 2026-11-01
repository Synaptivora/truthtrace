# 整合版运行与验收

本分支整合前端 v7 接口补丁与 PR #2 的数据接入服务。PR #1 的独立静态原型作为视觉参考，不作为应用入口。

## 本地启动

1. npm install
2. python -m pip install -r services/ingestion/requirements.txt
3. python services/ingestion/server.py --port 8000
4. 复制 .env.example 为 .env.local，设置 INGESTION_SERVICE_URL=http://127.0.0.1:8000，AI_PROVIDER=mock。
5. npm run dev，访问 http://localhost:3000。

## 已验证

- lint、typecheck、生产 build 通过；应用测试 11 项通过。
- python -X utf8 services/ingestion/tests/run_all.py：14 套通过。
- HTTP 实际调用：TXT、PDF、PNG → /api/evidence/parse → /api/analyze，均成功返回 mock 分析。
- 空文件拒收、返回首页保留本次分析、离开整理时取消请求、解析服务错误提示透传。

## 边界

- 前端上传上限仍为单份 8 MB、最多 8 份，与现有 B 服务限制一致。不是 A 服务全部能力的展示入口。
- 示例使用虚构预设结果；上传使用实际解析，默认 mock 不做真实识别。真实模型需填写 AI 配置。
- 渠道适配器已经入库，但网页尚无渠道连接入口。飞书、微信等真实账号不在本次验收范围内。
- 案件内容仅在当前页面内存中，刷新需重新上传；不提供用户登录、持久化案件库。
- 尚未完成浏览器视觉和交互自动化验收。
