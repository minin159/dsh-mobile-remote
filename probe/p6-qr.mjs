// probe P6：二维码呈现方式实测（服务端 SVG / 客户端内联渲染 两条路都验证）
//
// 方法：内联 vendored MIT 实现（qrcode-generator 1.4.4，Kazuhiko Arase，
//       文件头保留版权与 MIT 声明；无任何运行时依赖）。
//       node 端（模拟 index.js 服务端出 SVG）+ 结构校验；
//       浏览器端由 probe/p5-server.mjs 的页面内联同一份库渲染（模拟 client.js）。
// 运行：node probe/p6-qr.mjs
// 输出：probe/results/p6-qr.svg + p6-result.json；最终正确性由 P5 页面上的
//       两个码（服务端 SVG + 客户端 canvas）用手机实际扫码确认。

// probe 标记：本文件属于阶段 0 探针，不进发布包。

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, 'results');

// CJS 加载 vendored 库（发布形态改为内联 script 时，浏览器端走全局 qrcode）
const req = createRequire(import.meta.url);
const qrcode = req(join(HERE, 'p6-qrcode-generator.js'));

// 测试数据：与阶段 1 真实链接同形（路径含随机 token）
const TEST_URL = 'http://192.168.10.10:18790/t/probe0123456789abcdef';
const qr = qrcode(0, 'M'); // 0 = 自动选版本；M 级纠错（移动端扫码均衡选择）
qr.addData(TEST_URL, 'Byte');
qr.make();

const n = qr.getModuleCount();
const dark = (r, c) => qr.isDark(r, c);

// ── 结构校验：三个定位图案 + 时序图案 + 暗模块 ─────────────────────────────────
function isFinderAt(r0, c0) {
  // 7x7 定位图案：外圈暗、内圈亮、中心 3x3 暗
  for (let dr = 0; dr < 7; dr++) {
    for (let dc = 0; dc < 7; dc++) {
      const edge = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      if (dark(r0 + dr, c0 + dr * 0 + dc) !== (edge || core)) return false;
    }
  }
  return true;
}
const finderOK = isFinderAt(0, 0) && isFinderAt(0, n - 7) && isFinderAt(n - 7, 0);
let timingOK = true;
for (let i = 8; i < n - 8; i++) {
  if (dark(6, i) !== (i % 2 === 0)) timingOK = false; // 第 6 行时序
  if (dark(i, 6) !== (i % 2 === 0)) timingOK = false; // 第 6 列时序
}
const darkModuleOK = dark(n - 8, 8) === true; // 左下角固定暗模块

// ── 服务端 SVG 输出（阶段 1 index.js 的候选形态）──────────────────────────────
const cell = 8; const quiet = 4; // 模块像素 + 静区（模块数）
const size = (n + quiet * 2) * cell;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${n + quiet * 2} ${n + quiet * 2}" shape-rendering="crispEdges">`;
svg += `<rect width="${n + quiet * 2}" height="${n + quiet * 2}" fill="#ffffff"/>`;
svg += `<path fill="#000000" d="`;
for (let r = 0; r < n; r++) {
  for (let c = 0; c < n; c++) {
    if (dark(r, c)) svg += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
}
svg += `"/></svg>`;
writeFileSync(join(RESULTS, 'p6-qr.svg'), svg);

const result = {
  url: TEST_URL,
  version: n <= 21 ? 1 : Math.floor((n - 17) / 4) + 1 > 40 ? 40 : Math.floor((n - 17) / 4) + 1,
  moduleCount: n,
  bytes: Buffer.byteLength(TEST_URL),
  svgBytes: Buffer.byteLength(svg),
  checks: { finderPatterns: finderOK, timingPatterns: timingOK, darkModule: darkModuleOK },
  allPass: finderOK && timingOK && darkModuleOK,
};
writeFileSync(join(RESULTS, 'p6-result.json'), JSON.stringify(result, null, 2));

console.log(`P6 生成完成：moduleCount=${n}（版本 ${result.version}）svg=${result.svgBytes}B`);
console.log(`结构校验：定位图案=${finderOK} 时序图案=${timingOK} 暗模块=${darkModuleOK}`);
console.log(`最终判定（含手机扫码）由 P5 页面双码（/qr.svg + 客户端 canvas）确认`);
process.exit(result.allPass ? 0 : 1);
