# Surge 工单只读监控

此公开仓库只发布 Surge 工单监控所需的模块、JavaScript 和说明。

## 安装

在 Surge iOS 中选择“安装新模块”，输入：

`https://raw.githubusercontent.com/eielyving/surge-workorder-monitor/main/workorder-monitor.sgmodule`

启用模块后，Surge 会通过 `script-path` 从 GitHub 获取 JS。无需把 JS 粘贴进编辑器，也无需使用 Filza。此方式适用于 Surge 5.20 的远程脚本加载。

如果已安装旧的本地监控模块，请先关闭旧模块，再启用本模块，避免两套 cron 重复运行。

## 行为

- 北京时间每天 08:00–15:54 每 6 分钟查询一次，16:00 做最后一次查询。
- `wake-system=true` 请求 iOS 在定时点唤醒 Surge 执行脚本。
- 只记录工单总数、状态数和业务类别数，不记录地址、电话、联系人或任务内容。
- 2027-12-31 之后，脚本日期保护会阻止访问业务系统；届时仍应关闭/移除此模块，以免 Surge 继续按 cron 唤醒。
- 脚本只读查询，不接取工单、不回复消息。

## 限制

- 脚本查询接口为 `www.lygr.net:9010`。当前 Python 采集器把工单类型固定为 `33`；此脚本将类型留空以尝试查询全部类型，仍需通过日志确认服务端是否将空类型解释为“全部”。
- 当前没有接单接口、登录凭据或接单逻辑，因此本项目尚未实现自动接单。
- 仓库是公开的，源代码会公开展示上述服务地址、公司名和查询逻辑。不要在此仓库加入账号、密码、Cookie 或其他凭据。

## 更新

模块通过 GitHub Raw 获取脚本，`script-update-interval=86400` 设置为 24 小时检查更新。发布新脚本时，应将模块中的脚本地址固定到对应的 Git commit SHA，避免上游脚本在检查间隔内静默变化。
