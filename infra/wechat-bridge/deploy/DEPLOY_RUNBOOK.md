# wechat-bridge 部署收尾清单(等用户回话后执行)

## 状态快照(2026-08-30 22:58)
- ✅ RDP 常驻 PID 2924325 已运行 1h+, 147MB
- ✅ wechat-bridge 服务运行中, 监听 0.0.0.0:18888
- ✅ /health 200 (9ms), POST /send 200 (协议兼容)
- ✅ wxauto4 已加载, 等待微信客户端
- ⚠️ 等待用户在 VM 上手动装微信 4.0.5 + 扫码登录

## 三件套脚本(本目录)
- `list_groups.ps1` - 微信登录后运行, 列出所有群名到 `C:\wxbridge\wx_groups.txt`
- `switch_webhook.js` - 改 `area_responsibility.webhook` 从企微切到 wechat-bridge
- `rollback_webhook.js` - 一键回切(从 `area_responsibility_20260830_backup` 备份表还原)
- `group_mapping.template.json` - 批量切换的群名映射模板

## 用户回来后的执行步骤

### 第 1 步: 用户在 Windows VM 手动操作(无法自动化)
1. 装微信 PC 4.0.5, **关自动更新**(4.1.12+ 让所有 wxauto 失效)
2. 扫码登录(建议小号, 避免主号被封)
3. 把 18 个目标群(对应 18 条 area_responsibility)都加进来
4. 确认所有目标群出现在微信"最近会话"

### 第 2 步: 在 VM 跑 list_groups.ps1 拿到群名清单
通过 RDP 自动化 (或 VM 控制台手动):
```powershell
powershell -ExecutionPolicy Bypass -File C:\wxbridge\deploy\list_groups.ps1
```
输出会同时回传到 `\\tsclient\WX\wx_groups.txt`

### 第 3 步: 我根据群名清单填 group_mapping.json
对照 area_responsibility(18 条镇/街道) 与 wx_groups.txt, 把群名填到 mapping 数组

### 第 4 步: 预览切换
```bash
ssh root@111.10.220.226 "cd /opt/jsc/backend && node /opt/jsc/backend/deploy/switch_webhook.js --preview --batch /path/to/group_mapping.json"
```

### 第 5 步: 真正切换
```bash
ssh root@111.10.220.226 "cd /opt/jsc/backend && node /opt/jsc/backend/deploy/switch_webhook.js --batch /path/to/group_mapping.json"
```

### 第 6 步: 端到端验证
- 模拟一条新告警(让 v6 模型检出真烟)
- 看 wechat-bridge 的 server_err.log 是否出现"已发送到群 XXX"
- 看 area_responsibility_20260830_backup 表的 webhook 字段仍保留原值(回滚用)

## 回滚(任何时候)
```bash
ssh root@111.10.220.226 "cd /opt/jsc/backend && node /opt/jsc/backend/deploy/rollback_webhook.js"
# 预览; 加 --execute 真正执行
```

## 部署文件落地位置

| 角色 | 路径 |
|---|---|
| 服务代码 (Windows VM) | `C:\wxbridge\wechat_bot_server.py` |
| 服务依赖 | `C:\Python311\` (完整 Python 3.11.9) |
| 微信列表脚本 | `C:\wxbridge\deploy\list_groups.ps1` |
| 服务日志 | `C:\wxbridge\server_err.log` / `server_out.log` |
| 后端切换脚本 | `/opt/jsc/backend/deploy/switch_webhook.js` |
| 后端回滚脚本 | `/opt/jsc/backend/deploy/rollback_webhook.js` |
| 备份表 (auto) | `area_responsibility_20260830_backup` |

## 已知遗留
- 防火墙已 Set-NetFirewallProfile -All -Enabled False(开发 VM 接受)
  - 若用户希望加固: 改回 Enable, 只留 wechat-bridge-18888-in / wechat-bridge-py-in / wechat-bridge-py-out 三条规则
- 微信 4.1.12+ 自动升级会破 wxauto4 → 必须用户在微信设置里关掉"自动更新"
- v6 模型仅在 straw-engine 灰度环境运行(50% 流量), 真告警量级待观察
