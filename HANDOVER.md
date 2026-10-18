# STM32 DFU 升级工具 · 交接文档

> 最后更新：2026-10-18 · 维护者：huangwujiu
> 线上：https://stm32-dfu-flasher.app.workbuddy.host/ ｜ 仓库：https://github.com/huangwujiu/stm32-dfu-flasher（公开）

---

## 1. 这是什么

浏览器里的 STM32F103 DFU 烧录工具：插上 USB 进 Bootloader（0483:df11），网页通过 **WebUSB** 直接烧录，不需要装 STM32 CubeProgrammer / DfuSe。

- **单文件、零依赖**：全部产品代码在 `index.html` 一个文件里（原生 JS + 内联 `<script>`，协议实现与 UI 同文件）
- 支持四种固件：`.hex`（Intel HEX）/ `.bin`（裸二进制，手填起始地址）/ `.dfu`（DfuSe）/ `.elf`（ARM 32 位）
- 从设备描述符**动态解析内存布局和读写权限**，只读区（Bootloader 本体）在本地拦死，不会下发擦写命令
- 附带云服务（升级记录 + 团队固件库 + 验证码登录），**未登录也能完整烧写**

## 2. 仓库里有什么（入库只有 5 个文件）

| 文件 | 说明 |
|---|---|
| `index.html` | 唯一产品文件（约 2700 行）：DFU 协议 + 固件解析 + 页面 UI + 云服务模块 |
| `release/index.html` | 线上部署源副本，与根目录一致（发布流程从 `release/` 上传） |
| `.gitattributes` | 统一 LF 行尾，避免 Windows CRLF 噪音 |
| `.gitignore` | 忽略 `test/`（本地测试套件 + 固件备份）和 `.workbuddy/` |
| `.wbapp_YuAvAs0R4YNAkyBkR0H1WW.genie` | 云发布应用标记（applicationId / 入口页） |

**本地工作区（有意不入库）**：`test/` 目录——四层测试套件 + 固件备份 + 测试截图。改代码的完整流程依赖它，别删。

## 3. 设备与协议：改代码前必须知道的事

以下全部是**真机实测**结论（STM32F103，序列号 49983F7D3447），不是文档抄的。

### 3.1 基本参数
- VID:PID = `0483:df11`；`wTransferSize = 1024`；`bcdDFU = 0x011A`
- 内存布局**一律从设备描述符动态解析，禁止硬编码**（用户换 bootloader 后布局会变）：

| Bootloader | 布局字符串 | 可写区 | 只读区 |
|---|---|---|---|
| 旧版 | `@Internal Flash /0x08001000/92*001Kg,32*001Ka` | 0x08001000–0x08017FFF | 0x08018000–0x0801FFFF |
| 新版（2026-10-18 起） | `@Internal Flash /0x08000400/114*001Kg,13*001Ka` | 0x08000400–0x0801CBFF | 0x0801CC00–0x0801FFFF |

只读区里就是 DFU Bootloader 本体（旧版 Reset=0x08018EE9），**擦掉直接变砖**。

### 3.2 DfuSe 权限字母（UM0424 §4.3.2）
每组「页数 × 页大小」后可带一个权限字母：`a` 只读 / `b` 仅擦 / `c` 读+擦 / `d` 仅写 / `e` 读+写 / `f` 擦+写 / `g` 读+擦+写；**字母缺省 = 全权限**；页大小无单位 = **字节**。代码里是 `DFU_ACCESS` / `accessProgrammable()`（要求 write && erase）。

### 3.3 DNLOAD 数据块语义（本站最重要的坑）
1. **数据块写入前，先擦除「块起始地址」所在的 1KB 页再写**；SET_ADDRESS 本身不擦页。
2. **数据块号必须从 2 起连续递增**；不连续的块号被设备**静默忽略**（无 STALL，但数据不落盘）。

