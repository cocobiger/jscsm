# REF · 沙箱 / 工具链 / 部署坑（本工作空间通用）

> **何时读**：在本工作空间跑脚本、ssh 出去、做前端验收、或在服务器上装/改东西**之前**读一遍。
> 这些坑都踩过，且**多数是"静默失败"**（报错信息会指向错误的方向），不知道就会浪费大量时间。
> MEMORY.md 只保留最危险的 3 条 + 指针，其余在这里。

---

## 一、ssh / 密码 / 脚本传输

1. **🔴 本机 Git Bash 下 `sshpass` 不可用** —— 拿不到 pty → 密码发不出去 → 服务器一直回
   `Permission denied (publickey,password)`，**极像密码错了**（真实踩过，会让人反复核对密码）。
   **正解 = SSH_ASKPASS**：
   ```bash
   cat > /c/Users/<U>/AppData/Local/Temp/askpass.sh <<'EOF'
   #!/bin/sh
   printf 'PASSWORD'
   EOF
   chmod +x .../askpass.sh
   export SSH_ASKPASS=.../askpass.sh SSH_ASKPASS_REQUIRE=force DISPLAY=:0
   ssh -p <PORT> -o BatchMode=no -o PubkeyAuthentication=no -o PreferredAuthentications=password \
       -o NumberOfPasswordPrompts=1 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@<HOST> "cmd"
   ```
   `scp` 用同一组环境变量（`scp -P <PORT>`）。

2. **ssh 双引号里写 `$(...)` / 反引号会被【本地】提前展开** —— 曾导致远端只收到 `-u "root:"` 而认证 401，排查很久。
   ⇒ 复杂逻辑一律「本地写脚本 → scp → 执行」。

3. **🔴 Write 工具落盘是 CRLF → `ssh "bash -s" <脚本` 里的内层 heredoc 静默失效**：
   结束标记 `PY\r ≠ PY` ⇒ bash 从未闭合的 heredoc 一路吞到文件尾，
   **报错形如** `bash: line 48: V/python - <<'PY' … No such file`（连 `$` 都丢了，极具迷惑性）。
   ⇒ **正解：`tr -d '\r' < x.sh > x_lf.sh` 剥 CR，scp 成文件后 `bash /tmp/x_lf.sh` 执行（不靠 stdin）。**

4. **`ssh "pkill -f '<含脚本名模式>'"` 会杀掉 ssh 自身**（`-f` 匹配到自己的命令行）→
   **exit 255 且输出全空**（极易误判成"脚本没跑"）。改用 `pgrep -f '^node x.mjs'` 逐个 kill。
   ⚠️ 同理：本机沙箱里的 `spawn` 一律 EBUSY（见 §三），所以 kill 也要走 ssh 到服务器执行。

5. 后台常驻：`setsid nohup <cmd> < /dev/null &`（否则 ssh 断开即被 SIGHUP 带走）。

6. **长任务放后台**：前台跑安装/编译容易在超时被杀，**且 ssh 输出会整段丢失**（表现"空输出 + SIGTERM"）。
   ⇒ 遇到这种情况**先查现场状态**（`ls` / `systemctl is-active` / `journalctl` / `find`），再决定是否重跑 —— 别直接当失败重来。

---

## 二、Windows 侧文本与 shell

7. **🔴 Windows 写盘是 CRLF** —— 用正则在文件里提取"行内大 JSON"时，必须写 `;\r?\n`
   （只写 `\n` 会匹配 0 处）。**已踩两次**。

8. **🔴 别用 `bash -c "python -c \"…含反引号…\""` 写文件** —— 反引号会被 shell 当**命令替换**执行掉
   （`\`` 的转义在本工具链路里会丢一层）→ 内容被**静默删掉一段**（`**`.ps1` 必须…` 变成 `** 必须…`，
   stderr 只留几行 `command not found`）。⇒ **含反引号的文本一律用 Write/Edit 工具，不要过 shell。**

9. **本机 Git Bash 无 coreutils/部分命令** ⇒ 用 `node -e` 兜底；`.mjs` 不能 `require`（用 `.cjs`）。

---

## 三、本机沙箱（与服务器不同！）

10. **🔴 node 的 `spawn` 一律 EBUSY** —— 连 `execFileSync('python',['-V'])` 都起不来
    （但 ssh 出去的服务器上完全正常）。
    ⇒ 关键路径改**进程内**：`new Function(js)` 代替 `node --check`；Python 用 `runpy.run_path` 代替 subprocess；
    跨语言靠**写文件传递**。

11. **`npm run verify` 在本沙箱会炸**（走 WSL bash）⇒ 拆开跑：
    `node node_modules/typescript/bin/tsc --noEmit` + `node node_modules/vite/bin/vite.js build`。

12. **🔴 Edge headless 必须加 `--no-proxy-server --proxy-bypass-list=*`** —— 否则走企业代理 →
    `ERR_PROXY_CONNECTION_FAILED`；而 `curl` 不走代理"看着可达" ⇒ **极易误判成"页面坏了"**。
    另外本机 `curl https://<某些域名>` 也可能报 SSL 错（企业代理）；**能换到服务器上跑就换**。

13. `scp -r dist/assets/.` 常报错 ⇒ 改用 `dist/assets/*`。

---

## 四、服务器侧（部署 / 打包 / 解包）

