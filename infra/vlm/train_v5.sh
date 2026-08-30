#!/bin/bash
# v5 smoke 单类训练启动脚本（v1 基线）
# 用法: bash train_v5.sh [model] [epochs]
#   model  默认 yolo11m.pt  (可换 yolo11l.pt / rtdetr-l.pt)
#   epochs 默认 150
set -e

MODEL=${1:-yolo11m.pt}
EPOCHS=${2:-150}
DATA=/video/shujuji/datasets/v5_train/v5_smoke.yaml
RUN=/video/xunlian/runs/detect/v5_smoke_v1
STRAW=/opt/jsc/straw-engine
VENV_PY=$STRAW/venv/bin/python

mkdir -p $RUN

echo "====== v5 smoke v1 训练启动 ======"
echo "model  : $MODEL"
echo "epochs : $EPOCHS"
echo "data   : $DATA"
echo "run    : $RUN"
echo "start  : $(date '+%F %T')"

cd $STRAW
$STRAW/venv/bin/yolo detect train \
  model=$MODEL \
  data=$DATA \
  imgsz=1280 batch=8 epochs=$EPOCHS \
  mosaic=0 copy_paste=0.3 close_mosaic=50 \
  device=0 workers=4 cache=ram \
  project=$RUN name=base \
  exist_ok=True \
  patience=30 save_period=20 \
  2>&1 | tee $RUN/train.log

echo "====== 训练完成 ======"
echo "end    : $(date '+%F %T')"
echo "best   : $RUN/base/weights/best.pt"
echo "last   : $RUN/base/weights/last.pt"
