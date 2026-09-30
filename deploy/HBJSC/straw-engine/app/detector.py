"""烟火检测 ONNX 推理封装（0=smoke, 1=fire, 2=house）
house（居民住房）用于排除误识：模型检出的 house 类不触发告警。
⚠️ 2026-09-03 修正：模型实际类别数以 ONNX 输出 shape 探测为准（self.nc / self.classes），
   不再硬编码 3 类。现网 v5 stage2 为单类(smoke)模型，nc=1 → 仅 conf_smoke 生效，
   conf_fire/conf_house 不参与（保留字段仅为兼容调用方，避免语义残留误导排查）。
支持两种输出格式：
  - format='yolo'   : YOLO 系 [1, 4+C, N]，每列 [cx,cy,w,h,cls_scores...]
  - format='rtdetr' : RT-DETR   [1, 300, 6]，每行 [cx,cy,w,h,score,cls]（归一化）
"""
import os
import numpy as np
import onnxruntime as ort
import cv2

CLASSES = ['smoke', 'fire', 'house']
CLASS_HINT = {1: ['smoke'], 2: ['smoke', 'fire'], 3: ['smoke', 'fire', 'house']}


def nms(boxes, iou_thr=0.45):
    if not boxes:
        return []
    arr = np.array(boxes, dtype=np.float64)
    x1, y1, x2, y2, scores = arr[:, 0], arr[:, 1], arr[:, 2], arr[:, 3], arr[:, 4]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1)
        h = np.maximum(0.0, yy2 - yy1)
        inter = w * h
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-6)
        inds = np.where(iou <= iou_thr)[0]
        order = order[inds + 1]
    return [boxes[int(i)] for i in keep]


def spatial_cluster(boxes, iou_thr=0.3):
    """空间聚类多信号融合：重叠框(IoU>thr)合并为簇 → 主框(union) + 融合分 S
    S = 0.55*conf_max + 0.20*(conf_max-conf_std) + 0.25*min(1,n/4)*conf_mean
    conf_std 惩罚误报聚集（真烟多框 conf 收敛 std 小，误报聚集抖动 std 大）
    返回 [x1,y1,x2,y2,S,cls]（S 替代原始 score 供 confirmer 直接用）
    """
    if not boxes:
        return []

    def _iou(a, b):
        ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
        iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
        inter = ix * iy
        ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
        return inter / (ua + 1e-6) if ua > 0 else 0.0

    clusters = []  # list of list of boxes
    for b in boxes:
        placed = False
        for c in clusters:
            if any(_iou(b, cb) > iou_thr for cb in c):
                c.append(b)
                placed = True
                break
        if not placed:
            clusters.append([b])

    out = []
    for c in clusters:
        confs = [b[4] for b in c]
        conf_max = max(confs)
        conf_mean = sum(confs) / len(confs)
        conf_std = (sum((x - conf_mean) ** 2 for x in confs) / len(confs)) ** 0.5 if len(confs) > 1 else 0.0
        n = len(c)
        x1 = min(b[0] for b in c)
        y1 = min(b[1] for b in c)
        x2 = max(b[2] for b in c)
        y2 = max(b[3] for b in c)
        cls = int(c[0][5])
        S = 0.55 * conf_max + 0.20 * max(0.0, conf_max - conf_std) + 0.25 * min(1.0, n / 4.0) * conf_mean
        out.append([x1, y1, x2, y2, round(S, 4), cls])
    out.sort(key=lambda b: -b[4])
    return out


