#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SSH connect helper to remote Ubuntu server for analysis."""
import paramiko
import sys

HOST = "111.10.220.226"
PORT = 22
USER = "root"
PASS = "Chyy#3068"

def run(ssh, cmd, timeout=30):
    """Execute a command on the remote host and return (stdout, stderr, exit_code)."""
    try:
        stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode('utf-8', errors='replace')
        err = stderr.read().decode('utf-8', errors='replace')
        code = stdout.channel.recv_exit_status()
        return out, err, code
    except Exception as e:
        return "", f"ERROR: {e}", -1

def main():
    if len(sys.argv) < 2:
        print("Usage: ssh_run.py <command>")
        sys.exit(1)
    cmd = sys.argv[1]
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(HOST, PORT, USER, PASS, timeout=15, allow_agent=False, look_for_keys=False)
    except Exception as e:
        print(f"CONNECT_FAILED: {e}")
        sys.exit(2)
    out, err, code = run(ssh, cmd)
    if out:
        print(out, end='')
    if err:
        print(err, end='', file=sys.stderr)
    sys.exit(code)

if __name__ == "__main__":
    main()
