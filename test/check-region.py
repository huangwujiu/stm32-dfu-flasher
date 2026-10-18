# check-region.py — 检查矩形区域的平均颜色，判断设备行是否被选中
# 用法: check-region.py <截图> <x0> <y0> <x1> <y1>
# 输出 JSON: { mean:[r,g,b], blueish:bool, whiteish:bool }
import sys, json
import numpy as np
from PIL import Image

img = Image.open(sys.argv[1]).convert('RGB')
a = np.asarray(img).astype(np.float64)
x0, y0, x1, y1 = [int(v) for v in sys.argv[2:6]]
H, W = a.shape[:2]
x0, y0 = max(0, x0), max(0, y0)
x1, y1 = min(W - 1, x1), min(H - 1, y1)
r = a[y0:y1 + 1, x0:x1 + 1]
flat = r.reshape(-1, 3)
mean = flat.mean(axis=0)
mr, mg, mb = mean
# ink: 与区域主色差异 >20 的像素比例（用于判断页面是否真的绘制出来了）
dev = np.abs(flat - mean).max(axis=1)
ink = float((dev > 20).mean())
print(json.dumps({
    "mean": [round(mr, 1), round(mg, 1), round(mb, 1)],
    "blueish": bool(mb - mr > 4 and mb > 200),   # 选中高亮：浅蓝底
    "whiteish": bool(mr > 240 and mg > 240 and mb > 240),  # 未选中：纯白
    "darkish": bool(mr < 150 and mg < 150 and mb < 150),   # 遮罩/关闭
    "ink": round(ink, 4)
}))
