#!/usr/bin/env python3
"""
大疆司空 WebRTC 浏览器适配器
通过 Playwright + Xvfb + ffmpeg 把大疆司空 share/live 页面的单路机场视频
转推为 RTMP 流到 ZLMediaKit，供本系统播放。

用法：
  python dji_bridge.py \
    --share-url "https://fh.dji.com/share/live/XXXX" \
    --airport-name "机场 1" \
    --stream-id "dji_airport_1" \
    --width 960 --height 540 --bitrate 1500
"""

import argparse
import fcntl
import json
import logging
import os
import signal
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Optional

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("dji-bridge")

# 全局标记，收到终止信号时退出主循环
_should_exit = False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DJI FlightHub WebRTC to RTMP bridge")
    parser.add_argument("--share-url", required=True, help="大疆司空分享页 URL")
    parser.add_argument("--airport-name", default="", help="左侧边栏机场按钮文本")
    parser.add_argument("--airport-index", type=int, default=None, help="左侧边栏机场按钮索引（0 开始）")
    parser.add_argument("--stream-id", required=True, help="推流到 ZLMediaKit 的流 ID")
    parser.add_argument("--width", type=int, default=1280, help="视频输出宽度（浏览器内容区域宽度）")
    parser.add_argument("--height", type=int, default=720, help="视频输出高度（浏览器内容区域高度）")
    parser.add_argument("--capture-offset-y", type=int, default=80, help="浏览器标题栏/地址栏占用的高度，ffmpeg 从该 y 偏移开始抓取")
    parser.add_argument("--bitrate", type=int, default=2000, help="推流码率 kbps")
    parser.add_argument("--framerate", type=int, default=20, help="抓屏帧率")
    parser.add_argument("--zlm-host", default="172.17.0.2", help="ZLMediaKit 容器 IP")
    parser.add_argument("--zlm-port", type=int, default=1935, help="ZLMediaKit RTMP 端口")
    parser.add_argument("--zlm-app", default="jsc", help="ZLMediaKit app 名")
    parser.add_argument("--display", default=None, help="已有 Xvfb display，如 :99")
    parser.add_argument("--timeout", type=int, default=60, help="等待机场按钮出现超时秒数")
    parser.add_argument("--keep-alive", type=int, default=1, help="是否持续保持浏览器运行（0/1）")
    parser.add_argument("--pidfile", default=None, help="启动成功后写入进程信息的 JSON 文件路径")
    parser.add_argument("--parent-name", default=None, help="父设备名称（用于嵌套子相机：先展开父设备，再点击其中的子相机）")
    parser.add_argument("--no-fullscreen", action="store_true", default=False, help="禁用自动全屏（推流时不点击全屏按钮）")
    return parser.parse_args()


