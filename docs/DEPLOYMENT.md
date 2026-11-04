# 部署说明
当前目标为本机单用户候选版本。Remote模式拒绝启动业务访问；不支持把本机服务反向代理到公网处理敏感材料。

## 安装与启动
Node 22.13+（建议24）和Python3。首次运行npm install、npm run setup（仅明确需要渠道依赖时）、npm run build、npm run start:local；开发npm run dev:local。默认访问http://127.0.0.1:3000。dev/start也固定回环，但只有local启动器自动配置浏览器会话bootstrap和服务间认证。
上传总限额25MiB，普通JSON2MiB；超额明确拒绝，不静默截断。Python与Next共用TRUTHTRACE_INGESTION_TOKEN；浏览器不得获得该令牌。不要关闭认证来修复401，应检查两个进程的令牌配置。
自定义材料服务令牌至少32字符。升级后先停止旧Python解析进程再使用local启动器；`/health`只代表存活，`/health/auth`才验证服务间凭据。旧版本或令牌不匹配的占端口服务会明确报错，不自动启动第二个进程覆盖。IPv4和IPv6回环冷启动均已验证。

## 模型
通过界面保存连接；三协议保留。管理员显式配置TRUTHTRACE_MODEL_PRIVATE_ORIGINS才能访问本机或局域模型，例如http://127.0.0.1:11434；列表以逗号分隔、精确origin。未授权私网/DNS解析地址拒绝，重定向不携带密钥。
没有模型时明确演示/规则模式；模型异常保留材料，修复连接后重新分析。
Python渠道模型调用同样禁止重定向、固定获准DNS地址并执行总网络截止时间；私网和HTTP模型必须显式允许完整origin。上传渠道副本默认最多25MiB/份、250MiB总量、256份，24小时过期；上传时清理自有过期副本，不删除真实渠道原件。目录及降低配额的配置见 `services/ingestion/tests/security_review_record.md`。

## 数据和恢复
TRUTHTRACE_DATA_DIR指定隔离的数据目录，默认.truthtrace。数据库、objects、originals、连接文件和本机会话secret应受操作系统账户权限保护。不要把运行数据复制进Git或评估fixtures。
运行中不能只复制cases.sqlite：必须使用一致性备份，连同被引用的原件与对象校验。恢复到新目录，确认版本和hash后再停止旧进程并切换配置。跨机器Windows DPAPI密钥可能无法解密，需要重新配置模型连接。具体备份工具与迁移版本以TT06实现说明为准。

## 发布门槛
Local候选必须通过单测、类型、lint、生产build、四条浏览器回归、Python安全与离线渠道回归、迁移恢复测试。Team/Public还需多用户身份/案件ACL、独立存储审计及安全评审，当前不具备这些发布资格。有状态source操作尚无CPU硬隔离，不宣称恶意文件沙箱已完成。

## 备份命令
先停止应用、worker及Python材料服务。现有V2库备份：
```
node --import tsx scripts/data-backup.mjs backup SOURCE_DIR NEW_BACKUP_DIR --offline-confirmed
node --import tsx scripts/data-backup.mjs restore BACKUP_DIR NEW_DATA_DIR --offline-confirmed
```
目标必须不存在；恢复验证清单、DB与对象hash，不能覆盖当前运行目录。升级旧版前应停服后完整复制原数据目录（包括WAL/SHM和原件）作为冷备，再首次启动新版本；不要用会自动打开迁移库的V2工具替代升级前冷备。
