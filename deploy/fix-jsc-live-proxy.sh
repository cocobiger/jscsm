#!/bin/bash
# 修复 /jsc/live/ 反代路径错误
# 问题：proxy_pass http://127.0.0.1:6080/ 会把 /jsc/live/ 前缀全部剥掉
# 修复：proxy_pass http://127.0.0.1:6080/live/ 保留 live/ 前缀

set -e

CONF="/etc/nginx/sites-available/uav-sites"

# 备份
cp -f "$CONF" "$CONF.bak.fix-$(date +%Y%m%d_%H%M%S)"

# 替换 proxy_pass
sed -i 's|proxy_pass http://127.0.0.1:6080/;|proxy_pass http://127.0.0.1:6080/live/;|g' "$CONF"

# 检查语法
nginx -t

# reload
nginx -s reload

echo "FIX_OK: /jsc/live/ proxy_pass changed to 6080/live/"
echo "TEST_URL: http://111.10.220.226:81/jsc/live/<streamId>.live.flv"