def ensure_display(width: int, height: int, display: Optional[str]) -> tuple[subprocess.Popen, str]:
    """如果没有可用的 DISPLAY，启动一个 Xvfb。使用文件锁避免多路并发时争夺同一 display。"""
    if display:
        os.environ["DISPLAY"] = display
        return None, display

    existing = os.environ.get("DISPLAY")
    if existing:
        try:
            # 简单验证 display 是否可用
            subprocess.run(["xdpyinfo"], env={"DISPLAY": existing}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, check=True)
            return None, existing
        except Exception:
            log.warning(f"DISPLAY={existing} 不可用，将启动新的 Xvfb")

    # 文件锁序列化 display 分配，避免多个 dji-bridge 同时启动时抢到同一 display
    lock_path = Path(__file__).resolve().parent / ".display.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        # 找一个空闲 display
        for d in range(99, 199):
            display = f":{d}"
            lock = Path(f"/tmp/.X{d}-lock")
            if lock.exists():
                continue
            proc = subprocess.Popen(
                ["Xvfb", display, "-screen", "0", f"{width}x{height}x24", "-ac", "+extension", "GLX", "+render", "-noreset"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,  # 独立进程组，便于整体清理
            )
            # 等待 Xvfb 就绪
            for _ in range(30):
                time.sleep(0.2)
                try:
                    subprocess.run(["xdpyinfo"], env={"DISPLAY": display}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, check=True)
                    os.environ["DISPLAY"] = display
                    log.info(f"Xvfb 已启动 {display}")
                    return proc, display
                except Exception:
                    if proc.poll() is not None:
                        break
            # 启动失败，清理并尝试下一个
            log.warning(f"Xvfb {display} 启动失败或不可用，尝试下一个")
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:
                proc.kill()

    raise RuntimeError("无法启动 Xvfb")


def _kill_stale_stream(stream_id: str):
    """
    启动前清理任何仍占用该 RTMP 地址（jsc/{stream_id}）的残留 ffmpeg 进程。

    原因：ffmpeg 是 node 的孙子进程，若 Python 被 SIGKILL（如后端重启超时强杀），
    cleanup 不会执行，ffmpeg 会成孤儿一直占用 RTMP 地址，导致后续重连 "Already publishing"。
    本函数在启动新推流前主动清理，避免冲突。
    """
    try:
        pattern = "jsc/%s" % stream_id
        result = subprocess.run(
            ["pkill", "-f", pattern],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        if result.returncode == 0:
            log.info("已清理残留推流进程: %s" % pattern)
            time.sleep(1.5)  # 等 ZLMediaKit 释放
        else:
            log.info("无残留推流进程: %s" % pattern)
    except Exception as e:
        log.warning("清理残留推流进程失败: %s" % e)


def start_ffmpeg(display: str, width: int, height: int, offset_y: int, framerate: int, bitrate: int, rtmp_url: str) -> subprocess.Popen:
    # Xvfb 总高度 = height + offset_y（给浏览器标题栏/地址栏留空间）
    xvfb_height = height + offset_y
    cmd = [
        "ffmpeg", "-y",
        "-f", "x11grab",
        "-framerate", str(framerate),
        "-video_size", f"{width}x{height}",
        "-draw_mouse", "0",
        "-i", f"{display}.0+0,{offset_y}",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-b:v", f"{bitrate}k",
        "-maxrate", f"{bitrate}k",
        "-bufsize", f"{bitrate * 2}k",
        "-g", str(framerate * 2),
        "-keyint_min", str(framerate),
        "-pix_fmt", "yuv420p",
        "-f", "flv",
        rtmp_url,
    ]
    log.info(f"启动 ffmpeg: {' '.join(cmd)}")
    return subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,  # 独立进程组，便于整体清理
    )


def write_pidfile(pidfile_path: str, info: dict):
    """把 python/ffmpeg/xvfb 的 pid 写入 JSON 文件，供 node 管理端清理。"""
    if not pidfile_path:
        return
    try:
        Path(pidfile_path).write_text(json.dumps(info, ensure_ascii=False))
    except Exception as e:
        log.warning(f"写入 pidfile 失败: {e}")


def _click_nested_sub_camera(page, parent_name: str, sub_camera_name: str, timeout_sec: int):
    """嵌套/平铺混合模式子相机选择。

    大疆司空 FlightHub 的设备列表有两种常见形态：
    1. 嵌套模式：父设备卡片（如 "M4TD | 4TD-三峡科技大学"）可展开，
       内部包含子相机（如 "辅助影像"、"Matrice 4TD"），必须点击子相机才播放无人机画面。
    2. 平铺模式：父设备卡片本身就是一个可直接播放的设备，点击 operation--short 即可开播。
    处理顺序：优先嵌套模式（查找并点击子相机），找不到子相机时再降级到平铺模式点击直播按钮，
    并始终在父设备卡片范围内搜索，避免同名子相机（如两个 "Matrice 4TD"）点到错误父设备。
    """
    log.info(f"[嵌套/平铺] 定位父设备: {parent_name}")

    # 1) 找到父设备卡片（多种选择器兼容不同版本 UI）
    parent_card = None
    for sel in ['.device-card', '[class*="device"]', '.share-device-item',
               '[class*="dock"]', 'aside [class*="card"]', 'aside [class*="item"]']:
        try:
            loc = page.locator(sel, has_text=parent_name).first
            if loc.count() > 0:
                parent_card = loc
                log.info(f"[嵌套/平铺] 找到父设备 (selector={sel}): {parent_name}")
                break
        except Exception:
            continue

    if not parent_card or parent_card.count() == 0:
        # 降级：直接用 get_by_text 找父设备
        parent_card = page.get_by_text(parent_name, exact=False).first
        if parent_card.count() == 0:
            raise RuntimeError(f"无法找到父设备: {parent_name}")
        log.info(f"[嵌套/平铺] 通过文本找到父设备: {parent_name}")

    def _click_sub_camera_in_parent():
        """在 parent_card 内部尝试点击子相机，返回是否成功。"""
        # 策略 A：多种选择器尝试找可见子相机按钮
        for btn_sel in ['button:has-text("{}")', '[class*="camera"]:has-text("{}")',
                        '[class*="sub"]:has-text("{}")', 'text={}']:
            try:
                fmt_sel = btn_sel.format(sub_camera_name)
                candidates = parent_card.locator(fmt_sel).all
                for cand in candidates:
                    if cand.is_visible():
                        cand.click(timeout=3000)
                        log.info(f"[嵌套/平铺] 已点击子相机 (parent-scoped selector={fmt_sel}): {sub_camera_name}")
                        return True
            except Exception:
                continue

        # 策略 B：Playwright get_by_text 精确匹配
        try:
            sub_btn = parent_card.get_by_text(sub_camera_name, exact=True).first
            if sub_btn.count() > 0 and sub_btn.is_visible():
                sub_btn.click(timeout=timeout_sec * 1000)
                log.info(f"[嵌套/平铺] parent_card.get_by_text(exact) 点击子相机: {sub_camera_name}")
                return True
        except Exception:
            pass

        # 策略 C：模糊匹配降级
        try:
            sub_btn = parent_card.get_by_text(sub_camera_name, exact=False).first
            if sub_btn.count() > 0:
                sub_btn.click(timeout=timeout_sec * 1000)
                log.info(f"[嵌套/平铺] parent_card.get_by_text(模糊) 点击子相机: {sub_camera_name}")
                return True
        except Exception:
            pass

        return False

    # 2) 嵌套模式：如果父卡片内已包含子相机，直接点击
    if _click_sub_camera_in_parent():
        return

    # 3) 嵌套模式：未找到子相机，尝试点击父设备展开
    log.info(f"[嵌套/平铺] 父设备未展开，尝试展开...")
    try:
        parent_card.click(timeout=timeout_sec * 1000)
        time.sleep(8)
    except Exception as e:
        log.debug(f"[嵌套/平铺] 展开父设备失败: {e}")

    # 4) 展开后再次在父卡片内查找子相机
    if _click_sub_camera_in_parent():
        return

    # 5) 全局兜底：某些 UI 版本展开后子元素可能挂在 DOM 其他位置
    log.warning("[嵌套/平铺] 父卡片内未找到子相机，启用全局兜底策略 D")
    for retry in range(3):
        try:
            candidates = parent_card.get_by_text(sub_camera_name, exact=True).all
            if not candidates:
                candidates = page.get_by_text(sub_camera_name, exact=True).all
            for vb in candidates:
                if vb.is_visible():
                    vb.click(timeout=3000)
                    log.info(f"[嵌套/平铺] Strategy-D 点击子相机: {sub_camera_name}")
                    return
            if retry < 2:
                time.sleep(3)
        except Exception:
            if retry < 2:
                time.sleep(3)
            continue

    # 6) 平铺模式兜底：父设备卡片本身可直接开播，点击右侧直播按钮
    log.warning(f"[嵌套/平铺] 未找到子相机，降级为平铺模式点击父设备直播按钮: {parent_name}")
    try:
        op = parent_card.locator('.operation--short').first
        if op.count() > 0 and op.is_visible():
            op.click(timeout=timeout_sec * 1000)
            log.info(f"[嵌套/平铺] 父设备卡片直接开播 (平铺模式): {parent_name}")
            return
    except Exception as e:
        log.debug(f"[嵌套/平铺] 平铺模式直播按钮点击失败: {e}")

    # 7) 最终兜底：直接点击父设备卡片
    try:
        parent_card.click(timeout=timeout_sec * 1000)
        log.info(f"[嵌套/平铺] 最终兜底：直接点击父设备卡片: {parent_name}")
        return
    except Exception as e:
        log.debug(f"[嵌套/平铺] 点击父设备卡片失败: {e}")

    raise RuntimeError(
        f"无法在父设备 [{parent_name}] 下定位子相机 [{sub_camera_name}]，"
        f"请确认父子名称与页面实际文字一致")

def click_airport(page, airport_name: str, airport_index: Optional[int], timeout_sec: int,
                 parent_name: Optional[str] = None):
    """尝试点击左侧边栏指定机场/相机按钮，启动视频直播。

    支持三种模式：
    1. airport_index：按索引点击顶层设备
    2. airport_name（无 parent_name）：按文本匹配顶层设备卡片
    3. parent_name + airport_name：嵌套子相机——先展开父设备，再点击其中的子相机
    """
    log.info(f"等待机场列表出现（airport_name={airport_name}, index={airport_index}, "
             f"parent={parent_name}, timeout={timeout_sec}s）")

    # ── 策略 0（最高优先级）：嵌套子相机 ──
    if parent_name and airport_name:
        try:
            _click_nested_sub_camera(page, parent_name, airport_name, timeout_sec)
            return
        except Exception as e:
            log.warning(f"嵌套子相机策略失败 (parent={parent_name}, sub={airport_name}): {e}")
            # 不抛异常，继续尝试其他策略作为降级

    # 策略 1：按索引点击左侧第一个可点击的机场类按钮
    if airport_index is not None:
        try:
            # 大疆司空左侧通常为设备/机场列表，常见 class 包含 device、airport、drone 等
            selectors = [
                '.device-card',
                '[class*="device"]',
                '[class*="airport"]',
                '[class*="drone"]',
                '[class*="dock"]',
                '[class*="list"] > div',
                '.share-device-item',
                '.device-item',
                'aside button',
                'aside [role="button"]',
            ]
            for sel in selectors:
                try:
                    items = page.locator(sel).all()
                    if len(items) > airport_index:
                        # 如果找到 operation--short 按钮，优先点击它（真正启动直播）
                        op = items[airport_index].locator('.operation--short').first
                        if op.count() > 0:
                            op.click(timeout=3000)
                            log.info(f"按索引点击直播按钮: selector={sel}, index={airport_index}")
                            return
                        items[airport_index].click(timeout=3000)
                        log.info(f"按索引点击机场按钮: selector={sel}, index={airport_index}")
                        return
                except Exception as e:
                    log.debug(f"索引点击失败 {sel}: {e}")
                    continue
        except Exception as e:
            log.warning(f"airport_index 策略失败: {e}")

    # 策略 2：按文本匹配设备卡片，并点击卡片内的直播按钮
    if airport_name:
        # 大疆司空新版：设备卡片右侧有 operation--short（title="点击或拖至右侧看直播"），
        # 只有点击该按钮才会真正启动视频，点击名称只是选中设备。
        try:
            card = page.locator('.device-card', has_text=airport_name).first
            if card.count() > 0:
                op = card.locator('.operation--short').first
                if op.count() > 0:
                    op.click(timeout=timeout_sec * 1000)
                    log.info(f"按文本点击机场直播按钮: {airport_name}")
                    return
        except Exception as e:
            log.debug(f"直播按钮点击失败，降级点击名称: {e}")

        # 降级：直接点击设备名称文本
        try:
            page.get_by_text(airport_name, exact=False).first.click(timeout=timeout_sec * 1000)
            log.info(f"按文本点击机场: {airport_name}")
            return
        except Exception as e:
            log.warning(f"文本点击失败: {e}")

    raise RuntimeError("无法定位并点击机场按钮，请检查 airportName 或 airportIndex")


def wait_for_video(page, timeout_sec: int = 30):
    """等待页面出现 video 或 canvas 元素，表示视频已加载。"""
    log.info("等待视频元素加载...")
    try:
        # 大疆司空使用 canvas / WebGL 渲染视频，不一定有 <video> 标签
        page.wait_for_selector("video, canvas", state="attached", timeout=timeout_sec * 1000)
        log.info("检测到视频/画布元素")
        return
    except PWTimeout:
        log.warning("未检测到 video/canvas 元素，继续运行")
        return


def enter_fullscreen(page, airport_name: str):
    """
    将视频切换为全屏，消除左侧边栏和其他无视频黑块。

    大疆司空分享页中，每个 player-cell 右上角 hover 后会出现 header-tools，
    其中包含 svgfont-live-fullscreen 图标（第3个按钮），点击后该视频铺满右侧区域。

    Cell 选择策略（按优先级）：
      1. 含 <video> 元素的 cell（最可靠）
      2. 不含 "No video / 无视频" 文本的 cell
      3. 包含 airport_name 关键词的 cell（兜底）
      4. 第一个可见 cell（最后兜底）
    """
    log.info("尝试将视频切换为全屏: %s" % str(airport_name))

    max_retries = 3
    for attempt in range(max_retries):
        try:
            # 1. 查找所有可见 player-cell
            cells = page.locator(".player-cell").all()
            visible_cells = []
            for c in cells:
                try:
                    if c.is_visible():
                        visible_cells.append(c)
                except Exception:
                    continue

            if not visible_cells:
                log.warning("未找到可见 player-cell (尝试 %d/%d)" % (attempt + 1, max_retries))
                if attempt < max_retries - 1:
                    time.sleep(3)
                continue

            log.info("找到 %d 个可见 player-cell" % len(visible_cells))

            # 2. 智能选择含视频的 cell（核心修复）
            target_cell = _pick_video_cell(visible_cells, airport_name)

            if not target_cell:
                target_cell = visible_cells[-1]
                log.info("未找到合适的 cell，使用最后一个")

            # 3. 记录目标 cell 信息
            try:
                cell_text = target_cell.inner_text().replace('\n', ' | ')[:150]
                log.info("目标 player-cell: %s" % cell_text)
            except Exception:
                pass

            # 4. hover 让 header-tools 显示
            target_cell.hover(timeout=5000)
            time.sleep(1.5)

            # 5. 点击全屏按钮
            # 注意：[class*='expand'] 是侧边栏切换按钮，不是视频全屏！已移除
            fs_selectors = [
                ".svgfont-live-fullscreen",          # DJI FlightHub 主选择器 ✅
                "[class*='live-fullscreen']",        # 备选
                ".header-tools [class*='full']",     # header 内含 full 的元素
                ".header-tools svg:nth-of-type(3)",  # header-tools 中第3个svg（固定位置）
            ]

            clicked = False
            for sel in fs_selectors:
                try:
                    fs_btn = target_cell.locator(sel).first
                    if fs_btn.count() > 0 and fs_btn.is_visible():
                        fs_btn.click(timeout=5000)
                        log.info("已点击全屏按钮 (selector=%s)" % sel)
                        time.sleep(2)
                        clicked = True
                        break
                except Exception:
                    continue

            if clicked:
                return

            log.warning("未找到全屏按钮 (尝试 %d/%d)" % (attempt + 1, max_retries))
            if attempt < max_retries - 1:
                time.sleep(3)

        except Exception as e:
            log.warning("进入全屏失败 (尝试 %d/%d): %s" % (attempt + 1, max_retries, e))
            if attempt < max_retries - 1:
                time.sleep(3)

    log.warning("全屏切换最终未成功（不影响推流）")


def _pick_video_cell(cells, airport_name):
    """
    从多个 player-cell 中选出最可能包含目标视频的那个。

    DJI FlightHub 分享页通常有多个 cell（如 2x2 或 4 宫格布局），
    只有被点击开播的设备对应的 cell 才会有 <video> 元素。
    其他 cell 显示 "No video available" 或 "无视频"。

    策略优先级：
      1) 有 <video> 子元素的 cell → 100% 有视频
      2) 文本不含 "No video"/"无视频" 的 cell → 可能正在加载或已有画面
      3) 文本包含 airport_name 任一关键词的 cell → 名称关联
      4) 返回 None 让调用方决定 fallback
    """
    import re

    NO_VIDEO_PATTERNS = ["no video available", "\u65e0\u89c6\u9891"]  # No video available, 无视频

    def is_empty(cell_text):
        t = cell_text.lower()
        return any(p in t for p in NO_VIDEO_PATTERNS)

    # Priority 1: cell with <video> element
    for cell in cells:
        try:
            if cell.locator("video").count() > 0:
                txt = cell.inner_text().replace("\n", " ")[:80]
                log.info("_pick: 选中有 <video> 的 cell: [%s]" % txt)
                return cell
        except Exception:
            continue

    # Priority 2: non-empty cell (no "no video" text)
    for cell in cells:
        try:
            txt = cell.inner_text()[:200]
            if not is_empty(txt):
                log.info("_pick: 选中非空 cell: [%s]" % txt[:80])
                return cell
        except Exception:
            continue

    # Priority 3: keyword match on airport_name parts
    if airport_name:
        keywords = re.split(r'[/|,\s]+', airport_name)
        keywords = [k.strip() for k in keywords if len(k.strip()) >= 2]  # 至少2字符的关键词
        for cell in cells:
            try:
                txt_lower = cell.inner_text().lower()
                matched_kw = [kw for kw in keywords if kw.lower() in txt_lower]
                if matched_kw:
                    log.info("_pick: 关键词匹配 cell (keywords=%s)" % matched_kw)
                    return cell
            except Exception:
                continue

    # All cells seem empty or no match
    log.info("_pick: 所有 cell 都为空或无法匹配")
    return None

def _on_signal(signum, frame):
    global _should_exit
    log.info(f"收到信号 {signum}，准备退出...")
    _should_exit = True


def main():
    global _should_exit
    args = parse_args()

    # 注册信号处理，确保 SIGTERM/SIGINT 触发清理
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    rtmp_url = f"rtmp://{args.zlm_host}:{args.zlm_port}/{args.zlm_app}/{args.stream_id}"
    log.info(f"stream_id={args.stream_id}, rtmp={rtmp_url}")

    # Xvfb 总高度需要包含浏览器标题栏/地址栏（约 80px），ffmpeg 会从 offset_y 开始抓取目标视频区域
    xvfb_height = args.height + args.capture_offset_y
    xvfb_proc, display = ensure_display(args.width, xvfb_height, args.display)
    log.info(f"使用 DISPLAY={display}, Xvfb 分辨率={args.width}x{xvfb_height}, 抓取偏移 y={args.capture_offset_y}")

    # 清理可能残留的同类推流进程（避免 "Already publishing"）
    _kill_stale_stream(args.stream_id)

    ffmpeg_proc = start_ffmpeg(display, args.width, args.height, args.capture_offset_y, args.framerate, args.bitrate, rtmp_url)

    # 给 ffmpeg 一点时间建立连接
    time.sleep(1)

    browser = None
    context = None
    page = None
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=False,
                args=[
                    f"--window-size={args.width},{xvfb_height}",
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--kiosk",
                    "--disable-background-timer-throttling",
                    "--disable-backgrounding-occluded-windows",
                    "--disable-renderer-backgrounding",
                ],
            )
            context = browser.new_context(
                viewport={"width": args.width, "height": xvfb_height},
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                locale="zh-CN",
            )
            page = context.new_page()

            log.info(f"打开页面: {args.share_url}")
            page.goto(args.share_url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_load_state("networkidle", timeout=60000)

            # 大疆司空分享页可能需要几秒钟初始化 WebRTC
            time.sleep(3)

            click_airport(page, args.airport_name, args.airport_index, args.timeout,
                          args.parent_name)

            # 点击直播按钮后，给页面留时间渲染视频（canvas/WebGL）
            time.sleep(5)
            wait_for_video(page, timeout_sec=10)

            # 将当前机场视频切换为全屏，消除左侧边栏和其他无视频黑块。
            # 平铺模式下实际播放的是父设备卡片，因此优先用 parent_name；
            # 传统顶层模式使用 airport_name。
            fullscreen_name = args.parent_name or args.airport_name
            if args.no_fullscreen:
                log.info("已禁用自动全屏 (--no-fullscreen)")
            else:
                enter_fullscreen(page, fullscreen_name)

            log.info("DJI WebRTC 适配器已启动，正在推流")

            write_pidfile(args.pidfile, {
                "python_pid": os.getpid(),
                "ffmpeg_pid": ffmpeg_proc.pid,
                "xvfb_pid": xvfb_proc.pid if xvfb_proc else None,
                "display": display,
                "stream_id": args.stream_id,
                "start_time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            })

            # 保持运行，同时监控 ffmpeg 健康
            while True:
                if _should_exit:
                    log.info("收到退出信号，结束主循环")
                    break

                if ffmpeg_proc.poll() is not None:
                    err = ffmpeg_proc.stderr.read() if ffmpeg_proc.stderr else ""
                    raise RuntimeError(f"ffmpeg 已退出 ({ffmpeg_proc.returncode}): {err[-500:]}")

                if not args.keep_alive:
                    break

                time.sleep(2)

    except KeyboardInterrupt:
        log.info("收到中断信号，正在退出...")
    except Exception as e:
        log.exception("dji-bridge 异常退出")
        sys.exit(1)
    finally:
        log.info("开始清理子进程...")
        if page:
            try:
                page.close()
            except Exception:
                pass
        if context:
            try:
                context.close()
            except Exception:
                pass
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        if ffmpeg_proc and ffmpeg_proc.poll() is None:
            ffmpeg_proc.terminate()
            try:
                ffmpeg_proc.wait(timeout=5)
            except Exception:
                ffmpeg_proc.kill()
        # 兜底：确保 ffmpeg 被彻底杀掉（防止 Python 被 SIGKILL 时 cleanup 未执行导致孤儿进程）
        try:
            subprocess.run(["pkill", "-f", "jsc/%s" % args.stream_id],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
        if xvfb_proc and xvfb_proc.poll() is None:
            xvfb_proc.terminate()
            try:
                xvfb_proc.wait(timeout=3)
            except Exception:
                xvfb_proc.kill()
        # 清理 pidfile
        if args.pidfile:
            try:
                Path(args.pidfile).unlink(missing_ok=True)
            except Exception:
                pass
        log.info("清理完成")


if __name__ == "__main__":
    main()
