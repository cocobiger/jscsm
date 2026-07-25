#!/bin/bash
# ============================================================
#  JSC 系统一键回滚脚本
#  用法:
#    rollback.sh list                    列出所有可用备份
#    rollback.sh restore <TIMESTAMP>     回滚到指定快照
#    rollback.sh verify <TIMESTAMP>       验证指定快照完整性
#    rollback.sh create                   立即创建新快照
# ============================================================
set -euo pipefail

BACKUP_ROOT="/opt/jsc/backups"
FRONTEND_DIR="/opt/jsc/frontend"
BACKEND_DIR="/opt/jsc/backend"
NGINX_SITE="/etc/nginx/sites-enabled/uav-sites"
SYSTEMD_SERVICE="/etc/systemd/system/jsc-backend.service"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "${CYAN}[STEP]${NC}  $1"; }

# ── 列出所有可用备份 ──────────────────────────────────
cmd_list() {
    if [ ! -d "$BACKUP_ROOT" ]; then
        log_error "备份目录 $BACKUP_ROOT 不存在，请先执行 create"
        exit 1
    fi

    echo ""
    echo "============================================"
    echo "  JSC 系统可用备份列表"
    echo "============================================"
    echo ""
    printf "  %-20s  %-10s  %s\n" "快照时间" "大小" "文件数"
    printf "  %-20s  %-10s  %s\n" "--------------------" "----------" "------"

    for d in "$BACKUP_ROOT"/*/; do
        if [ -d "$d" ]; then
            ts=$(basename "$d")
            size=$(du -sh "$d" 2>/dev/null | cut -f1)
            count=$(find "$d" -type f 2>/dev/null | wc -l)
            printf "  %-20s  %-10s  %s 个文件\n" "$ts" "$size" "$count"
        fi
    done
    echo ""
    echo "回滚命令: rollback.sh restore <快照时间>"
    echo "例:       rollback.sh restore 20260617-172821"
    echo ""
}

# ── 验证快照完整性 ──────────────────────────────────
verify_backup() {
    local ts="$1"
    local bak="${BACKUP_ROOT}/${ts}"
    local ok=0 fail=0

    if [ ! -d "$bak" ]; then
        log_error "快照 $ts 不存在于 $BACKUP_ROOT"
        return 1
    fi

    log_info "验证快照: $ts"
    check() {
        if [ -f "$bak/$1" ] || [ -d "$bak/$1" ]; then
            ((ok++)) || true
            log_info "  ✓ $1"
        else
            ((fail++)) || true
            log_error "  ✗ $1 (缺失)"
        fi
    }

    check "frontend/index.html"
    check "frontend/assets"
    check "backend/index.js"
    check "backend/transcoder_v2.js"
    check "backend/zlm.js"
    check "backend/store-db.js"
    check "backend/auth.js"
    check "backend/package.json"
    check "data/jsc.db"
    check "data/config.json"
    check "data/transcoder.json"
    check "nginx/uav-sites"
    check "config/jsc-backend.service"

    echo ""
    log_info "完整性: ${GREEN}${ok} 通过${NC} / ${RED}${fail} 缺失${NC}"
    if [ "$fail" -gt 0 ]; then
        log_error "快照不完整，不建议回滚"
        return 1
    fi
    return 0
}

# ── 创建新快照 ────────────────────────────────────
cmd_create() {
    local TS
    TS=$(date +%Y%m%d-%H%M%S)
    local BAK="${BACKUP_ROOT}/${TS}"

    log_step "创建快照: $TS"
    mkdir -p "$BAK"/{frontend,backend,data,nginx,config}

    log_info "复制前端..."
    cp -a "$FRONTEND_DIR/index.html" "$BAK/frontend/"
    cp -a "$FRONTEND_DIR/assets/" "$BAK/frontend/assets/"

    log_info "复制后端..."
    cp -a "$BACKEND_DIR"/*.js "$BAK/backend/"
    cp -a "$BACKEND_DIR/package.json" "$BAK/backend/" 2>/dev/null || true

    log_info "复制数据库..."
    cp -a "$BACKEND_DIR/data/jsc.db" "$BAK/data/"
    cp -a "$BACKEND_DIR/data/jsc.db-wal" "$BAK/data/" 2>/dev/null || true
    cp -a "$BACKEND_DIR/data/jsc.db-shm" "$BAK/data/" 2>/dev/null || true
    cp -a "$BACKEND_DIR/data/config.json" "$BAK/data/"
    cp -a "$BACKEND_DIR/data/transcoder.json" "$BAK/data/"

    log_info "复制配置文件..."
    cp -a "$NGINX_SITE" "$BAK/nginx/"
    cp -a "$SYSTEMD_SERVICE" "$BAK/config/"

    local size
    size=$(du -sh "$BAK" | cut -f1)
    log_info "快照创建完成: $TS ($size)"
    echo "$TS"
}

# ── 回滚核心逻辑 ──────────────────────────────────
cmd_restore() {
    local ts="$1"
    local bak="${BACKUP_ROOT}/${ts}"

    echo ""
    echo "============================================"
    echo "  JSC 系统回滚"
    echo "  快照: $ts"
    echo "============================================"
    echo ""

    # 1. 验证快照
    log_step "[1/7] 验证快照完整性"
    if ! verify_backup "$ts"; then
        log_error "快照验证失败，终止回滚"
        exit 1
    fi

    # 2. 创建回滚前应急快照
    log_step "[2/7] 创建回退前急救快照"
    local rescue_ts
    rescue_ts=$(cmd_create)
    log_info "急救快照已创建: $rescue_ts (回滚失败时可用此刻度恢复)"

    # 3. 停止后端服务
    log_step "[3/7] 停止后端服务"
    systemctl stop jsc-backend
    sleep 2
    if systemctl is-active --quiet jsc-backend; then
        log_error "后端服务未能停止，强制杀进程"
        pkill -9 -f "node index.js" || true
        sleep 1
    fi
    log_info "后端服务已停止"

    # 4. 恢复数据库 (WAL 模式下先 checkpoint)
    log_step "[4/7] 恢复数据库"
    log_info "备份当前数据库为 /opt/jsc/backend/data/jsc.db.before-rollback"
    cp -a "$BACKEND_DIR/data/jsc.db" "$BACKEND_DIR/data/jsc.db.before-rollback" 2>/dev/null || true
    # 先删除 WAL/SHM，再用备份 DB 替换
    rm -f "$BACKEND_DIR/data/jsc.db-wal" "$BACKEND_DIR/data/jsc.db-shm"
    cp -a "$bak/data/jsc.db" "$BACKEND_DIR/data/jsc.db"
    if [ -f "$bak/data/jsc.db-wal" ]; then
        cp -a "$bak/data/jsc.db-wal" "$BACKEND_DIR/data/"
    fi
    if [ -f "$bak/data/jsc.db-shm" ]; then
        cp -a "$bak/data/jsc.db-shm" "$BACKEND_DIR/data/"
    fi
    # 合并 WAL 到主数据库
    if command -v sqlite3 &>/dev/null; then
        sqlite3 "$BACKEND_DIR/data/jsc.db" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true
    fi
    log_info "数据库已恢复"

    # 5. 恢复后端代码
    log_step "[5/7] 恢复后端代码与配置"
    for f in "$bak/backend"/*.js; do
        fname=$(basename "$f")
        cp -a "$f" "$BACKEND_DIR/$fname"
    done
    if [ -f "$bak/backend/package.json" ]; then
        cp -a "$bak/backend/package.json" "$BACKEND_DIR/"
    fi
    cp -a "$bak/data/config.json" "$BACKEND_DIR/data/"
    cp -a "$bak/data/transcoder.json" "$BACKEND_DIR/data/" 2>/dev/null || true
    log_info "后端代码已恢复"

    # 6. 恢复前端文件
    log_step "[6/7] 恢复前端文件"
    rm -rf "$FRONTEND_DIR/assets"
    cp -a "$bak/frontend/index.html" "$FRONTEND_DIR/"
    cp -a "$bak/frontend/assets/" "$FRONTEND_DIR/assets/"
    log_info "前端文件已恢复"

    # 7. 恢复 nginx 配置 + 重启服务
    log_step "[7/7] 恢复 nginx 配置并启动服务"
    if [ -f "$bak/nginx/uav-sites" ]; then
        cp -a "$bak/nginx/uav-sites" "$NGINX_SITE"
        if nginx -t; then
            nginx -s reload
            log_info "nginx 配置已恢复并重载"
        else
            log_error "nginx 配置检测失败! 请手动检查"
        fi
    fi

    systemctl daemon-reload
    systemctl start jsc-backend
    sleep 2

    echo ""
    echo "============================================"
    echo -e "${GREEN}  回滚完成！${NC}"
    echo "============================================"
    echo ""

    # 验证回滚结果
    log_info "验证服务状态..."
    echo ""
    echo -e "后端服务: $(systemctl is-active jsc-backend)"
    echo -e "nginx:    $(systemctl is-active nginx)"
    echo -e "数据库:   $(ls -lh "$BACKEND_DIR/data/jsc.db" | awk '{print $5}')"
    echo -e "前端文件: $(ls "$FRONTEND_DIR/index.html" | head -1)"
    echo ""
    log_info "急救快照: $rescue_ts (如本次回滚有问题，可再次回滚到此刻)"
    echo ""
}

# ── 主入口 ────────────────────────────────────────
case "${1:-}" in
    list)
        cmd_list
        ;;
    restore)
        if [ -z "${2:-}" ]; then
            echo "用法: rollback.sh restore <快照时间>"
            echo "先用 'rollback.sh list' 查看可用快照"
            exit 1
        fi
        cmd_restore "$2"
        ;;
    verify)
        if [ -z "${2:-}" ]; then
            echo "用法: rollback.sh verify <快照时间>"
            exit 1
        fi
        verify_backup "$2"
        ;;
    create)
        cmd_create
        ;;
    *)
        echo "JSC 系统回滚工具"
        echo ""
        echo "用法:"
        echo "  rollback.sh list              列出所有可用备份"
        echo "  rollback.sh create            立即创建新快照"
        echo "  rollback.sh verify <时间戳>    验证快照完整性"
        echo "  rollback.sh restore <时间戳>   回滚到指定快照"
        echo ""
        echo "备份目录: $BACKUP_ROOT"
        ;;
esac
