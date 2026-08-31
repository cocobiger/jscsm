# -*- coding: utf-8 -*-
"""dock-guard 真机联调一键验证（bash verify.sh 调用）
用法: python3 verify.py
输出: 服务状态 / 各 dock 拉流 / ZLM 推流在线 / 最近告警 / 结论
"""
import json
import subprocess
import sys
import urllib.request

HEALTH = 'http://127.0.0.1:7210/health'
ZLM = 'http://127.0.0.1:6080/index/api/getMediaList?secret=035c73f7-bb6b-4889-a715-d9eb2d192abc&app=jsc'


def get(url):
    try:
        return json.load(urllib.request.urlopen(url, timeout=5))
    except Exception as e:
        return {'_err': str(e)}


def main():
    print('=== dock-guard 联调验证 ===')
    print()
    # 1. 服务状态
    print('--- 1. 服务与健康 ---')
    svc = subprocess.run(['systemctl', 'is-active', 'dock-guard'],
                         capture_output=True, text=True).stdout.strip()
    print('  systemd:', svc)
    h = get(HEALTH)
    if '_err' in h:
        print('  ❌ health 不可达:', h['_err'])
        sys.exit(1)
    print('  版本:', h.get('version'), '| GPU:', h.get('gpu'))
    for sid, st in h.get('docks', {}).items():
        ok = 'OK ' if st.get('stream_ok') else 'FAIL'
        print('  [%s] %s: armed=%s stream=%s bright=%s night=%s persons=%s alerts=%s'
              % (ok, sid, st.get('armed'), st.get('stream_ok'), st.get('bright'),
                 st.get('is_night'), st.get('persons'), st.get('alerts')))
    print()
    # 2. ZLM 推流在线
    print('--- 2. ZLM 推流在线 ---')
    z = get(ZLM)
    lst = z.get('data', [])
    if isinstance(lst, dict):
        lst = lst.get('list', [])
    seen = {}
    for s in lst:
        k = s.get('stream', '')
        if k not in seen:
            seen[k] = s.get('bytesSpeed', 0)
    found = 0
    for k, v in seen.items():
        if k.startswith('sikong_8UUXN'):
            found += 1
            print('  %s: %d B/s' % (k, v))
    if not found:
        print('  ⚠️ 未发现生产流（机场未推流）')
    print()
    # 3. 最近告警
    print('--- 3. 最近告警记录 ---')
    r = subprocess.run(['journalctl', '-u', 'dock-guard', '--no-pager', '-n', '80'],
                       capture_output=True, text=True).stdout
    alerts = [ln for ln in r.splitlines() if '[alert' in ln][-5:]
    if alerts:
        for a in alerts:
            print('  ' + a.strip()[:130])
    else:
        print('  (暂无告警)')
    print()
    # 4. 结论
    print('--- 4. 结论 ---')
    bad = sum(1 for st in h.get('docks', {}).values() if not st.get('stream_ok'))
    print('  拉流异常路数: %d / %d' % (bad, len(h.get('docks', {}))))
    if bad == 0:
        print('  ✅ 联调就绪：生产流全部在线，可进行人员走场测试')
    else:
        print('  ⚠️ 存在拉流异常，请检查机场推流状态（ZLM getMediaList）')


if __name__ == '__main__':
    main()
