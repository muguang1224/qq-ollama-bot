// 项目根目录定位 —— 所有模块统一用这个。
//
// 为什么需要统一：
//   代码可能在两个位置：
//     · 本地开发：bridge.mjs 等项目根目录
//     · 发布版：  代码在 src/ 下
//   原来各模块各写一套（dirname(__dirname) / dirname(dirname(...)) / 硬编码），
//   结果出现过：
//     · 配置文件生成到 src/ 而不是项目根
//     · video.mjs 取多一级，指到桌面
//     · 检查NapCat.mjs 硬编码路径，换台机器就废
//
// 现在的做法：从本文件所在目录往上找，认准"标志物"。
//   标志物 = 有没有 package.json 或 config.json 或 已经到顶层
// 这样代码放哪都不会错，也不写死任何路径。

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件所在目录 */
export const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 找项目根目录。
 *
 * 判定顺序：
 *   1. 从 HERE 往上找，谁有 package.json 就是谁
 *   2. 找不到 package.json，就找有 src/ 或 yolo-models/ 的
 *   3. 再找不到，只往上退一级（= src/ 的上一级）
 *
 * @returns {string} 项目根目录绝对路径
 */
export function findRoot() {
  let dir = HERE;

  // 1. 往上找 package.json
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir || up === parse(dir).root) break;
    dir = up;
  }

  // 2. 找带 src/ 或 yolo-models/ 的目录
  dir = HERE;
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, 'src')) || existsSync(join(dir, 'yolo-models'))) return dir;
    const up = dirname(dir);
    if (up === dir || up === parse(dir).root) break;
    dir = up;
  }

  // 3. 兜底：往上一级
  const up = dirname(HERE);
  return up === HERE ? HERE : up;
}

/** 项目根目录（模块加载时就确定，之后不再变） */
export const ROOT = findRoot();

/** 拼项目根下的路径 */
export function rootPath(...parts) {
  return join(ROOT, ...parts);
}

/**
 * 找一个"应该在项目根下"的目录。
 * 用于数据目录（memories / emotions / stickers / proactive / logs）。
 * 不存在时返回根下的默认路径（由调用方决定要不要建）。
 */
export function dataDir(name) {
  return join(ROOT, name);
}