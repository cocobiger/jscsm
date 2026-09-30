#!/bin/bash
# e2e_test_engine.sh —— straw-engine 全链路端到端验收（用桩模型 + 合成视频，测完即还原）
#
# 为什么用桩模型：现网烟雾模型已随 7TiB 盘丢失，没有真模型就无法验证
#   「抽帧 → 推理 → 连3帧确认 → 上报 → 取证落盘 → /metrics」这条主链路。
#   桩模型是一个只输出 1 个固定框的极简 ONNX，用来证明**管线正确**，不证明模型准确。
set -e
R=/data/HBJSC/straw-engine
V=$R/venv/bin
T=/tmp/e2e
mkdir -p $T

echo "########## 1. 造桩模型（输出 [1,5,1] = 1 个 smoke 框，score 0.9）##########"
"$V/pip" install -q onnx 2>&1 | tail -2
"$V/python" - <<'PY'
import numpy as np, onnx
from onnx import helper, TensorProto, numpy_helper
inp = helper.make_tensor_value_info('images', TensorProto.FLOAT, [1, 3, 1920, 1920])
out = helper.make_tensor_value_info('output0', TensorProto.FLOAT, [1, 5, 1])
# [cx, cy, w, h, score] —— 1920 画布绝对像素（与 ultralytics 导出一致）
val = np.array([[[960.0], [960.0], [400.0], [300.0], [0.9]]], dtype=np.float32)
node = helper.make_node('Constant', [], ['output0'], value=numpy_helper.from_array(val, 'c'))
g = helper.make_graph([node], 'stub', [inp], [out])
m = helper.make_model(g, opset_imports=[helper.make_opsetid('', 17)])
m.ir_version = 8
onnx.checker.check_model(m)
onnx.save(m, '/tmp/e2e/stub.onnx')
print('  ✅ 桩模型已生成 /tmp/e2e/stub.onnx')
PY

echo
echo "########## 2. 造合成视频（1280x720 动态画面，40s）##########"
ffmpeg -y -f lavfi -i "testsrc=size=1280x720:rate=10" -t 40 -pix_fmt yuv420p "$T/testsrc.mp4" >/dev/null 2>&1
ls -la "$T/testsrc.mp4" | awk '{print "  ", $5, "字节"}'

echo
echo "########## 3. 备份真配置，换成测试配置 ##########"
cp -a "$R/config/config.json" "$T/config.real.json"
"$V/python" - <<'PY'
import json, io
p='/data/HBJSC/straw-engine/config/config.json'
c=json.load(io.open(p,encoding='utf-8'))
c['modelDay']='/tmp/e2e/stub.onnx'
c['modelNight']='/tmp/e2e/stub.onnx'
c['interval']=1
c['cfmNeed']=3
c['streams']=[{'id':'sikong_TEST','name':'E2E测试流','url':'/tmp/e2e/testsrc.mp4','interval':1}]
json.dump(c, io.open(p,'w',encoding='utf-8'), ensure_ascii=False, indent=1)
print('  ✅ 已切到测试配置（streams=1, 桩模型）')
PY

echo
echo "########## 4. 重启引擎并等它跑一阵 ##########"
systemctl restart straw-engine
sleep 14
echo "  服务: $(systemctl is-active straw-engine)"

echo
echo "########## 5. 验收 A：抽帧 + 推理 + 连3帧确认 + 上报 ##########"
curl -s --max-time 8 http://127.0.0.1:7200/health | "$V/python" -c "
import sys,json
d=json.load(sys.stdin)
w=(d.get('workers') or {}).get('sikong_TEST')
print('  /health workers.sikong_TEST =')
for k in ('running','stream_ok','detects','alerts','last_conf','last_ms','model_used','is_night','cfm_status','cfm_hits','cfm_need','note'):
    print('    %-14s %s' % (k, w.get(k) if w else '(无该流)'))
print('  resource:', d.get('resource'))
"
echo
echo "  --- /debug/snapshot（frame_age_s 是否新鲜 = 是否真抽帧）---"
curl -s --max-time 8 http://127.0.0.1:7200/debug/snapshot | "$V/python" -c "
import sys,json
d=json.load(sys.stdin)
s=(d.get('streams') or {}).get('sikong_TEST')
print('   ', json.dumps(s, ensure_ascii=False) if s else '(无)')
"
echo
echo "  --- /metrics（last_report_ok 是上报结果）---"
curl -s --max-time 8 http://127.0.0.1:7200/metrics | "$V/python" -c "
import sys,json
d=json.load(sys.stdin)
print('    total_alerts =', d.get('total_alerts'))
print('    per_stream   =', json.dumps((d.get('per_stream') or {}).get('sikong_TEST'), ensure_ascii=False))
"

echo
echo "########## 6. 验收 B：取证图是否落盘 ##########"
# 🔴 evidence 是指向 /data/video/evidence 的软链，find 默认不跟软链 ⇒ 必须 -L，否则恒 0 条（踩过）
EVI=$(readlink -f "$R/evidence")
find -L "$EVI" -name 'sikong_TEST_*.jpg' -newermt '-5 min' 2>/dev/null | head -5 | sed 's/^/    /'
echo "    最近 5 分钟内新增: $(find -L "$EVI" -name 'sikong_TEST_*.jpg' -newermt '-5 min' 2>/dev/null | wc -l) 张"
echo "    evidence 实体目录: $EVI"

echo
echo "########## 7. 验收 C：后端是否真的收到 /api/straw-alert ##########"
echo "  --- 后端日志里最近的 straw-alert ---"
journalctl -u jsc-backend --since '-3 min' --no-pager 2>/dev/null | grep -iE "straw-alert|straw|复检" | tail -8 | sed 's/^/    /' || echo "    （无匹配）"
echo "  --- 直连一次 /api/straw-alert 看后端响应（不经引擎）---"
curl -s -o /tmp/al.out -w '    HTTP %{http_code}\n' --max-time 8 -X POST -H 'Content-Type: application/json' \
  -d '{"streamId":"sikong_TEST","label":"smoke","confidence":0.9,"box":[1,2,3,4],"at":"2026-09-30T11:00:00+08:00"}' \
  http://127.0.0.1:7170/api/straw-alert
head -c 300 /tmp/al.out | sed 's/^/    /'; echo

echo
echo "########## 8. 引擎日志（看有没有异常）##########"
journalctl -u straw-engine --since '-3 min' --no-pager | grep -viE "GET /health|GET /metrics|GET /debug" | tail -14 | sed 's/^/    /'

echo
echo "########## 9. 还原真配置并重启 ##########"
cp -a "$T/config.real.json" "$R/config/config.json"
systemctl restart straw-engine
sleep 5
echo "  服务: $(systemctl is-active straw-engine)"
curl -s --max-time 8 http://127.0.0.1:7200/health | "$V/python" -c "
import sys,json
d=json.load(sys.stdin)
print('  还原后 workers 数:', len(d.get('workers') or {}), '（应为 0）')
print('  还原后 model_path:', d.get('model_path'))
"
echo
echo "E2E_TEST_DONE"
