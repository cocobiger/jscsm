#!/bin/bash
# v5 smoke 训练 v3 (从 v2 best.pt 继续训练, 用户复核标注 26 帧/53 框)
# 用法: bash train_v5_v3.sh
set -e

MODEL=/video/xunlian/runs/detect/v5_smoke_v2/base/weights/best.pt
EPOCHS=100
DATA=/video/shujuji/datasets/v5_train_v3/v5_smoke_v3.yaml
RUN=/video/xunlian/runs/detect/v5_smoke_v3
STRAW=/opt/jsc/straw-engine

mkdir -p $RUN

echo "====== v5 smoke v3 训练启动 (从 v2 best.pt 续训) ======"
echo "model  : $MODEL (v2 epoch92 best)"
echo "epochs : $EPOCHS"
echo "data   : $DATA (用户复核标注 26帧/53框)"
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

echo "====== v3 训练完成 ======"
echo "end    : $(date '+%F %T')"
echo "best   : $RUN/base/weights/best.pt"
