# -*- coding: utf-8 -*-
import sys

path = '/opt/jsc/dji-bridge/dji_bridge.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

start = content.find('def enter_fullscreen(')
end = content.find('def _on_signal(')
if start == -1 or end == -1:
    print('ERROR: function boundaries not found')
    sys.exit(1)

new_func = '''def enter_fullscreen(page, airport_name: str):
    """
    将视频切换为全屏，消除左侧边栏和其他无视频黑块。

    大疆司空分享页中，每个 player-cell 右上角 hover 后会出现 header-tools，
    其中包含 live-fullscreen 图标，点击后该视频块会铺满右侧播放区。

    本函数不依赖 airport_name 精确匹配 player-cell 标题（标题可能是
    无人机名/相机名而非设备名），而是找到所有可见的 player-cell，
    优先选择包含 airport_name 文本的；找不到则选最后一个（通常是刚开播的）。
    """
    log.info(f"尝试将视频切换为全屏: {airport_name}")

    max_retries = 3
    for attempt in range(max_retries):
        try:
            # 1. 查找所有 player-cell
            cells = page.locator(".player-cell").all()
            visible_cells = []
            for c in cells:
                try:
                    if c.is_visible():
                        visible_cells.append(c)
                except Exception:
                    continue

            if not visible_cells:
                log.warning(f"未找到可见 player-cell (尝试 {attempt+1}/{max_retries})")
                if attempt < max_retries - 1:
                    time.sleep(3)
                continue

            log.info(f"找到 {len(visible_cells)} 个可见 player-cell")

            # 2. 优先选择包含 airport_name 文本的；否则选最后一个
            target_cell = None
            for cell in visible_cells:
                try:
                    text = cell.inner_text()
                    if airport_name and airport_name in text:
                        target_cell = cell
                        log.info("找到文本匹配的 player-cell")
                        break
                except Exception:
                    continue

            if not target_cell:
                target_cell = visible_cells[-1]
                log.info("未找到文本匹配，使用最后一个可见 cell")

            # 3. 记录目标 cell 信息用于调试
            try:
                cell_text = target_cell.inner_text().replace('\\n', ' | ')[:150]
                log.info(f"目标 player-cell: {cell_text}")
            except Exception:
                pass

            # 4. hover 让 header-tools 显示
            target_cell.hover(timeout=5000)
            time.sleep(1)

            # 5. 点击全屏按钮（多种选择器兼容不同 UI 版本）
            fs_selectors = [
                ".svgfont-live-fullscreen",
                "[class*='live-fullscreen']",
                "[class*='fullscreen']",
                ".header-tools [class*='full']",
                "[class*='expand']",
            ]

            for sel in fs_selectors:
                try:
                    fs_btn = target_cell.locator(sel).first
                    if fs_btn.count() > 0 and fs_btn.is_visible():
                        fs_btn.click(timeout=5000)
                        log.info(f"已点击全屏按钮 (selector={sel})")
                        time.sleep(2)
                        return
                except Exception:
                    continue

            # 6. 全局搜索全屏按钮（可能在 player-cell 外部）
            log.info("player-cell 内未找到全屏按钮，尝试全局搜索...")
            for sel in fs_selectors:
                try:
                    fs_btn = page.locator(sel).first
                    if fs_btn.count() > 0 and fs_btn.is_visible():
                        fs_btn.click(timeout=5000)
                        log.info(f"已点击全局全屏按钮 (selector={sel})")
                        time.sleep(2)
                        return
                except Exception:
                    continue

            log.warning(f"未找到全屏按钮 (尝试 {attempt+1}/{max_retries})")
            if attempt < max_retries - 1:
                time.sleep(3)

        except Exception as e:
            log.warning(f"进入全屏失败 (尝试 {attempt+1}/{max_retries}): {e}")
            if attempt < max_retries - 1:
                time.sleep(3)

    log.warning("全屏切换最终未成功（不影响推流）")


'''

content = content[:start] + new_func + content[end:]
with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('OK: enter_fullscreen updated')
