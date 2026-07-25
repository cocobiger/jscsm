#!/usr/bin/env python3
"""
修复 nginx 配置（移除嵌套的 location 块）
"""
import paramiko
import json

# 服务器信息
HOST = '111.10.220.226'
PORT = 22
USER = 'root'
PASS = 'Chyy#3068'

# Nginx 配置文件
NGINX_CONF = '/etc/nginx/sites-available/uav-sites'

# 修正后的 JSC 配置（无嵌套 location）
JSC_CONF_FIXED = '''
# ===== JSC 驾驶舱系统 =====
location /jsc/ {
    alias /opt/jsc/frontend/;
    try_files $uri $uri/ /jsc/index.html;
}

# JSC 静态资源缓存
location ~* ^/jsc/.*\.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
    alias /opt/jsc/frontend/;
    expires 7d;
    add_header Cache-Control "public, immutable";
}

# JSC 后端 API 代理
location /jsc/api/ {
    proxy_pass http://127.0.0.1:7170/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # WebSocket 支持
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
'''

def fix_nginx_config():
    """修复 nginx 配置"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        print(f"→ 连接到 {HOST}:{PORT}...")
        client.connect(HOST, port=PORT, username=USER, password=PASS, timeout=10)
        print("✓ SSH 连接成功\n")
        
        # 1. 备份当前配置（再次备份）
        print(f"{'='*60}")
        print("→ 备份当前 nginx 配置...")
        print(f"{'='*60}")
        
        stdin, stdout, stderr = client.exec_command(f'''
            cp {NGINX_CONF} {NGINX_CONF}.bak2.$(date +%Y%m%d_%H%M%S)
            echo "✓ 配置已备份"
        ''')
        
        output = stdout.read().decode('utf-8')
        if output:
            print(output)
        
        # 2. 移除旧的 JSC 配置（从 # ===== JSC 到文件末尾）
        print(f"\n{'='*60}")
        print("→ 移除旧的 JSC 配置...")
        print(f"{'='*60}")
        
        # 使用 Python 移除 JSC 配置块
        cmd = f'''python3 <<'EOF'
import re

with open('{NGINX_CONF}', 'r', encoding='utf-8') as f:
    content = f.read()

# 移除从 "# ===== JSC" 到文件末尾的内容
pattern = r'\n# ===== JSC.*$[\s\S]*'
content = re.sub(pattern, '', content)

with open('{NGINX_CONF}', 'w', encoding='utf-8') as f:
    f.write(content)

print("✓ 旧配置已移除")
EOF
'''
        
        stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
        
        output = stdout.read().decode('utf-8')
        error = stderr.read().decode('utf-8')
        
        if output:
            print(output)
        if error:
            print("错误:", error)
        
        # 3. 添加修正后的 JSC 配置
        print(f"\n{'='*60}")
        print("→ 添加修正后的 JSC 配置...")
        print(f"{'='*60}")
        
        # 使用 Python 追加配置
        cmd = f'''python3 <<'EOF'
config = """{JSC_CONF_FIXED}"""

with open('{NGINX_CONF}', 'a', encoding='utf-8') as f:
    f.write(config)

print("✓ 修正后的配置已添加")
EOF
'''
        
        stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
        
        output = stdout.read().decode('utf-8')
        error = stderr.read().decode('utf-8')
        
        if output:
            print(output)
        if error:
            print("错误:", error)
        
        # 4. 测试 nginx 配置
        print(f"\n{'='*60}")
        print("→ 测试 nginx 配置...")
        print(f"{'='*60}")
        
        stdin, stdout, stderr = client.exec_command('nginx -t', timeout=30)
        
        output = stdout.read().decode('utf-8')
        error = stderr.read().decode('utf-8')
        
        if output:
            print(output)
        if error:
            print(error)
        
        # 5. 重载 nginx
        print(f"\n{'='*60}")
        print("→ 重载 nginx...")
        print(f"{'='*60}")
        
        stdin, stdout, stderr = client.exec_command('systemctl reload nginx', timeout=30)
        
        output = stdout.read().decode('utf-8')
        error = stderr.read().decode('utf-8')
        
        if output:
            print(output)
        if error:
            print("错误:", error)
        
        print(f"\n{'='*60}")
        print("✓ nginx 配置修复完成")
        print(f"{'='*60}")
        
        # 6. 验证配置
        print("\n→ 验证 nginx 配置...")
        
        stdin, stdout, stderr = client.exec_command(f'''
            echo "=== Nginx 配置内容（最后 40 行）==="
            tail -40 {NGINX_CONF}
            echo ""
            echo "=== Nginx 状态 ==="
            systemctl status nginx --no-pager | head -5
        ''')
        
        print(stdout.read().decode('utf-8'))
        
    except Exception as e:
        print(f"\n❌ 错误: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        client.close()
        print("\n→ SSH 连接已关闭")

if __name__ == '__main__':
    fix_nginx_config()
