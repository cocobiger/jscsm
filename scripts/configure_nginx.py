#!/usr/bin/env python3
"""
配置 nginx 反向代理（为 JSC 系统添加 /jsc/ 路由）
"""
import paramiko

# 服务器信息
HOST = '111.10.220.226'
PORT = 22
USER = 'root'
PASS = 'Chyy#3068'

# Nginx 配置文件
NGINX_CONF = '/etc/nginx/sites-available/uav-sites'

# JSC 系统 nginx 配置
JSC_CONF = '''
# ===== JSC 驾驶舱系统 =====
location /jsc/ {
    alias /opt/jsc/frontend/;
    try_files $uri $uri/ /jsc/index.html;
    
    # 缓存策略
    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
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

def configure_nginx():
    """配置 nginx"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        print(f"→ 连接到 {HOST}:{PORT}...")
        client.connect(HOST, port=PORT, username=USER, password=PASS, timeout=10)
        print("✓ SSH 连接成功\n")
        
        # 1. 备份当前配置
        print(f"{'='*60}")
        print("→ 备份当前 nginx 配置...")
        print(f"{'='*60}")
        
        stdin, stdout, stderr = client.exec_command(f'''
            cp {NGINX_CONF} {NGINX_CONF}.bak.$(date +%Y%m%d_%H%M%S)
            echo "✓ 配置已备份到: {NGINX_CONF}.bak.*"
        ''')
        
        output = stdout.read().decode('utf-8')
        if output:
            print(output)
        
        # 2. 添加 JSC 配置
        print(f"\n{'='*60}")
        print("→ 添加 JSC 系统 nginx 配置...")
        print(f"{'='*60}")
        
        # 使用 Python 追加配置（避免 shell 转义问题）
        cmd = f'''python3 <<'EOF'
config = """{JSC_CONF}"""

with open('{NGINX_CONF}', 'a', encoding='utf-8') as f:
    f.write(config)

print("✓ JSC 配置已添加到: {NGINX_CONF}")
EOF
'''
        
        stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
        
        output = stdout.read().decode('utf-8')
        error = stderr.read().decode('utf-8')
        
        if output:
            print(output)
        if error:
            print("错误:", error)
        
        # 3. 测试 nginx 配置
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
        
        # 4. 重载 nginx
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
        print("✓ nginx 配置完成")
        print(f"{'='*60}")
        
        # 5. 验证配置
        print("\n→ 验证 nginx 配置...")
        
        stdin, stdout, stderr = client.exec_command(f'''
            echo "=== Nginx 配置内容（最后 30 行）==="
            tail -30 {NGINX_CONF}
            echo ""
            echo "=== Nginx 状态 ==="
            systemctl status nginx --no-pager | head -10
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
    configure_nginx()
