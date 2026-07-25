#!/usr/bin/env python3
"""
修复 nginx 配置（完全重写 uav-sites 文件，保留原有配置 + 添加正确的 JSC 配置）
"""
import paramiko
import json
import os
import tempfile

# 服务器信息
HOST = '111.10.220.226'
PORT = 22
USER = 'root'
PASS = 'Chyy#3068'

# Nginx 配置文件
NGINX_CONF = '/etc/nginx/sites-available/uav-sites'

# 正确的 JSC 配置（无嵌套 location）
JSC_CONF = '''
# ===== JSC 驾驶舱系统 =====
location /jsc/ {
    alias /opt/jsc/frontend/;
    try_files $uri $uri/ /jsc/index.html;
}

# JSC 静态资源缓存
location ~* ^/jsc/.*\\.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
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

def fix_nginx():
    """修复 nginx 配置"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        print(f"→ 连接到 {HOST}:{PORT}...")
        client.connect(HOST, port=PORT, username=USER, password=PASS, timeout=10)
        print("✓ SSH 连接成功\n")
        
        # 创建 SFTP 连接
        sftp = client.open_sftp()
        
        # 1. 下载当前配置
        print(f"{'='*60}")
        print("→ 下载当前 nginx 配置...")
        print(f"{'='*60}")
        
        temp_file = tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.conf')
        temp_path = temp_file.name
        temp_file.close()
        
        sftp.get(NGINX_CONF, temp_path)
        print(f"  ✓ 已下载到: {temp_path}")
        
        # 2. 读取并修复配置
        print(f"\n{'='*60}")
        print("→ 修复配置...")
        print(f"{'='*60}")
        
        with open(temp_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # 移除所有 JSC 配置块（从 "# ===== JSC" 到下一个 "# =====" 或文件末尾）
        import re
        
        # 移除旧的 JSC 配置
        pattern = r'\n# ===== JSC.*?(\n# =====|$)[\s\S]*'
        new_content = re.sub(pattern, r'\1', content, flags=re.DOTALL)
        
        # 如果文件末尾还有 JSC 配置，也移除
        pattern2 = r'\n# ===== JSC.*$[\s\S]*'
        new_content = re.sub(pattern2, '', new_content, flags=re.DOTALL)
        
        # 添加修正后的 JSC 配置
        new_content = new_content.rstrip() + '\n' + JSC_CONF
        
        # 写回临时文件
        with open(temp_path, 'w', encoding='utf-8') as f:
            f.write(new_content)
        
        print("  ✓ 配置已修复")
        
        # 3. 上传回服务器
        print(f"\n{'='*60}")
        print("→ 上传修复后的配置...")
        print(f"{'='*60}")
        
        # 先备份
        stdin, stdout, stderr = client.exec_command(f'''
            cp {NGINX_CONF} {NGINX_CONF}.bak3.$(date +%Y%m%d_%H%M%S)
            echo "✓ 配置已备份"
        ''')
        print(stdout.read().decode('utf-8'))
        
        # 上传
        sftp.put(temp_path, NGINX_CONF)
        print(f"  ✓ 已上传到: {NGINX_CONF}")
        
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
        
        # 清理临时文件
        os.unlink(temp_path)
        
        sftp.close()
        
    except Exception as e:
        print(f"\n❌ 错误: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        client.close()
        print("\n→ SSH 连接已关闭")

if __name__ == '__main__':
    fix_nginx()