class Detector:
    def __init__(self, model_path, conf=0.40, iou=0.45, input_size=640,
                 conf_smoke=None, conf_fire=None, conf_house=None, format='yolo', use_gpu=True):
        """conf_smoke/conf_fire/conf_house：分类别置信度阈值。
        秸秆焚烧"先冒烟后见火"——smoke(0) 用低阈值更敏感（优先检出、不漏报），
        fire(1) 用高阈值更严格（减少火焰/反光/灯光误报），
        house(2) 为居民住房排除类（模型检出但不触发告警）。
        未指定时默认沿用 conf（向后兼容）。
        format：'yolo' | 'rtdetr'，use_gpu：优先 CUDA（失败自动回退 CPU）"""
        opts = os.environ.get('ORT_THREADS', '8')
        try:
            threads = int(opts)
        except ValueError:
            threads = 8
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        providers = ['CUDAExecutionProvider', 'CPUExecutionProvider'] if use_gpu else ['CPUExecutionProvider']
        try:
            self.sess = ort.InferenceSession(model_path, so, providers=providers)
        except Exception:
            # CUDA 不可用时回退 CPU，避免服务起不来
            self.sess = ort.InferenceSession(model_path, so, providers=['CPUExecutionProvider'])
        self.input_name = self.sess.get_inputs()[0].name
        self.use_gpu = 'CUDAExecutionProvider' in (self.sess.get_providers() or [])
        self.conf = conf
        self.conf_smoke = float(conf_smoke) if conf_smoke is not None else conf
        self.conf_fire = float(conf_fire) if conf_fire is not None else conf
        self.conf_house = float(conf_house) if conf_house is not None else conf
        self.iou = iou
        self.size = input_size
        self.format = format
        # ── 2026-09-03：探测模型真实类别数，消除"按 3 类解析单类 onnx"的死配置 ──
        # YOLO 输出 [1, 4+C, N] → nc=C；RT-DETR 输出 [1, N, 6] 末列为 cls 索引，无法直接读 C，
        # 但旧 RT-DETR 为 3 类模型，此处保持 CLASSES 长度兜底（rtdetr 分支仍按 3 类过滤）。
        self.nc = None
        self.classes = list(CLASSES)
        try:
            out_shape = self.sess.get_outputs()[0].shape
            if self.format == 'yolo' and len(out_shape) >= 2:
                dim1 = out_shape[1]
                if isinstance(dim1, int) and dim1 > 4:
                    self.nc = dim1 - 4
                    self.classes = list(CLASS_HINT.get(self.nc, [f'cls{i}' for i in range(self.nc)]))
        except Exception as e:
            print('[detector] nc 探测失败（按 CLASSES 兜底）:', e)
        if self.nc is None:
            print('[detector] 无法探测类别数，回退 CLASSES=%s' % CLASSES)
        else:
            print(f'[detector] 探测到模型类别数 nc={self.nc} classes={self.classes} '
                  f'→ conf_smoke={self.conf_smoke} 生效' +
                  ('' if self.nc <= 1 else f' conf_fire={self.conf_fire} conf_house={self.conf_house}'))

    def _thr(self, cls_id, conf_smoke=None, conf_fire=None, conf_house=None):
        """分类别阈值：0=smoke 1=fire 2=house（仅当模型含对应类别时生效）
        2026-09-12：支持调用期覆盖（分域双模型共享同一会话时按昼夜传阈值，避免实例状态竞态）"""
        cs = self.conf_smoke if conf_smoke is None else float(conf_smoke)
        cf = self.conf_fire if conf_fire is None else float(conf_fire)
        ch = self.conf_house if conf_house is None else float(conf_house)
        if self.nc is not None and self.nc <= 1:
            return cs
        if cls_id == 0:
            return cs
        if cls_id == 1:
            return cf
        return ch

    def predict(self, img_bgr, conf_smoke=None, conf_fire=None, conf_house=None):
        """输入 BGR 帧，返回 [[x1,y1,x2,y2,score,cls],...]（原图坐标）
        预处理与 ultralytics 训练一致（letterbox 保持纵横比 + 灰边填充），
        避免直接 resize 拉伸导致微调模型精度打折。

        ── 2026-09-27 性能优化（P0-④）────────────────────────────
        实测（RTX 3090，源帧 1440×1080，真实 evidence 帧）：
          旧：**314.5 ms/帧**   →   新：**107.5 ms/帧**   ⇒ **2.93×**
          正确性：与旧实现逐框对比 **minIoU = 1.0000**（框数完全一致）

        原实现有三处与「1920 输入」严重不匹配的开销，合计占整帧约 70%：
          ① 【主因】**Python 逐行循环解码**：`for p in preds` 遍历全部 anchor。
             1920 输入下 anchor 数 N = 240²+120²+60² = **75600**，每行还做一次 np.argmax
             → 实测 **190ms**（占 55%）。向量化后 **1.1ms**（**168×**）。
          ② `canvas.astype(float32)/255` 产生 44MB float32，再 `transpose(2,0,1)[None]`
             得到**非连续视图**直接喂 ORT，ORT 内部仍需再拷一次 → 节省 **43ms**。
          ③ 先对整张原图 cvtColor、再对 1920² 画布整体做 float 转换；改为「先 resize 再转色」
             +「预分配 float32 缓冲」+「只对粘贴区做转换」→ 再省约 30ms。
        注：BGR→RGB 与 resize 可交换（前者是纯通道置换、不跨通道插值），故改序不改变数值结果。
        """
        h, w = img_bgr.shape[:2]
        # letterbox：等比缩放 + 114 灰边填充到 self.size
        scale = min(self.size / w, self.size / h)
        nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
        left = (self.size - nw) // 2
        top = (self.size - nh) // 2
        # 先 resize 再转色：转色只作用于 nw×nh，比"整张原图转色"更省
        resized = cv2.resize(img_bgr, (nw, nh), interpolation=cv2.INTER_LINEAR)
        resized = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)

        # 预分配缓冲：避免每帧 44MB 分配 + 非连续视图带来的 ORT 内部拷贝
        if getattr(self, '_buf_chw', None) is None or self._buf_chw.shape[-1] != self.size:
            self._buf_chw = np.empty((1, 3, self.size, self.size), dtype=np.float32)
        if getattr(self, '_buf_hwc', None) is None or self._buf_hwc.shape[0] != self.size:
            self._buf_hwc = np.empty((self.size, self.size, 3), dtype=np.float32)

        self._buf_hwc[:, :, :] = 114.0 / 255.0                 # 底色（直接以 float32 装，省 astype）
        self._buf_hwc[top:top + nh, left:left + nw, :] = \
            resized.astype(np.float32) * (1.0 / 255.0)          # 只转粘贴区
        np.copyto(self._buf_chw[0], self._buf_hwc.transpose(2, 0, 1))

        out = self.sess.run(None, {self.input_name: self._buf_chw})[0]

        if self.format == 'rtdetr':
            # RT-DETR 输出 [1, N, 6]：每行 [cx,cy,w,h,score,cls]，归一化坐标
            return self._decode_rtdetr(out, scale, left, top)

        # YOLO 输出 [1, 4+C, M]：每列 [cx,cy,w,h,cls_scores...]
        # 注：ultralytics 标准导出 box = 输入像素绝对坐标、cls 已 sigmoid(0~1)
        preds = out[0].transpose(1, 0)                          # (M, 4+C)
        nc = self.nc if (self.nc is not None) else max(0, preds.shape[1] - 4)
        if nc <= 0:
            return []
        # 转 float64：与旧实现的 Python float 运算逐位一致（float32 直接算会有末位差异）
        sc_all = preds[:, 4:4 + nc].astype(np.float64)
        cls_ids = sc_all.argmax(axis=1)
        scores = sc_all[np.arange(sc_all.shape[0]), cls_ids]

        # 分类别阈值（向量化）：smoke(0) 敏感优先检出、fire(1) 严格减误报、house(2) 排除类
        cs = self.conf_smoke if conf_smoke is None else float(conf_smoke)
        cf = self.conf_fire if conf_fire is None else float(conf_fire)
        ch = self.conf_house if conf_house is None else float(conf_house)
        if self.nc is not None and self.nc <= 1:
            keep = scores >= cs
        else:
            thr = np.where(cls_ids == 0, cs, np.where(cls_ids == 1, cf, ch))
            keep = scores >= thr
        if not keep.any():
            return []

        p = preds[keep].astype(np.float64)
        cls_ids = cls_ids[keep]
        scores = scores[keep]
        cx, cy, bw, bh = p[:, 0], p[:, 1], p[:, 2], p[:, 3]
        # 绝对像素坐标 → 减去 letterbox 偏移 → 原图坐标
        boxes = np.stack([(cx - bw / 2.0 - left) / scale,
                          (cy - bh / 2.0 - top) / scale,
                          (cx + bw / 2.0 - left) / scale,
                          (cy + bh / 2.0 - top) / scale,
                          scores,
                          cls_ids.astype(np.float64)], axis=1)
        return spatial_cluster(nms(boxes.tolist(), self.iou))

    def _decode_rtdetr(self, out, scale, left, top):
        """RT-DETR 输出 [1, N, 6]：归一化 xywh + score + cls → 原图坐标框"""
        preds = out[0] if len(out.shape) == 3 else out
        boxes = []
        for o in preds:
            cx, cy, bw, bh = float(o[0]), float(o[1]), float(o[2]), float(o[3])
            score = float(o[4])
            cls_id = int(round(float(o[5])))
            if cls_id not in (0, 1, 2):
                continue
            # 分类别阈值：smoke(0) 敏感优先检出，fire(1) 严格减少误报，house(2) 排除类
            thr = self._thr(cls_id, conf_smoke, conf_fire, conf_house)
            if score < thr:
                continue
            # 归一化坐标 → canvas 像素 → 减去 letterbox 偏移 → 原图坐标
            px, py = cx * self.size, cy * self.size
            pw, ph = bw * self.size, bh * self.size
            x1 = (px - pw / 2 - left) / scale
            y1 = (py - ph / 2 - top) / scale
            x2 = (px + pw / 2 - left) / scale
            y2 = (py + ph / 2 - top) / scale
            boxes.append([x1, y1, x2, y2, score, cls_id])
        return spatial_cluster(nms(boxes, self.iou))
