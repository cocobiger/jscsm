#!/bin/bash
# ============================================================
# v5_3cls_nonamp 训练监控：等待训练退出后自动跑双口径回归
# 用法: nohup bash /tmp/wait_train_nonamp.sh > /video/llm_infer/v5_3cls_nonamp_after_train.log 2>&1 &
# 回归: regress_v5_3cls.py 0.10/0.25 <nonamp best.pt>（脚本已参数化 V5 路径）
# ============================================================
PID=$(cat /video/llm_infer/train_v5_3cls_nonamp.pid 2>/dev/null)
echo "[wait] $(date '+%F %T') 等待 PID=$PID 训练结束..." 
while kill -0 "$PID" 2>/dev/null; do
  sleep 60
done
echo "[done] $(date '+%F %T') 训练进程已退出"
ls -la /video/xunlian/runs/detect/v5_smoke_3cls_nonamp/weights/ 2>/dev/null
echo "[regress] conf=0.10"
/opt/jsc/straw-engine/venv/bin/python3 /video/llm_infer/regress_v5_3cls.py 0.10 /video/xunlian/runs/detect/v5_smoke_3cls_nonamp/weights/best.pt
echo "[regress] conf=0.25"
/opt/jsc/straw-engine/venv/bin/python3 /video/llm_infer/regress_v5_3cls.py 0.25 /video/xunlian/runs/detect/v5_smoke_3cls_nonamp/weights/best.pt
echo "[all done] $(date '+%F %T')"
