#!/usr/bin/env python3
"""
更新服务器上的 config.json（将 zlmHost 从本地 IP 改为 127.0.0.1）
"""
import paramiko
import json

# 服务器信息
HOST = '111.10.220.226'
PORT = 22
USER = 'root'
PASS = 'Chyy#3068'

# 配置文件路径
CONFIG_FILE = '/data/jsc/config.json'

def update_config():
    """更新配置文件"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        print(f"→ 连接到 {HOST}:{PORT}...")
        client.connect(HOST, port=PORT, username=USER, password=PASS, timeout=10)
        print("✓ SSH 连接成功\n")
        
        # 读取当前配置
        print(f"{'='*60}")
        print(f"→ 读取当前配置: {CONFIG_FILE}")
        print(f"{'='*60}")
        
        stdin, stdout, stderr = client.exec_command(f'cat {CONFIG_FILE}')
        config_str = stdout.read().decode('utf-8')
        config = json.loads(config_str)
        
        print(f"\n当前配置:")
        print(json.dumps(config, indent=2, ensure_ascii=False))
        
        # 更新配置
        print(f"\n{'='*60}")
        print("→ 更新配置...")
        print(f"{'='*60}")
        
        if 'zlm' in config:
            old_host = config['zlm']['zlmHost']
            config['zlm']['zlmHost'] = '127.0.0.1'
            print(f"  zlmHost: {old_host} → 127.0.0.1")
        
        # 写回配置文件
        new_config_str = json.dumps(config, indent=2, ensure_ascii=False)
        
        # 使用 Python 写入文件
        cmd = f'''python3 <<'EOF'
import json

config = {new_config_str}

with open('{CONFIG_FILE}', 'w') as f:
    json.dump(config, f, indent=2, ensure_ascii=False)

print("✓ 配置文件已更新")
EOF
'''
        
        stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
        output = stdout.read().decode('utf-8')
        error = stderr.read().decode('utf-8')
        
        if output:
            print(output)
        if error:
            print("错误:", error)
        
        # 验证更新
        print(f"\n{'='*60}")
        print("→ 验证更新结果...")
        print(f"{'='*60}")
        
        stdin, stdout, stderr = client.exec_command(f'cat {CONFIG_FILE}')
        updated_config = json.loads(stdout.read().decode('utf-8'))
        
        print(json.dumps(updated_config, indent=2, ensure_ascii=False))
        
        print(f"\n{'='*60}")
        print("✓ 配置更新完成")
        print(f"{'='*60}")
        
    except Exception as e:
        print(f"\n❌ 错误: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        client.close()
        print("\n→ SSH 连接已关闭")

if __name__ == '__main__':
    update_config()
