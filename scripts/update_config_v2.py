#!/usr/bin/env python3
"""
通过 SFTP 下载、更新、上传 config.json
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

# 配置文件路径
REMOTE_CONFIG = '/data/jsc/config.json'

def update_config():
    """更新配置文件"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        print(f"→ 连接到 {HOST}:{PORT}...")
        client.connect(HOST, port=PORT, username=USER, password=PASS, timeout=10)
        print("✓ SSH 连接成功\n")
        
        # 创建 SFTP 连接
        sftp = client.open_sftp()
        
        # 1. 下载配置文件到临时文件
        print(f"{'='*60}")
        print(f"→ 下载配置文件...")
        print(f"{'='*60}")
        
        temp_file = tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.json')
        temp_path = temp_file.name
        temp_file.close()
        
        sftp.get(REMOTE_CONFIG, temp_path)
        print(f"  ✓ 已下载到: {temp_path}")
        
        # 2. 读取并更新配置
        print(f"\n{'='*60}")
        print(f"→ 更新配置...")
        print(f"{'='*60}")
        
        with open(temp_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
        
        # 更新 zlmHost
        if 'zlm' in config:
            old_host = config['zlm']['zlmHost']
            config['zlm']['zlmHost'] = '127.0.0.1'
            print(f"  zlmHost: {old_host} → 127.0.0.1")
        
        # 写回临时文件
        with open(temp_path, 'w', encoding='utf-8') as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        
        print(f"  ✓ 配置已更新")
        
        # 3. 上传回服务器
        print(f"\n{'='*60}")
        print(f"→ 上传配置文件...")
        print(f"{'='*60}")
        
        sftp.put(temp_path, REMOTE_CONFIG)
        print(f"  ✓ 已上传到: {REMOTE_CONFIG}")
        
        # 4. 验证更新
        print(f"\n{'='*60}")
        print(f"→ 验证更新结果...")
        print(f"{'='*60}")
        
        # 重新下载并验证
        temp_file2 = tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.json')
        temp_path2 = temp_file2.name
        temp_file2.close()
        
        sftp.get(REMOTE_CONFIG, temp_path2)
        
        with open(temp_path2, 'r', encoding='utf-8') as f:
            updated_config = json.load(f)
        
        print(json.dumps(updated_config, indent=2, ensure_ascii=False))
        
        # 清理临时文件
        os.unlink(temp_path)
        os.unlink(temp_path2)
        
        sftp.close()
        
        print(f"\n{'='*60}")
        print(f"✓ 配置更新完成")
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
