#!/usr/bin/env bash
#
# deploy/sync-config.sh — JSC 配置即代码 (Config-as-Code) 同步
#
# 将本地 infra/ 下的运维配置权威副本同步到生产服务器。
# 约定：infra/ 是配置的唯一真相源 (source of truth)。
#   修改流程：编辑 infra/ 下文件 → git commit → 运行本脚本 → 服务器生效。
#
# 支持组件：
#   nginx    同步 nginx 双配置 (uav-sites + skymonitor)，自动备份+校验+reload
#   dji      同步 dji_bridge.py 到 /opt/jsc/dji-bridge/（--with-deps 可选重装依赖）
#   rollback 同步 rollback.sh 到 /opt/jsc/rollback.sh
#   all      以上全部（默认）
#
# 安全：
#   - 改动前对线上文件做时间戳备份 (.bak.sync-<ts>)
#   - 仅当 nginx -t 通过才 reload；失败则自动还原备份
#   - 文件未变化时跳过（避免无意义 reload）
#   - 不会同步含脱敏占位的 zlm_config.ini / iotcloud.env.example（避免覆盖真实密钥）
#
set -euo pipefail

SERVER="root@111.10.220.226"
NGINX_AVAIL="/etc/nginx/sites-available"
NGINX_ENABLED="/etc/nginx/sites-enabled"
NGINX_CONFD="/etc/nginx/conf.d"
DJI_DIR="/opt/jsc/dji-bridge"
ROLLBACK_PATH="/opt/jsc/rollback.sh"
LOCAL_INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/infra"

DRY_RUN=0
WITH_DEPS=0
COMP="all"

usage() {
  cat <<'EOF'
用法: ./deploy/sync-config.sh [选项]
  -c, --component <nginx|dji|rollback|all>   指定同步组件 (默认 all)
  -n, --dry-run                               只显示将要做的改动，不实际执行写操作
      --with-deps                            dji 组件同时重装 Python 依赖
  -h, --help                                  显示本帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--component) COMP="$2"; shift 2;;
    -n|--dry-run) DRY_RUN=1; shift;;
    --with-deps) WITH_DEPS=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 1;;
  esac
done

# 执行写操作：dry-run 仅打印
run() { if [[ $DRY_RUN -eq 1 ]]; then echo "[dry-run] $*"; else echo "[run] $*"; "$@"; fi; }
run_ssh() { if [[ $DRY_RUN -eq 1 ]]; then echo "[dry-run ssh] $*"; else ssh "$SERVER" "$@"; fi; }

ts() { date +%Y%m%d_%H%M%S; }

# 同步单个文件：本地 -> 远端；仅变动时备份+拷贝+(可选)校验+重载
sync_file() {
  local local_src="$1" remote_dst="$2" validate_cmd="$3" reload_cmd="$4" label="$5"
  if [[ ! -f "$local_src" ]]; then echo "跳过 $label: 本地文件不存在 $local_src"; return 0; fi

  # 只读地获取线上 checksum（dry-run 也执行，用于准确报告是否变更）
  local local_md5 remote_md5
  local_md5=$(md5sum "$local_src" | awk '{print $1}')
  remote_md5=$(ssh "$SERVER" "md5sum '$remote_dst' 2>/dev/null | awk '{print \$1}'" || true)

  if [[ "$local_md5" == "$remote_md5" ]]; then
    echo "无需变动 $label (checksum 一致: $local_md5)"; return 0
  fi
  echo ">> $label 有变更 ($local_md5 -> ${remote_md5:-缺失})，开始同步"

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] 将: 备份 $remote_dst -> cp + scp $local_src -> ${validate_cmd:+(校验) }${reload_cmd:+(重载)}"
    return 0
  fi

  local bak="${remote_dst}.bak.sync-$(ts)"
  run_ssh "cp -f '$remote_dst' '$bak'"
  scp "$local_src" "$SERVER:$remote_dst"
  if [[ -n "$validate_cmd" ]]; then
    if run_ssh "$validate_cmd"; then
      [[ -n "$reload_cmd" ]] && run_ssh "$reload_cmd"
    else
      echo "校验失败！正在还原备份 $bak" >&2
      run_ssh "mv -f '$bak' '$remote_dst'"
      exit 1
    fi
  fi
  echo "<< $label 同步完成 (备份: $bak)"
}

# 确保软链存在（ln -sf 幂等）
ensure_symlink() {
  local target="$1" link="$2" label="$3"
  echo ">> 确保软链 $label -> $target"
  run_ssh "ln -sf '$target' '$link'"
}

VALIDATE_NGINX='nginx -t'
RELOAD_NGINX='nginx -s reload'

if [[ "$COMP" == "all" || "$COMP" == "nginx" ]]; then
  echo "=== [nginx] ==="
  sync_file "$LOCAL_INFRA/nginx/uav-sites.conf" "$NGINX_AVAIL/uav-sites" "$VALIDATE_NGINX" "$RELOAD_NGINX" "uav-sites"
  ensure_symlink "$NGINX_AVAIL/uav-sites" "$NGINX_ENABLED/uav-sites" "sites-enabled/uav-sites"
  sync_file "$LOCAL_INFRA/nginx/skymonitor.conf" "$NGINX_CONFD/skymonitor.conf" "$VALIDATE_NGINX" "$RELOAD_NGINX" "skymonitor.conf"
fi

if [[ "$COMP" == "all" || "$COMP" == "dji" ]]; then
  echo "=== [dji-bridge] ==="
  sync_file "$LOCAL_INFRA/dji-bridge/dji_bridge.py" "$DJI_DIR/dji_bridge.py" "" "" "dji_bridge.py"
  if [[ $WITH_DEPS -eq 1 && $DRY_RUN -eq 0 ]]; then
    echo ">> 重装 dji-bridge Python 依赖"
    run_ssh "$DJI_DIR/venv/bin/pip install -r $LOCAL_INFRA/dji-bridge/requirements.txt"
  fi
fi

if [[ "$COMP" == "all" || "$COMP" == "rollback" ]]; then
  echo "=== [rollback] ==="
  sync_file "$LOCAL_INFRA/rollback.sh" "$ROLLBACK_PATH" "" "" "rollback.sh"
  run_ssh "chmod +x '$ROLLBACK_PATH'" 2>/dev/null || true
fi

echo "=== 同步完成 ==="
