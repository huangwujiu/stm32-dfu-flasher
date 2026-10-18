# find-chooser-points.py v4 — 定位 Edge WebUSB 选择器气泡内的关键点击点
# 用法: find-chooser-points.py <截图>
# 输出 JSON: { ok, bubble, device, connect, cancel, devbox, lines }
# 原理：
#   1. 选择器打开时页面被模态遮罩调暗，气泡是少数纯白(>250)块之一；
#   2. 签名：块内有 2~5 行深色文字；底部按钮行可分出「取消」(深色簇)及其左侧的「连接」簇
#      （禁用态「连接」为浅灰，需用 <235 阈值 + 列计数>=3 才能稳定分开两个按钮）；
#   3. 设备名 = 标题行下方第一条文字行（取其水平中心点击）；
#   4. 连接 = 取消左侧最近的按钮簇，取消 = 最右侧深色簇。
import sys, json
import numpy as np
from PIL import Image

img = Image.open(sys.argv[1]).convert('RGB')
a = np.asarray(img).astype(np.int16)
H, W = a.shape[:2]
white = (a[:, :, 0] > 250) & (a[:, :, 1] > 250) & (a[:, :, 2] > 250)
dark = (a[:, :, 0] < 150) & (a[:, :, 1] < 150) & (a[:, :, 2] < 150)

# ---------- 1. 全屏白色块（行段 BFS 聚类） ----------
segs = []
for y in range(H):
    xs = np.where(white[y])[0]
    if len(xs) == 0:
        continue
    sp = np.where(np.diff(xs) > 6)[0]
    st = np.concatenate([[0], sp + 1]); en = np.concatenate([sp, [len(xs) - 1]])
    for s, e in zip(st, en):
        if xs[e] - xs[s] + 1 >= 100:
            segs.append((y, int(xs[s]), int(xs[e])))
blocks, used = [], [False] * len(segs)
for i in range(len(segs)):
    if used[i]:
        continue
    stack, used[i] = [i], True
    bx0, bx1, by0, by1 = segs[i][1], segs[i][2], segs[i][0], segs[i][0]
    while stack:
        yj, ax0, ax1 = segs[stack.pop()]
        for k in range(len(segs)):
            if used[k]:
                continue
            yk, cx0, cx1 = segs[k]
            if abs(yk - yj) <= 3 and not (cx1 < ax0 - 6 or cx0 > ax1 + 6):
                used[k] = True
                stack.append(k)
                bx0 = min(bx0, cx0); bx1 = max(bx1, cx1)
                by0 = min(by0, yk); by1 = max(by1, yk)
    w, h = bx1 - bx0, by1 - by0
    if 280 <= w <= 750 and 130 <= h <= 420:
        blocks.append((bx0, by0, bx1, by1))
if not blocks:
    print(json.dumps({"ok": False, "reason": "no white block"}))
    sys.exit(1)
blocks.sort(key=lambda b: (b[1], b[0]))  # 先按 y 再按 x，最靠上的选择器优先

# ---------- 2. 工具函数 ----------
def text_lines(bx0, by0, bx1, by1):
    """块内深色文字行（绝对坐标）"""
    inner = dark[by0 + 3:by1 - 2, bx0 + 3:bx1 - 2]
    rsum = inner.sum(axis=1)
    lines, cur = [], []
    for i, v in enumerate(rsum):
        if v >= 2:
            cur.append(i)
        else:
            if len(cur) >= 5:
                lines.append((cur[0], cur[-1]))
            cur = []
    if len(cur) >= 5:
        lines.append((cur[0], cur[-1]))
    out = []
    for l in lines:
        seg = inner[l[0]:l[1] + 1, :]
        cols = np.where(seg.any(axis=0))[0]
        if len(cols) == 0:
            continue
        out.append({"y0": l[0] + by0 + 3, "y1": l[1] + by0 + 3,
                    "x0": int(cols[0]) + bx0 + 3, "x1": int(cols[-1]) + bx0 + 3})
    return out

