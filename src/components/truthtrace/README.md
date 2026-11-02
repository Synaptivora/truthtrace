# C · TruthTrace 前端接续

本目录移植 C 已验收的 v0.7 界面：空白案件首页、创建与导入、整理过渡、咪探长、纸质卷宗、软木关系图、证据定位及沉浸展示。`InvestigationWorkbench` 的导出和原页面调用方式保持兼容，首次进入不自动展示传入的分析结果。

## 两条路径

- **导入示例材料**：保留 C 原有的 500 元押金推理演示，全部标为虚构预设数据。演示原文由 `case-data.mjs` 生成，不与 B 的 300 元团队测试样例或真实上传混合。
- **自己选择文件**：`api-client.ts` 调用现有 `POST /api/evidence/parse`（字段 `files`）和 `POST /api/analyze`（`{ evidence }`）。返回数据按现有契约校验后，交给 `ContractWorkbench` 展示，保留 `mock/model`、错误反馈及原文引用。人物和疑点来自接口，前端不套用演示结论。前端与内置解析器均不设单文件大小上限。

## 维护位置

- `investigation-workbench.tsx`：React 入口、静态素材绑定、真实结果切换。
- `runtime.mjs` / `template.mjs`：已验收演示的 DOM 控制器与项目内静态模板，由 React effect 挂载；卸载时取消监听、观察器、计时器和本地文件 URL，兼容开发模式重复挂载。
- `onboarding.mjs`：空态、导入、解析进度、失败返回和完成入口。真实上传会发送到当前站点的团队接口；示例路径保持本地。
- `contract-workbench.tsx` / `../relationship-graph.tsx` / `../timeline.tsx`：消费 `AnalysisResult`，显示真实接口结果、证据节点、来源回溯和发现定位。
- `*.css`：暖棕、黄铜、纸张与软木材质。`src/app/globals.css` 只负责导入这些 C 的样式。
- `assets/`：原项目内置生成素材；没有外链图片、远程字体或新增依赖。头像提示词见下方。

头像使用内置 imagegen，以原有猫咪为角色参考：compact square close-up of the orange-and-white detective kitten, brown tweed deerstalker hat, burgundy scarf, one paw resting on a bronze rim and the other holding a brass magnifying glass, curious head tilt, readable at 52px, transparent background, no text or watermark.

## 验证

共享仓库检查：`npm run lint`、`npm run typecheck`、`npm run test`、`npm run build`。

C 的接口接续测试：`npx vitest run --config src/components/truthtrace/vitest.config.ts`。根测试配置仅包含 `tests/`；本 PR 不修改共享 CI 或 B 的测试配置。

运行 `npm run dev`，依次验收空态 → 导入示例 → 整理 → 演示工作台。再新建案件选择自己的 TXT 文件，确认调用团队接口，默认 mock 结果不生成人物或虚构矛盾；解析失败可返回修改，取消整理会中止请求。

此改动仅位于 `src/components/*` 和 `src/app/globals.css`，未修改 API、数据契约、解析器、依赖、环境变量或共享页面入口。
