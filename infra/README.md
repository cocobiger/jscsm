# infra/ — 运维配置权威副本（配置即代码）

本目录是 JSC 生产环境运维配置的**唯一真相源 (source of truth)**，已纳入 git 版本控制。

## 目录结构

| 文件 | 用途 |
| --- | --- |
| `nginx/uav-sites.conf` | Nginx 主站配置 (listen 80)：SPA 入口 `/jsc/` + `/api/` 反代 + 城运 `/client/` + 铁路 `/tielu/` 等 |
| `nginx/skymonitor.conf` | SkyMonitor 配置 (listen 81)：HLS 反代 + `/chengyun-mock/` + `/tielu/` |
| `nginx/uav-sites.alt.conf.example` | 历史变体（非权威，仅供对照，勿用于重建） |
| `rollback.sh` | 系统还原点脚本（`/opt/jsc/rollback.sh` 权威版） |
| `dji-bridge/dji_bridge.py` | DJI 司空桥接（Playwright 抓流 → RTMP → ZLMediaKit） |
| `dji-bridge/requirements.txt` | dji-bridge Python 依赖固化（playwright==1.61.0 等） |
| `iotcloud.env.example` | IoTCloud 密钥模板（**脱敏占位，真实密钥勿入库**） |
| `zlm_config.ini` | ZLMediaKit 配置（**脱敏占位，不同步到服务器以免覆盖真实 secret**） |

## 修改流程（配置即代码）

1. 编辑本目录下的配置文件；
2. `git commit` 入库（变更可追溯、可回滚）；
3. `./deploy/sync-config.sh` 同步到生产服务器：
   - 自动备份线上旧配置（`.bak.sync-<时间戳>`）；
   - `nginx -t` 校验通过后 `nginx -s reload`；
   - 校验失败自动还原备份并中断；
4. 浏览器验证 `http://111.10.220.226:81/jsc/`。

常用：

```bash
./deploy/sync-config.sh -n                 # 干跑，只看变更
./deploy/sync-config.sh -c nginx           # 仅同步 nginx
./deploy/sync-config.sh -c dji --with-deps # 同步 dji 代码并重装依赖
```

## 注意事项

- **不要**把本目录的 `zlm_config.ini` / `iotcloud.env.example` 直接同步到服务器——它们是脱敏占位，服务器上存的是真实密钥。
- 新增 location 必须**同时**写入 `uav-sites.conf` 与 `skymonitor.conf` 两个文件，否则外部访问可能命中无该 location 的配置返回 404。
- `systemctl reload nginx` 在生产环境不生效，脚本统一用 `nginx -s reload`。
- 线上 `nginx` 双配置目录还散落多个手工 `.bak.*` 备份，属历史快照，不在本目录管理范围内。
