import os

d = r'E:\CC work\CC jsc\.workbuddy\memory'
os.makedirs(d, exist_ok=True)
f = os.path.join(d, '2026-06-17.md')

lines = [
    '\n## SSH 连接 Ubuntu 服务器方法\n',
    '- **地址**: `111.10.220.226`\n',
    '- **用户**: `root`\n',
    '- **认证**: SSH 私钥 `~/.ssh/id_ed25519`\n',
    '- **连接命令**:\n',
    '  ```bash\n',
    '  ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no root@111.10.220.226\n',
    '  ```\n',
    '- **上传文件**:\n',
    '  ```bash\n',
    '  scp -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no <本地文件> root@111.10.220.226:<远程路径>\n',
    '  ```\n',
    '- **服务**: `jsc-backend` (后端), 前端目录 `/opt/jsc/frontend/`\n',
    '- **数据库**: `/opt/jsc/backend/data/jsc.db`\n',
    '- **重启后端**: `systemctl restart jsc-backend`\n',
    '- **Python3 路径**: 服务器上直接用 `python3` 命令\n',
]

with open(f, 'a', encoding='utf-8') as fh:
    fh.writelines(lines)

print('saved')
