"""YOLOv8 ONNX 推理封装（烟火检测：0=smoke, 1=fire）"""
import os
import numpy as np
import onnxruntime as ort
import cv2

CLASSES = ['smoke', 'fire']


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


class Detector:
    def __init__(self, model_path, conf=0.40, iou=0.45, input_size=640):
        opts = os.environ.get('ORT_THREADS', '8')
        try:
            threads = int(opts)
        except ValueError:
            threads = 8
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        self.sess = ort.InferenceSession(
            model_path, so, providers=['CPUExecutionProvider'])
        self.input_name = self.sess.get_inputs()[0].name
        self.conf = conf
        self.iou = iou
        self.size = input_size

    def predict(self, img_bgr):
        """输入 BGR 帧，返回 [[x1,y1,x2,y2,score,cls],...]（原图坐标）
        预处理与 ultralytics 训练一致（letterbox 保持纵横比 + 灰边填充），
        避免直接 resize 拉伸导致微调模型精度打折。"""
        h, w = img_bgr.shape[:2]
        rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        # letterbox：等比缩放 + 114 灰边填充到 self.size
        scale = min(self.size / w, self.size / h)
        nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
        resized = cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_LINEAR)
        canvas = np.full((self.size, self.size, 3), 114, dtype=np.uint8)
        left = (self.size - nw) // 2
        top = (self.size - nh) // 2
        canvas[top:top + nh, left:left + nw] = resized
        x = canvas.astype(np.float32) / 255.0
        x = x.transpose(2, 0, 1)[None]
        out = self.sess.run(None, {self.input_name: x})[0]
        preds = out[0].transpose(1, 0)
        boxes = []
        for p in preds:
            cx, cy, bw, bh = p[0], p[1], p[2], p[3]
            cls_scores = p[4:]
            cls_id = int(np.argmax(cls_scores))
            score = float(cls_scores[cls_id])
            if score < self.conf:
                continue
            # 归一化坐标 → canvas 像素 → 减去 letterbox 偏移 → 原图坐标
            px = (cx - 0.5) * self.size
            py = (cy - 0.5) * self.size
            pw = bw * self.size
            ph = bh * self.size
            x1 = (px - pw / 2 - left) / scale
            y1 = (py - ph / 2 - top) / scale
            x2 = (px + pw / 2 - left) / scale
            y2 = (py + ph / 2 - top) / scale
            boxes.append([x1, y1, x2, y2, score, cls_id])
        return nms(boxes, self.iou)
