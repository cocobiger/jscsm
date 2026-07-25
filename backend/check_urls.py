import json, urllib.request
data = json.loads(urllib.request.urlopen('http://172.17.0.2/index/api/getMediaList?secret=035c73f7-bb6b-4889-a715-d9eb2d192xxx', timeout=5).read())
for m in data['data']:
    if m['app'] == 'jsc_h264':
        url = 'http://111.10.220.226:6080/jsc_h264/' + m['stream'] + '/hls.m3u8'
        print('PUBLIC URL:', url)