推论（2026-10-18 线上 bug 的根因）：每块都重新 SET_ADDRESS + 块号恒 2 的写法，会让第二块从页中间开写时把前一块擦掉。正确做法：
- `downloadElement()`：每段只 SET_ADDRESS 一次，块号 2→3→4… 递增
- `mergeSegments()`：间隙 ≤4KB 的相邻段填 0xFF 连成一整段连续写
- `eraseForSegments()`：整包统一擦除（去重排序），避免后段擦除覆盖先写的段

`.bin` 是单段，从不触发这个问题——所以「bin 能烧、hex/elf 失败」极具迷惑性。

### 3.4 ELF 解析：节表优先
`arm-none-eabi-ld` 会把 ELF 头 + 程序头表圈进第一个 PT_LOAD（`p_offset=0`），导致解析起点比 HEX 大一个文件头（0x08000000 vs 0x08000400）。所以：
- **节表优先**：按 SHF_ALLOC 节取段，VMA→LMA 映射（`.data` 的 VMA 在 SRAM、LMA 才在 Flash）
- 无节表（strip）才回退程序头 + 跳 ELF 头 + 4 字节取齐裁零（防止吞掉 SP=0x20005000 的首字节 0x00）
- 地址必须用 `p_paddr`（LMA）；`p_filesz=0`（.bss）跳过；SRAM 段跳过（本板不支持 SRAM 写入）

### 3.5 其他实测行为
- **UPLOAD** 前若刚发过 SET_ADDRESS，必须先 ABORT 回 dfuIDLE 否则 STALL → 已由 `uploadElement` 三级降级自动处理（标准序列 → SET_ADDRESS+ABORT → 逐块）
- STALL 后可能停在 dfuDNLOAD_IDLE 且 bStatus=0 → 需 ABORT + CLRSTATUS 双发复位（`recoverToIdle()`）
- 本板**不支持 SRAM 写入**，禁止 RAM 读写测试
- `--leave` 跳转后 APP 有效则 USB DFU 消失（枚举为 0483:5740 CDC），**只能 KEY_UP + 复位**回 Bootloader；APP 无效时 BOOT 自动回落 DFU

## 4. 代码地图（都在 index.html 里）

| 功能 | 入口 |
|---|---|
| 固件解析 | `parseIntelHex` / `parseDfuSe` / `parseElf` / `parseMemoryLayout` |
| 布局与权限 | `DFU_ACCESS` / `accessOf` / `accessProgrammable` / `pagesToErase` / `erasePlan` / `checkWriteRange` / `writableRanges` |
| 协议核心 | `DfuDevice`：`open` / `setAddressPointer` / `downloadElement` / `erasePage` / `eraseForSegments` / `uploadElement` / `verifyElement` / `leaveDfu` / `recoverToIdle` |
| 多段合并 | `mergeSegments` |
| 烧录按钮流程 | `btn-flash` / `btn-write` 处理器：`mergeSegments` → `eraseForSegments` → 逐段 `downloadElement(..., noErase=true)` |
| 只读区三道防线 | ① `downloadElement` 开头抛错 ② `precheckWritable()` 确认框前拦截 ③ `refreshTargetCheck()` 实时提示 |
| 云服务 | `PUBLIC_CONFIG` + `CloudApi`（`afterFlash` 写记录）+ `window.__dfuUI` 暴露给云模块 |

`test/dfu-core.js` 是 `index.html` 内联 script 的抽取副本，由 `test/sync-core.js` 生成——**页面与测试同源，改完 index.html 必须跑一次 sync-core**。

## 5. 标准改动流程（必须遵守）

```bash
# 1. 只改 index.html
# 2. 重新生成测试用核心
node test/sync-core.js
# 3. 模拟测试必须全绿（92 项，不允许回归）
node test/simulate.js
# 4. 涉及协议的改动，设备在 DFU 模式时再跑硬件测试
NODE_PATH=C:/Users/huang/.workbuddy/binaries/node/workspace/node_modules node test/hw-libusb-test.js
# 5. 同步发布副本并发布（链接不变）
cp index.html release/index.html
# 6. commit + push
```

**push 注意**：开发沙箱代理只放行 api.github.com，github.com（git 协议）不通，**`git push` 必须在用户自己的终端执行**。我（代理）只读 api.github.com 核对远端一致性。

