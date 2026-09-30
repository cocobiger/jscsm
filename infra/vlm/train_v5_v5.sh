#!/bin/bash
# v5 smoke 两阶段训练 v5（C 方案：syn 预训 + 真烟微调）
# Stage1: syn 400 + 负样本全量, 从 v3 best 续训 -> 学烟形态+负样本抑制
# Stage2: 真烟 264 (live182+v2 26+dji 4+wechat 52) + 负样本全量, 从 Stage1 best 续训 -> 真烟微调
# 用法: bash train_v5_v5.sh
set -e

# ★ 训练用独立 venv（与推理的 straw-engine venv 分离，避免 ultralytics 的依赖把推理环境搅坏）
#   建法见 deploy/HBJSC/scripts/setup_train_env.sh
TRAIN_VENV=/data/HBJSC/train-venv
YOLO=$TRAIN_VENV/bin/yolo
BASE=/video/xunlian/runs/detect/v5_smoke_v3/base/weights/best.pt
DATA1=/video/shujuji/datasets/v5_train_v5/v5_smoke_v5_s1.yaml
DATA2=/video/shujuji/datasets/v5_train_v5/v5_smoke_v5_s2.yaml
RUN=/video/xunlian/runs/detect/v5_smoke_v5

[ -x "$YOLO" ] || { echo "!! 训练 venv 不存在：$TRAIN_VENV（先跑 deploy/HBJSC/scripts/setup_train_env.sh）"; exit 1; }
mkdir -p $RUN

echo "====== v5 smoke v5 两阶段训练启动 ======"
echo "base   : $BASE (v3 best)"
echo "stage1 : $DATA1 (syn 400 + neg 全量)"
echo "stage2 : $DATA2 (真烟 264 + neg 全量, 剔 syn)"
echo "run    : $RUN"
echo "start  : $(date '+%F %T')"

cd $TRAIN_VENV

echo "---------- Stage 1: syn 预训 ----------"
$YOLO detect train \
  model=$BASE \
  data=$DATA1 \
  imgsz=1280 batch=8 epochs=60 \
  mosaic=0 copy_paste=0.3 close_mosaic=50 \
  device=0 workers=4 cache=ram \
  project=$RUN name=stage1 \
  exist_ok=True \
  patience=15 save_period=15 \
  2>&1 | tee $RUN/stage1.log

echo "---------- Stage 2: 真烟微调 (从 stage1 best 续训) ----------"
S1_BEST=$RUN/stage1/weights/best.pt
[ -f $S1_BEST ] || { echo "!! stage1 best.pt 不存在: $S1_BEST"; exit 1; }
$YOLO detect train \
  model=$S1_BEST \
  data=$DATA2 \
  imgsz=1280 batch=8 epochs=60 \
  mosaic=0 copy_paste=0.3 close_mosaic=50 \
  device=0 workers=4 cache=ram \
  project=$RUN name=stage2 \
  exist_ok=True \
  patience=20 save_period=10 \
  2>&1 | tee $RUN/stage2.log

echo "====== v5 两阶段训练完成 ======"
echo "end    : $(date '+%F %T')"
echo "stage1 best: $RUN/stage1/weights/best.pt"
echo "stage2 best: $RUN/stage2/weights/best.pt"