def bottom_buttons(b, bottom_line):
    """底部按钮行：返回 (连接簇, 取消簇) 或 None。
    禁用态「连接」是浅灰，用 <235 阈值；列计数>=3 过滤抗锯齿间隙。"""
    bx0, by0, bx1, by1 = b
    y0 = bottom_line["y0"] - 2
    y1 = bottom_line["y1"] + 3
    seg = a[y0:y1, bx0 + 3:bx1 - 2]
    nonwhite = ~((seg[:, :, 0] > 235) & (seg[:, :, 1] > 235) & (seg[:, :, 2] > 235))
    colcnt = nonwhite.sum(axis=0)
    cols = np.where(colcnt >= 3)[0]
    if len(cols) == 0:
        return None
    clusters, cur = [], [cols[0]]
    for x in cols[1:]:
        if x - cur[-1] <= 8:
            cur.append(x)
        else:
            clusters.append(cur); cur = [x]
    clusters.append(cur)
    cinfo = []
    for c in clusters:
        x0, x1 = c[0], c[-1]
        sub = seg[:, x0:x1 + 1]
        m = sub[nonwhite[:, x0:x1 + 1]].mean(axis=0)
        cinfo.append({"x0": int(x0) + bx0 + 3, "x1": int(x1) + bx0 + 3,
                      "mean": [round(float(v)) for v in m]})
    dark_ci = [i for i, ci in enumerate(cinfo) if max(ci["mean"]) < 160]
    if not dark_ci:
        return None
    ci_cancel = cinfo[dark_ci[-1]]           # 最右深色簇 = 取消
    left = [ci for ci in cinfo if ci["x1"] < ci_cancel["x0"]]
    if not left:
        return None
    return left[-1], ci_cancel               # 取消左侧最近簇 = 连接

# ---------- 3. 找选择器块 ----------
chosen = None
for b in blocks:
    lines = text_lines(*b)
    if len(lines) < 2 or len(lines) > 5:
        continue
    btns = bottom_buttons(b, lines[-1])
    if btns is None:
        continue
    chosen = (b, lines, btns[0], btns[1])
    break
if chosen is None:
    # 兜底：左侧区域（测试窗口在屏幕左半部）内、2~6 行文字、底部有双按钮簇的块
    for b in blocks:
        if b[2] > W * 0.45:
            continue
        lines = text_lines(*b)
        if len(lines) < 2 or len(lines) > 6:
            continue
        btns = bottom_buttons(b, lines[-1])
        if btns is None:
            continue
        chosen = (b, lines, btns[0], btns[1])
        break
if chosen is None:
    print(json.dumps({"ok": False, "reason": "no chooser block matched", "blocks": len(blocks)}))
    sys.exit(1)

b, lines, ci_connect, ci_cancel = chosen
bx0, by0, bx1, by1 = b
# 设备名：标题（第一行）下方的第一条文字行
name = lines[1] if len(lines) >= 2 else lines[0]
device_pt = [(name["x0"] + name["x1"]) // 2, (name["y0"] + name["y1"]) // 2]
btn_y = (lines[-1]["y0"] + lines[-1]["y1"]) // 2
connect_pt = [(ci_connect["x0"] + ci_connect["x1"]) // 2, btn_y]
cancel_pt = [(ci_cancel["x0"] + ci_cancel["x1"]) // 2, btn_y]
# 设备行区域（用于选中态校验）
devbox = [bx0 + 6, max(by0 + 4, name["y0"] - 22), bx1 - 6, min(by1 - 4, name["y1"] + 22)]

print(json.dumps({
    "ok": True,
    "bubble": [int(bx0), int(by0), int(bx1), int(by1)],
    "device": [int(v) for v in device_pt],
    "connect": [int(v) for v in connect_pt],
    "cancel": [int(v) for v in cancel_pt],
    "devbox": [int(v) for v in devbox],
    "lines": len(lines)
}))
