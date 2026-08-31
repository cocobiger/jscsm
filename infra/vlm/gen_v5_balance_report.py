#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P3-2b: v5 训练集配比报告生成器（2026-09-01）

输入:
- /video/shujuji/datasets/v5_train_merge/{images,labels}/*.{jpg,png,txt}
- /video/shujuji/datasets/v5_candidates/neg_classified.json (P3-2a VLM 分类)
- /video/shujuji/datasets/v5_candidates/straw_detections scene 标签
- /video/shujuji/datasets/{v5_wechat,v5_syn}/images/

输出:
- /video/shujuji/datasets/v5_train_balance_report.json
- /opt/jsc/frontend/v5_balance_report.html
"""
import os, json, re
from collections import Counter

BASE = "/video/shujuji/datasets"
MERGE = f"{BASE}/v5_train_merge"
CAND = f"{BASE}/v5_candidates"
NEG_CLS = f"{CAND}/neg_classified.json"
SCENE_SQLITE = "/opt/jsc/backend/data/jsc.db"
HEX = re.compile(r"^[0-9a-f]{12,}\.(png|jpg)$")
SYN = re.compile(r"^syn_\d+\.jpg$")
DJI = re.compile(r"^DJI_.+\.(jpg|jpeg)$")
CAND_NAME = re.compile(r"^\d{2}-\d{2}-\d{2}-[0-9-]+__f\d+\.jpg$")


def stat_merge():
    """统计 v5_train_merge（当前 3 类集合）"""
    total, empty = 0, 0
    cls_targets = Counter()
    single_cls = Counter()
    multi = Counter()
    sources = Counter()
    for split in ["train", "val"]:
        img_dir = f"{MERGE}/images/{split}"
        lab_dir = f"{MERGE}/labels/{split}"
        for img_name in sorted(os.listdir(img_dir)):
            total += 1
            if HEX.match(img_name):
                sources["wechat"] += 1
            elif SYN.match(img_name):
                sources["syn"] += 1
            elif DJI.match(img_name):
                sources["dji"] += 1
            elif CAND_NAME.match(img_name):
                sources["candidate"] += 1
            else:
                sources["other"] += 1
            lp = f"{lab_dir}/{img_name.rsplit('.',1)[0]}.txt"
            if not os.path.exists(lp):
                empty += 1
                continue
            with open(lp) as f:
                lines = [l.strip() for l in f if l.strip()]
            if not lines:
                empty += 1
                continue
            cls = set()
            for l in lines:
                cid = int(l.split()[0])
                cls_targets[cid] += 1
                cls.add(cid)
            if len(cls) == 1:
                single_cls[next(iter(cls))] += 1
            else:
                multi[frozenset(cls)] += 1
    return {
        "total": total, "empty": empty,
        "single_class": {str(k): v for k, v in single_cls.items()},
        "multi_class": {"|".join(map(str, sorted(k))): v for k, v in multi.items()},
        "targets_per_class": {str(k): v for k, v in cls_targets.items()},
        "sources": dict(sources),
    }


def stat_neg_classified():
    """P3-2a VLM 4 类干扰物分类"""
    d = json.load(open(NEG_CLS, encoding="utf-8"))
    cats = Counter()
    single = Counter()
    errors = 0
    for fp, v in d.items():
        cs = v.get("cats", [])
        if not cs:
            errors += 1
            continue
        cats[",".join(cs)] += 1
        for c in cs:
            single[c] += 1
    return {
        "total": len(d), "errors": errors,
        "combo_top10": dict(sorted(cats.items(), key=lambda x: -x[1])[:10]),
        "single_class": dict(single),
    }


def stat_extra_sources():
    """统计 v5_wechat / v5_syn / DJI 双光数据量"""
    out = {}
    for name, path in [
        ("v5_wechat", f"{BASE}/v5_wechat/images"),
        ("v5_syn", f"{BASE}/v5_syn/images"),
    ]:
        if os.path.exists(path):
            out[name] = sum(1 for _ in os.listdir(path))
    # DJI 双光
    dji_dir = "/video/shujuji/xunlian/evidence/media"
    if os.path.exists(dji_dir):
        dji_v = sum(1 for f in os.listdir(dji_dir) if "_V." in f)
        dji_t = sum(1 for f in os.listdir(dji_dir) if "_T." in f)
        out["dji_dual_light"] = {"V": dji_v, "T": dji_t, "pairs": min(dji_v, dji_t)}
    return out


def main():
    stat = {
        "merge": stat_merge(),
        "neg_classified": stat_neg_classified(),
        "extra": stat_extra_sources(),
    }
    # 派生方案估算
    merge = stat["merge"]
    targets = merge["targets_per_class"]
    # nc=1 smoke-only 派生：smoke 框保留 + 删除 house 框 + fire 框全部删除（fire 弱保留→全删）
    smoke_imgs = merge["single_class"].get("0", 0)
    fire_imgs = merge["single_class"].get("1", 0)
    house_imgs = merge["targets_per_class"].get("2", 0)  # house 目标数
    mixed_smoke_fire = merge["multi_class"].get("0|1", 0)
    mixed_smoke_house = merge["multi_class"].get("0|2", 0)
    pure_neg = merge["empty"]

    # 派生后:
    # 1. 保留 smoke-only 图: smoke_imgs 张
    # 2. 保留 mixed {0,1} → 删 fire 框保 smoke 框: mixed_smoke_fire 张
    # 3. 保留 mixed {0,2} → 删 house 框保 smoke 框: mixed_smoke_house 张
    # 4. 纯负样本: pure_neg 张
    # 5. fire-only 图 + house-only 图 → 都作负样本（删 fire/house 框）
    fire_only_imgs = fire_imgs
    house_target = house_imgs

    # 正样本 = smoke-only + mixed→smoke
    pos_after = smoke_imgs + mixed_smoke_fire + mixed_smoke_house
    # 现有负样本 = pure_neg + fire-only + mixed→负(去掉smoke+fire保留图作负)
    # mixed {0,1} 派生后视为正样本（保留 smoke 框），mixed {0,2} 同理
    # 所以 fire-only 和 house-only + pure_neg = 现有可用负样本
    neg_available = pure_neg + fire_only_imgs
    # 还需要补的负样本 = 1:2~1:3 (负:正) -> 负 = 2*pos_after ~ 3*pos_after
    target_neg = pos_after * 2  # 中位数 2.5
    need_extra_neg = max(0, target_neg - neg_available)

    plan = {
        "pos_after": pos_after,
        "neg_from_merge": neg_available,
        "target_neg_ratio": "1:2 ~ 1:3",
        "target_neg_count": target_neg,
        "need_extra_neg": need_extra_neg,
        "neg_picks": {
            "pole": stat["neg_classified"]["single_class"].get("pole", 0),
            "concrete": stat["neg_classified"]["single_class"].get("concrete", 0),
            "cloud_sample_100": min(100, stat["neg_classified"]["single_class"].get("cloud", 0)),
            "building": stat["neg_classified"]["single_class"].get("building", 0),
            "none_clean": stat["neg_classified"]["single_class"].get("none", 0),
        },
    }
    plan["neg_picks_total"] = sum(plan["neg_picks"].values())
    plan["neg_picks_sufficient"] = plan["neg_picks_total"] >= need_extra_neg
    stat["plan"] = plan

    out = "/video/shujuji/datasets/v5_train_balance_report.json"
    json.dump(stat, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"saved -> {out}")
    print(json.dumps(stat, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()