14. **`--strip-components=N` 只对"带目录前缀"的 tar 有效** —— 若打包时是
    `cd server && tar czf x.tgz *.js`（条目无 `server/` 前缀），解包时 `--strip-components=1`
    会把**文件名本身剥掉** ⇒ **一个文件都没落地，且 tar 退出码为 0**（`set -e` 拦不住）。
    ⇒ 在仓库根打包（`tar czf x.tgz server/*.js`），**打包后必须 `tar -tzf` 回看结构**，解包后**数文件**。

15. **`cp … || true` 会吞掉关键失败** —— 曾把 CMake 产物从 `Release/` 拷（我写了 `Debug/`），
    `|| true` 让脚本"成功"跑完，但 `ExecStart` 指向的可执行文件不存在 → systemd `status=203/EXEC`。
    ⇒ **关键拷贝不要 `|| true`，拷完必须 `[ -x "$BIN" ] || exit 1`**。

16. **apt 里的版本常常太老** —— Ubuntu 22.04 的 `nodejs` 只有 12.22.9，而后端用 `require('node:sqlite')`
    （Node 22.5+ 才有）。⇒ 用官方 tarball 装到数据盘，只把 bin 软链进 `/usr/local/bin`。
    **装完立刻验证关键特性**（`node -e "require('node:sqlite')"`、`nginx -t`），别等启动失败才回头查。

17. **`python3 -m venv` 需要 `python3-venv` 包** —— 否则报 `Failing command: …/venv/bin/python3`。
    `apt-get install -y python3-venv python3-dev` 后重建。

18. **npm 在 pnpm 结构的 `node_modules`（存在 `.pnpm/`）上会崩**：
    `Cannot read properties of null (reading 'matches')`。
    ⇒ 补单个包用「临时目录 `npm init -y && npm i <pkg>` 再 `cp -r node_modules/<pkg>`」绕开。

19. **`find` 不跟 symlink** —— 目录是软链时 `find <软链>` 返回 0 条（**不是没落盘**）；要查**实体路径**。
    同理 `du -sh <软链>` 显示 0 也不是故障。

20. **systemd + `python -m uvicorn main:app` 只 import 模块** ⇒ `if __name__ == '__main__'` 块**不执行**。
    症状：服务 active、端口在听，但**一个 worker 都没有**。
    ⇒ 后台线程 / worker / 定时轮询必须挂 **ASGI lifespan**（`app.router.lifespan_context = lifespan`）。

21. **⚠️ 公网 IP 上看到的是「端口映射表」不是「主机监听列表」** —— 一个公网 IP 后面是网关 + 多台内网机；
    某端口关闭只能说"映射被删/后端没起"，**不能推"那台机器没了"**（反之亦然）。
    排障方法见 skill `backend-service-recon` 的「反向场景」节（含 TLS 证书 CN 认机器、banner 抓取）。

---

## 五、前端验收（headless 探针）

22. `toast` 停留 ≤3s ⇒ 必须 **poll 满整个周期**，不能只探一次。
23. 按钮文案会演化 ⇒ 匹配用 `includes` / `startsWith`，不要全等。
24. 中文菜单名必须走 **UTF-8 JSON 文件**传参（命令行传中文易乱码）。
25. `scripts/ui-probe.mjs` 支持 `--config` 的 `{eval}` 注入代码。
26. **降级路径零风险验证**：在页面内拦 `window.fetch`（**只拦目标接口**）+ 偏移 `Date.now` 使宽限期过期
    ⇒ 可观察降级态，**完全不动生产**。

27. **`ls -A dir1/ dir2/`（多个目录）即使全空也会打印「目录标题行」** ⇒ 用 `| grep -q .` 判"非空"会**假阳性**。
    （踩过：把"模型缺失"误报成"模型存在"。）
    ⇒ 判空用单目录 `ls -A d | head`，或直接 `find d -type f`，或 `find -L d -name '*.onnx'` 精确找。
    同理：比较两侧文件时**必须两侧同样归一化**（都要 `tr -d '\r'`），否则 CRLF 差异会被误判成内容不同。

28. **🔴 长命令（>1 分钟）不要挂在 SSH 会话里跑** —— 本机 SSH 会**中途断掉**，
    表现为工具返回 **SIGTERM + 完全空输出**（极易误判成"命令失败/没执行"），
    而**远端进程其实还活着**（踩过：以为 `pip install` 失败，重跑一次差点把 venv 搞乱）。
    ⇒ 长任务一律 **脱离会话**：
    ```bash
    setsid nohup bash /tmp/x.sh < /dev/null > /dev/null 2>&1 &
    # 脚本内部自己 `exec > /tmp/x.log 2>&1`
    ```
    再用**短命令（<30s）**读日志轮询（`cat /tmp/x.log | tail -30`）。
    ⚠️ 另外：**任何会停服务的操作，都别把 `systemctl stop` 和长任务放在同一个会被中断的会话里** ——
    本次差点把 straw-engine 停着不管 6 分钟。

29. **`python`/`pip` 的「可用列表」≠「实际生效」** —— 例如 `onnxruntime.get_available_providers()`
    会列出 `CUDAExecutionProvider`，但真正创建 session 时因缺 so **静默回退 CPU**。
    ⇒ 判断"某能力是否生效"要**看运行时的实际选择**（`sess.get_providers()`），不要看静态清单。
