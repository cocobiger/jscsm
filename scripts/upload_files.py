#!/usr/bin/env python3
"""
通过 SFTP 上传 JSC 系统文件到 Ubuntu 服务器
"""
import paramiko
import os
import sys

# 服务器信息
HOST = '111.10.220.226'
PORT = 22
USER = 'root'
PASS = 'Chyy#3068'

# 本地路径
LOCAL_DIST = 'E:/CC work/CC jsc/dist'
LOCAL_SERVER = 'E:/CC work/CC jsc/server'
LOCAL_SERVER_SRC = 'E:/CC work/CC jsc/server'

# 服务器路径
REMOTE_FRONTEND = '/opt/jsc/frontend'
REMOTE_BACKEND = '/opt/jsc/backend'
REMOTE_DATA = '/data/jsc'

def upload_directory(sftp, local_path, remote_path, exclude_dirs=['node_modules', '.git', 'logs', '__pycache__']):
    """递归上传目录"""
    # 创建远程目录
    try:
        sftp.stat(remote_path)
    except FileNotFoundError:
        sftp.mkdir(remote_path)
        print(f"  创建目录: {remote_path}")
    
    # 遍历本地目录
    for item in os.listdir(local_path):
        local_item = os.path.join(local_path, item)
        remote_item = f"{remote_path}/{item}"
        
        # 排除目录
        if os.path.isdir(local_item):
            if item in exclude_dirs:
                print(f"  跳过目录: {item}")
                continue
            print(f"  上传目录: {item}")
            upload_directory(sftp, local_item, remote_item, exclude_dirs)
        else:
            # 上传文件
            try:
                sftp.put(local_item, remote_item)
                print(f"    ✓ {item}")
            except Exception as e:
                print(f"    ✗ {item} - {e}")

def main():
    """主函数"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        print(f"→ 连接到 {HOST}:{PORT}...")
        client.connect(HOST, port=PORT, username=USER, password=PASS, timeout=10)
        print("✓ SSH 连接成功\n")
        
        # 创建 SFTP 连接
        sftp = client.open_sftp()
        print(f"{'='*60}")
        print("→ 上传前端文件...")
        print(f"{'='*60}")
        
        # 1. 上传前端文件 (dist/*)
        print("\n1. 上传前端文件 (dist/*)...")
        upload_directory(sftp, LOCAL_DIST, REMOTE_FRONTEND)
        
        print(f"\n{'='*60}")
        print("→ 上传后端代码...")
        print(f"{'='*60}")
        
        # 2. 上传后端代码 (server/*.js, server/package.json)
        print("\n2. 上传后端代码...")
        # 上传 .js 文件
        for file in os.listdir(LOCAL_SERVER_SRC):
            if file.endswith('.js') or file == 'package.json':
                local_file = os.path.join(LOCAL_SERVER_SRC, file)
                remote_file = f"{REMOTE_BACKEND}/{file}"
                try:
                    sftp.put(local_file, remote_file)
                    print(f"    ✓ {file}")
                except Exception as e:
                    print(f"    ✗ {file} - {e}")
        
        # 上传 data 目录
        print("\n3. 上传数据文件 (server/data/*)...")
        local_data = os.path.join(LOCAL_SERVER_SRC, 'data')
        if os.path.exists(local_data):
            upload_directory(sftp, local_data, REMOTE_DATA)
        
        print(f"\n{'='*60}")
        print("✓ 文件上传完成")
        print(f"{'='*60}")
        
        # 3. 在服务器上安装后端依赖
        print("\n→ 安装后端依赖...")
        stdin, stdout, stderr = client.exec_command(f'''
            su - jsc <<'EOF'
            export NVM_DIR="$HOME/.nvm"
            [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
            cd {REMOTE_BACKEND}
            pnpm install --production
EOF
        ''', timeout=300)
        
        output = stdout.read().decode('utf-8')
        error = stderr.read().decode('utf-8')
        if output:
            print(output)
        if error:
            print("错误:", error)
        
        print("\n→ 验证上传结果...")
        stdin, stdout, stderr = client.exec_command(f'''
            echo "=== 前端文件 ==="
            ls -lh {REMOTE_FRONTEND}/
            echo ""
            echo "=== 后端代码 ==="
            ls -lh {REMOTE_BACKEND}/*.js 2>/dev/null | head -10
            echo ""
            echo "=== 数据文件 ==="
            ls -lh {REMOTE_DATA}/
        ''', timeout=30)
        
        print(stdout.read().decode('utf-8'))
        
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
    main()