## 6. 测试体系

| 脚本 | 覆盖 | 项数 | 依赖 |
|---|---|---|---|
| `test/simulate.js` | AN3156 状态机 / HEX / DFU / ELF / 错误码 / 多段烧录回归（MockUSB 按实测语义模拟） | 92 | 无 |
| `test/hw-libusb-test.js` | 真实设备只读：枚举/描述符/布局/UPLOAD/整片读回 | 32 | usb npm + 设备在 DFU 模式 |
| `test/browser-bridge-test.js` | 浏览器 UI + 真实设备（DOM 驱动 + 传输桥接） | 25 | usb npm + Edge |
| `test/browser-ui-upgrade.js` | 页面 UI 端到端升级（连接→选文件→擦写→校验→跳转） | 14 | usb npm + Edge |
| `test/app-upgrade.js` | **写入路径**（`read`/`flash`/`verify`），布局动态获取 | — | usb npm + 设备 |
| `test/cloud-ui-test.js` | 云服务接入：SDK/初始化/未登录 UI/RLS/登录校验 | 27 | 仅 Edge |
| `test/addr-ui-test.js` | .bin 默认起始地址来自设备描述符 | 21 | 仅 Edge |

- 硬件类测试**默认只读**：不 erase、不 download、不 leaveDfu
- 写操作只走 `app-upgrade.js`，三条硬约束：必须先有备份、写入区间必须落在描述符声明的可写区内、每次写完校验只读区首块指纹不变
- 整片备份 `test/flash-backup-49983F7D3447.bin` 做任何写操作前先读回比对

## 7. 云服务（WorkBuddy Cloud Service）

- applicationId `wbapp_YuAvAs0R4YNAkyBkR0H1WW`，endpoint = 发布域名；SDK 走 CDN（`@dev` 频道，别锁版本）
- 两张表（public schema，RLS 全开）：
  - `flash_records`：升级记录，**仅本人可见**（owner_id = auth.uid()）
  - `firmware_library`：团队固件库元数据，登录用户可读、仅上传者可删
- 登录：手机号 / 邮箱二选一验证码（`sendOtp` → `verifyOtp`，先取码再登录）
- 设计边界：**未登录也能完整烧写**，云端只承担记录 + 固件库；烧完由 `CloudApi.afterFlash()` 静默写记录

## 8. 安全红线

1. **固件备份（`test/*.bin`）含设备真实 Flash 内容，绝不能进公开仓库/静态托管**（.gitignore 已拦）
2. 只读区 = Bootloader 本体，擦掉变砖——本地三道防线 + 真机写后校验只读区指纹
3. 本板不支持 SRAM 写入，别做 RAM 读写测试
4. 烧错不丢 DFU：APP 无效时 BOOT 自动回落 DFU 模式

## 9. 当前状态与待办

**已完成**：
- 多段固件烧录修复（DNLOAD 擦页语义 + 块号连续性），真机验证：HEX 6/6、ELF 7/7 且跳转后新固件正常运行
- ELF/HEX 起始地址统一（节表优先解析），铺平后逐字节一致
- GitHub 仓库建好并瘦身为「只保留程序」（历史提交 30edf36 里有完整测试套件可随时取回）

**待办 / 未覆盖**：
- 硬件类测试需要设备回 DFU 模式（KEY_UP + 复位）才能跑
- 真实登录（用户自己的短信/邮箱验证码）与 storage 上传下载往返未覆盖
- 新 bootloader 布局（0x08000400 起 114KB）下的 app-upgrade 写入路径尚未在新布局真机复跑

## 10. 环境备注

- Node 测试：`node test/xxx.js`；usb 相关测试加 `NODE_PATH=C:/Users/huang/.workbuddy/binaries/node/workspace/node_modules`
- Edge：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
- WebUSB 原生设备选择气泡不在页面 DOM 里，CDP 无法程序化操作——全自动测试走 `browser-bridge-test.js` 的传输桥接方案
- 用户固件参考位置：`D:\stm32f103\E22_XXXMBx_SC_WorkSpace\Firmware\APP\`（起始地址 0x08000400）
