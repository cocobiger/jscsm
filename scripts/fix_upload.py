#!/usr/bin/env python3
"""
修复后端文件上传（创建目录并上传）
"""
import paramiko
import os

# 服务器信息
HOST = '111.10.220.226'
PORT = 22
USER = 'root'
PASS = 'Chyy#3068'

# 本地路径
LOCAL_SERVER_SRC = 'E:/CC work/CC jsc/server'

# 服务器路径
REMOTE_FRONTEND = '/opt/jsc/frontend'
REMOTE_BACKEND = '/opt/jsc/backend'
REMOTE_DATA = '/data/jsc'

def main():
    """主函数"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        print(f"→ 连接到 {HOST}:{PORT}...")
        client.connect(HOST, port=PORT, username=USER, password=PASS, timeout=10)
        print("✓ SSH 连接成功\n")
        
        # 1. 创建后端目录
        print(f"{'='*60}")
        print("→ 创建后端目录...")
        print(f"{'='*60}")
        stdin, stdout, stderr = client.exec_command(f'''
            mkdir -p {REMOTE_BACKEND}
            chown jsc:jsc {REMOTE_BACKEND}
            ls -ld {REMOTE_BACKEND}
        ''')
        print(stdout.read().decode('utf-8'))
        
        # 2. 上传后端文件
        print(f"\n{'='*60}")
        print("→ 上传后端文件...")
        print(f"{'='*60}")
        
        sftp = client.open_sftp()
        
        # 上传 .js 文件
        print("\n→ 上传 .js 文件...")
        for file in os.listdir(LOCAL_SERVER_SRC):
            if file.endswith('.js') or file == 'package.json':
                local_file = os.path.join(LOCAL_SERVER_SRC, file)
                remote_file = f"{REMOTE_BACKEND}/{file}"
                try:
                    sftp.put(local_file, remote_file)
                    print(f"  ✓ {file}")
                except Exception as e:
                    print(f"  ✗ {file} - {e}")
        
        # 3. 安装后端依赖
        print(f"\n{'='*60}")
        print("→ 安装后端依赖...")
        print(f"{'='*60}")
        
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
        
        # 4. 验证
        print(f"\n{'='*60}")
        print("→ 验证上传结果...")
        print(f"{'='*60}")
        
        stdin, stdout, stderr = client.exec_command(f'''
            echo "=== 前端文件 ==="
            ls -lh {REMOTE_FRONTEND}/
            echo ""
            echo "=== 后端代码 ==="
            ls -lh {REMOTE_BACKEND}/*.js 2>/dev/null
            echo ""
            echo "=== node_modules ==="
            ls -lh {REMOTE_BACKEND}/node_modules/ 2>/dev/null | head -5
            echo ""
            echo "=== 数据文件 ==="
            ls -lh {REMOTE_DATA}/
        ''')
        
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
