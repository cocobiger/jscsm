# -*- coding: utf-8 -*-
import sys

path = '/opt/jsc/dji-bridge/dji_bridge.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add --no-fullscreen argument
old_arg = '    parser.add_argument("--parent-name", default=None, help="\u7236\u8bbe\u5907\u540d\u79f0\uff08\u7528\u4e8e\u5d4c\u5957\u5b50\u76f8\u673a\uff1a\u5148\u5c55\u5f00\u7236\u8bbe\u5907\uff0c\u518d\u70b9\u51fb\u5176\u4e2d\u7684\u5b50\u76f8\u673a\uff09")'
new_arg = old_arg + '\n    parser.add_argument("--no-fullscreen", action="store_true", default=False, help="\u7981\u7528\u81ea\u52a8\u5168\u5c4f\uff08\u63a8\u6d41\u65f6\u4e0d\u70b9\u51fb\u5168\u5c4f\u6309\u94ae\uff09")'

if old_arg not in content:
    print('ERROR: parent-name arg not found')
    sys.exit(1)

content = content.replace(old_arg, new_arg)

# 2. Wrap enter_fullscreen call with --no-fullscreen check
old_call = '''            fullscreen_name = args.parent_name or args.airport_name
            enter_fullscreen(page, fullscreen_name)'''

new_call = '''            fullscreen_name = args.parent_name or args.airport_name
            if args.no_fullscreen:
                log.info("\u5df2\u7981\u7528\u81ea\u52a8\u5168\u5c4f (--no-fullscreen)")
            else:
                enter_fullscreen(page, fullscreen_name)'''

if old_call not in content:
    print('ERROR: enter_fullscreen call not found')
    sys.exit(1)

content = content.replace(old_call, new_call)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('OK: --no-fullscreen arg added')
