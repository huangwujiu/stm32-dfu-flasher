'use strict';
/* =====================================================================
 * node-usb → WebUSB 传输适配器
 *
 * 背景：node-usb v3 的 WebUSB 实现在 Windows 上有个约束 ——
 *   必须先 claimInterface()，之后才允许发控制传输；
 *   否则任何 controlTransferIn/Out 都抛 "invalid state"。
 * 而 dfu-core.js 的 DfuDevice.open() 会先读配置描述符、再 claim 接口。
 *
 * 做法：包一层 Proxy，把 open() 扩展为「打开 + 选配置 + 预 claim」，
 * 并让 claimInterface() 幂等。其余方法/属性原样透传。
 * 这样页面里那份 DfuDevice 代码可以一字不改地跑在 libusb 上。
 * ===================================================================== */

/**
 * @param {object} dev  node-usb WebUSB USBDevice
 * @param {number} intf 需要预 claim 的接口号（STM32 DFU 恒为 0）
 */
function makeWebUsbAdapter(dev, intf) {
  const claimed = new Set();
  let openDone = false;

  async function ensureClaim(n) {
    if (claimed.has(n)) return;
    await dev.claimInterface(n);
    claimed.add(n);
  }

  return new Proxy(dev, {
    get(target, prop) {
      if (prop === 'open') {
        return async function () {
          if (openDone) return;
          await target.open();
          // 显式选配置 1：nusb 从描述符里已知 configuration，但显式设置可确保 WinUSB 管道就绪
          try { await target.selectConfiguration(1); } catch (e) { /* 已配置则忽略 */ }
          // 关键：pre-claim，否则后续控制传输报 invalid state
          await ensureClaim(intf);
          openDone = true;
        };
      }
      if (prop === 'claimInterface') {
        return async function (n) { await ensureClaim(n); };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
}

module.exports = { makeWebUsbAdapter };
