#!/bin/bash
# setup_train_env.sh —— 建「算法训练」专用环境（独立于推理的 straw-engine venv）
#
# 为什么独立
#   ultralytics 会拉一大堆依赖（matplotlib/polars/opencv …），混进生产推理的 venv 有把引擎搞坏的风险。
#   故单独建 /data/HBJSC/train-venv。
#
# 🔴 唯一的坑：torch 必须走 CUDA 索引
#   直接 `pip install torch` 会拿到 **CPU 轮子**（装完 torch.cuda.is_available()==False，白跑）。
#
# 用法（长任务，建议脱离 SSH 会话跑）：
#   bash setup_train_env.sh            # 幂等，可重复执行
#   # 或：setsid nohup bash setup_train_env.sh < /dev/null > /tmp/setup_train_env.log 2>&1 &
#
# 产出：/data/HBJSC/train-venv（约 5.5 GB，含 torch 2.6.0+cu124 / torchvision / ultralytics / onnx）
set -e
V=/data/HBJSC/train-venv
PYIDX=https://download.pytorch.org/whl/cu124

echo "########## 1. 系统依赖 ##########"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq python3-venv libgl1 libglib2.0-0 ffmpeg
echo "  ffmpeg: $(ffmpeg -version 2>/dev/null | head -1)"

echo
echo "########## 2. 建 venv ##########"
[ -d "$V" ] || python3 -m venv "$V"
echo "  python: $($V/bin/python -V 2>&1)"
$V/bin/pip install -q -U pip setuptools wheel

echo
echo "########## 3. torch + torchvision（★ 必须用 cu124 索引，否则是 CPU 轮子）##########"
$V/bin/pip install torch torchvision --index-url "$PYIDX"

echo
echo "########## 4. ultralytics + onnx ##########"
$V/bin/pip install ultralytics onnx

echo
echo "########## 5. Ultralytics 配置（目录指到 /data；避免 /root/.config 不存在导致的告警）##########"
mkdir -p /root/.config/Ultralytics
mkdir -p /data/video/xunlian/runs /data/video/shujuji/datasets
$V/bin/yolo settings runs_dir=/data/video/xunlian/runs datasets_dir=/data/video/shujuji/datasets 2>&1 | tail -2 || true

echo
echo "########## 6. 验收（缺一不可）##########"
$V/bin/python - <<'PY'
import torch, ultralytics
ok = True
print('torch        =', torch.__version__, '| cuda_build =', torch.version.cuda)
print('cuda_available =', torch.cuda.is_available())
if torch.cuda.is_available():
    print('device       =', torch.cuda.get_device_name(0), '| cap =', torch.cuda.get_device_capability(0))
    x = torch.randn(2048, 2048, device='cuda'); y = x @ x; torch.cuda.synchronize()
    print('GPU matmul   = OK', tuple(y.shape))
else:
    ok = False
    print('!! CUDA 不可用 —— 很可能装成了 CPU 轮子（检查 --index-url）')
print('ultralytics  =', ultralytics.__version__)
from ultralytics import YOLO
print('YOLO import  = OK')
import onnx; print('onnx         =', onnx.__version__)
raise SystemExit(0 if ok else 1)
PY
echo "  体积: $(du -sh $V | cut -f1)"
echo "SETUP_TRAIN_ENV_DONE"
