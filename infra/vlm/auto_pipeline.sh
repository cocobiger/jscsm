#!/bin/bash
# 自动管线：等待环境就绪 -> 模型就绪 -> 试跑 -> 全量 400 帧推理
LOG=/tmp/auto_pipeline.log
exec >> $LOG 2>&1
echo "[$(date '+%F %T')] watcher started"

# 1. 等 transformers 环境装完
echo "[$(date '+%F %T')] waiting for pip env (torch+transformers)..."
while ! grep -q TRANSFORMERS_DONE /tmp/pip_vlm.log 2>/dev/null; do sleep 30; done
echo "[$(date '+%F %T')] pip env ready"

# 2. 等模型下载完（model3b >= 6GB 且 hf 进程退出）
echo "[$(date '+%F %T')] waiting for 3B model download (>=6GB)..."
while true; do
  sz=$(du -sm /video/llm_infer/model3b 2>/dev/null | cut -f1)
  if [ "${sz:-0}" -ge 6000 ] && ! pgrep -f 'hf download' > /dev/null; then break; fi
  sleep 30
done
sleep 5
echo "[$(date '+%F %T')] model ready: $(du -sh /video/llm_infer/model3b 2>/dev/null)"

# 3. 显存检查
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader

# 4. 试跑 1 帧
echo "[$(date '+%F %T')] smoke test 1 frame..."
cd /video/llm_infer
timeout 300 /video/venvs/vlm/bin/python infer_vlm_tf.py 0 1 2>&1 | tail -5
if grep -q 'ERR\|Traceback' /tmp/infer_vlm_tf.log 2>/dev/null; then
  echo "[$(date '+%F %T')] SMOKE TEST FAILED, aborting"
  exit 1
fi

# 5. 全量 400 帧推理
echo "[$(date '+%F %T')] starting full inference (400 frames)..."
nohup /video/venvs/vlm/bin/python infer_vlm_tf.py > /tmp/infer_vlm_tf.log 2>&1 &
echo "[$(date '+%F %T')] full inference started pid=$!"
