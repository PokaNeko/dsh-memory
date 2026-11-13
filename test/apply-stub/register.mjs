/**
 * 测试入口辅助：注册宿主包解析桩，让核心测试套件不装 dsh 也能跑。
 *
 * 用法（仓库根目录下）：
 *   node --import ./test/apply-stub/register.mjs test/smoke.test.mjs
 *
 * 原理：stub-loader.mjs 只导出 resolve 钩子、不自注册；这里用 node:module
 * 的 register() 把它挂上（相对路径按本文件解析，跨平台可用）。
 */
import { register } from 'node:module';

register('./stub-loader.mjs', import.meta.url);
