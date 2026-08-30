#!/bin/bash
# v5 smoke 训练 v4 (从 v5_smoke_v3 best.pt 续训; 27 用户复核 + 5 DJI 真烟照片)
# 用法: bash train_v5_v4.sh
set -e

MODEL=/video/xunlian/runs/detect/v5_smoke_v3/base/weights/best.pt
EPOCHS=100
DATA=/video/shujuji/datasets/v5_train_v4/v5_smoke_v4.yaml
RUN=/video/xunlian/runs/detect/v5_smoke_v4
STRAW=/opt/jsc/straw-engine

mkdir -p $RUN

echo "====== v5 smoke v4 训练启动 (从 v3 best.pt 续训) ======"
echo "model  : $MODEL (v3 best)"
echo "epochs : $EPOCHS"
echo "data   : $DATA (27 用户复核 + 5 DJI 真烟, DJI 全部进 train)"
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
  patience=20 save_period=20 \
  2>&1 | tee $RUN/train.log

echo "====== v4 训练完成 ======"
echo "end    : $(date '+%F %T')"
echo "best   : $RUN/base/weights/best.pt"
