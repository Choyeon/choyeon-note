/**
 * T39 · Electron 深色变量守卫（theme parity guard）
 *
 * 背景
 * ----
 * CSS 自定义属性是「逐属性级联」，不是整块覆盖。`.electron-mode[data-theme='dark']`
 * 里没重写的变量，仍然会从 `[data-theme='dark']` 取到深色值 —— 所以问题从来不是
 * 「变量没生效」，而是 **alpha 口径不一致**：`.electron-mode` 下的 14 个是半透明的，
 * 其余从 `[data-theme='dark']` 继承的却是实色的，两者混排就出现「实色板」质感断层。
 *
 * 本测试做的事
 * ------------
 * 1. 直接 fs 读 src/style.css 解析，**不启动 DOM**（纯静态解析，跑得快、不受渲染影响）。
 * 2. 断言「`[data-theme='dark']` 里的每个变量，要么在 `.electron-mode[data-theme='dark']`
 *    里被同步覆盖，要么在 ELECTRON_DARK_EXEMPT 白名单里显式登记」——
 *    这是防止以后有人新增深色变量却忘记同步 `.electron-mode` 的唯一手段。
 * 3. 断言同步过去的必须是**半透明值**（rgba 且 alpha < 1），否则断层依然存在。
 * 4. 白名单里的项一旦被覆盖，测试会提示「可以从白名单移除」。
 *
 * 硬约束（改 CSS 变量必须想四处）
 * ------------------------------
 *   :root → [data-theme='dark'] → .electron-mode → .electron-mode[data-theme='dark']
 * 且 `.electron-mode` 在文件末尾（同特异性但靠后，会覆盖前面全部）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS_PATH = path.resolve(__dirname, '..', 'src', 'style.css');

/* ============================================================
   1. CSS 静态解析（无 DOM）
   ============================================================ */

/** 规范化选择器：压掉注释、压空白。 */
function normalizeSelector(raw) {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 扫描顶层规则块。用花括号配对；@media / @supports 等 at-rule 连同其嵌套块整体跳过。
 * @returns {Array<{selector: string, start: number, end: number, body: string}>}
 */
function scanTopLevelRules(css) {
  const rules = [];
  let buf = '';
  let i = 0;
  const len = css.length;

  while (i < len) {
    const ch = css[i];

    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close === -1 ? len : close + 2;
      buf += ' ';
      continue;
    }

    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      const bodyStart = j;
      while (j < len && depth > 0) {
        if (css[j] === '{') depth += 1;
        else if (css[j] === '}') depth -= 1;
        j += 1;
      }
      const body = css.slice(bodyStart, j - 1);

      // buf 里可能混有前面「无块」的语句（如 `@tailwind base;`），
      // 取最后一条非空语句才是真正的选择器 / at-rule 前导。
      const segs = buf.split(';');
      let selector = '';
      for (let k = segs.length - 1; k >= 0; k -= 1) {
        const t = normalizeSelector(segs[k]);
        if (t) {
          selector = t;
          break;
        }
      }

      if (!selector.startsWith('@')) {
        rules.push({ selector, start: i, end: j, body });
      }
      buf = '';
      i = j;
      continue;
    }

    if (ch === '}') {
      buf = '';
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  return rules;
}

/**
 * 从规则体里提取自定义属性声明。同块内后写覆盖先写（与 CSS 语义一致）。
 * @returns {Map<string, string>}
 */
function extractVars(body) {
  const noComments = body.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map();
  const re = /(^|[;{\s])(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]*)/g;
  let m;
  while ((m = re.exec(noComments)) !== null) {
    const value = m[3].trim();
    if (!value) continue;
    out.set(m[2], value);
  }
  return out;
}

const SELECTORS = {
  root: ':root',
  dark: "[data-theme='dark']",
  electron: '.electron-mode',
  electronDark: ".electron-mode[data-theme='dark']",
};

const cssText = fs.readFileSync(CSS_PATH, 'utf8');
const allRules = scanTopLevelRules(cssText);

/** 取某个精确选择器的所有规则块（支持逗号选择器列表）并合并变量表。 */
function blockVars(selector) {
  const blocks = allRules.filter((r) =>
    r.selector.split(',').map(normalizeSelector).includes(selector)
  );
  const merged = new Map();
  for (const b of blocks) {
    for (const [k, v] of extractVars(b.body)) merged.set(k, v);
  }
  return { vars: merged, blocks };
}

const ROOT = blockVars(SELECTORS.root);
const DARK = blockVars(SELECTORS.dark);
const EM = blockVars(SELECTORS.electron);
const EM_DARK = blockVars(SELECTORS.electronDark);

/* ============================================================
   2. 白名单：刻意「不」在 .electron-mode[data-theme='dark'] 里覆盖的变量
   ============================================================ */

/**
 * ELECTRON_DARK_EXEMPT
 * --------------------
 * 这些变量在 `[data-theme='dark']` 里有定义，但**刻意不**在
 * `.electron-mode[data-theme='dark']` 里重写。原因是它们属于「纯色相类」或
 * 「非颜色数值类」，半透明化会破坏语义，也不会产生 alpha 断层：
 *
 *  - primary / secondary / accent 全族：品牌色与强调色，是**色相**不是**承载面**。
 *    做成半透明会让按钮/链接在亚克力背景上发灰、对比度掉到 WCAG 之下。
 *    承载面已经由 --color-surface / --card-bg / --sidebar-bg 等半透明变量负责。
 *  - --state-* ：成功/警告/错误/信息的语义色，半透明会丢失状态可辨识度。
 *  - --color-{error,success,warning}-surface*：状态底色薄片，本身就是低 alpha 的
 *    rgba（0.1 / 0.15），已经是半透明口径，无需再改。
 *  - --color-border-focus / --shadow-focus：焦点环，跟随 primary 色相，
 *    且是无障碍焦点可见性的一部分，必须保持不透明。
 *  - --shadow-focus 虽带 -shadow 前缀，但它是 primary 派生色环，归入色相类。
 *  - *-blur / *-saturate：非颜色数值 token（模糊半径 / 饱和度百分比），
 *    不存在 alpha 概念，无需亚克力化。
 *  - --sidebar-count-color：只是 var(--color-text-secondary) 的别名，
 *    跟随文本色即可，不在此处重复定义。
 *
 * ⚠️ 维护约定：往这里加条目时必须写明理由。若某个变量后来被覆盖了，
 *    下面的「白名单可收敛」用例会提示把它从这里移除。
 */
const ELECTRON_DARK_EXEMPT = {
  // —— primary 全族（品牌色相，半透明会发灰、掉对比度）——
  '--color-primary': '品牌主色相，需保持不透明以保证对比度',
  '--color-primary-light': 'primary 色阶，纯色相类',
  '--color-primary-lighter': 'primary 色阶，纯色相类',
  '--color-primary-lightest': 'primary 色阶，纯色相类',
  '--color-primary-dark': 'primary 色阶，纯色相类',
  '--color-primary-darker': 'primary 色阶，纯色相类',
  '--color-primary-ring': 'primary 派生焦点环，纯色相类',
  '--color-primary-surface': 'primary 派生薄底，纯色相类（已是 rgba，无需改）',

  // —— secondary 全族 ——
  '--color-secondary': '辅助色相，需保持不透明',
  '--color-secondary-light': 'secondary 色阶，纯色相类',
  '--color-secondary-lighter': 'secondary 色阶，纯色相类',
  '--color-secondary-lightest': 'secondary 色阶，纯色相类',
  '--color-secondary-dark': 'secondary 色阶，纯色相类',

  // —— accent 全族 ——
  '--color-accent': '强调色相，需保持不透明',
  '--color-accent-light': 'accent 色阶，纯色相类',
  '--color-accent-lighter': 'accent 色阶，纯色相类',

  // —— 状态语义色：半透明会丢失状态可辨识度 ——
  '--state-success': '状态语义色，需保持不透明',
  '--state-warning': '状态语义色，需保持不透明',
  '--state-error': '状态语义色，需保持不透明',
  '--state-info': '状态语义色，需保持不透明',

  // —— 状态底色薄片：本身就是低 alpha rgba，已是半透明口径 ——
  '--color-error-surface': '状态薄底，本体已是 rgba(...,0.1)',
  '--color-error-surface-hover': '状态薄底，本体已是 rgba(...,0.15)',
  '--color-success-surface': '状态薄底，本体已是 rgba(...,0.1)',
  '--color-warning-surface': '状态薄底，本体已是 rgba(...,0.1)',

  // —— 焦点环：无障碍焦点可见性 ——
  '--color-border-focus': '焦点环边框，跟随 primary 色相，必须不透明',
  '--shadow-focus': '焦点环阴影，primary 派生色环，归入色相类',

  // —— 非颜色数值 token：模糊半径 / 饱和度，不存在 alpha ——
  '--titlebar-blur': '非颜色 token（模糊半径），无 alpha 概念',
  '--titlebar-saturate': '非颜色 token（饱和度），无 alpha 概念',
  '--sidebar-blur': '非颜色 token（模糊半径），无 alpha 概念',
  '--sidebar-saturate': '非颜色 token（饱和度），无 alpha 概念',
  '--sidebar-search-blur': '非颜色 token（模糊半径），无 alpha 概念',
  '--sidebar-search-saturate': '非颜色 token（饱和度），无 alpha 概念',
  '--content-blur': '非颜色 token（模糊半径），无 alpha 概念',
  '--content-saturate': '非颜色 token（饱和度），无 alpha 概念',
  '--card-blur': '非颜色 token（模糊半径），无 alpha 概念',
  '--card-saturate': '非颜色 token（饱和度），无 alpha 概念',

  // —— 别名：跟随文本色，不在此处重复定义 ——
  '--sidebar-count-color': 'var(--color-text-secondary) 的别名，跟随文本色即可',
};

const EXEMPT_NAMES = Object.keys(ELECTRON_DARK_EXEMPT);

/**
 * 白名单形状校验：只允许「纯色相类 / 焦点环 / 非颜色数值 token」的名字进来。
 * 防止有人图省事把 --content-bg、--glass-bg 这类承载面变量塞进白名单绕过守卫。
 */
const EXEMPT_SHAPE_PATTERNS = [
  /^--color-primary(-|$)/,
  /^--color-secondary(-|$)/,
  /^--color-accent(-|$)/,
  /^--state-/,
  /^--color-(error|success|warning)-surface(-|$)/,
  /^--color-border-focus$/,
  /^--shadow-focus$/,
  /-(blur|saturate)$/,
  /^--sidebar-count-color$/,
];

function matchesExemptShape(name) {
  return EXEMPT_SHAPE_PATTERNS.some((re) => re.test(name));
}

/* ============================================================
   3. 值判定工具
   ============================================================ */

/** 提取值里所有 rgba() 的 alpha 分量。 */
function alphaValues(value) {
  const out = [];
  const re = /rgba\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(value)) !== null) {
    const parts = m[1].split(',').map((s) => s.trim());
    if (parts.length === 4) {
      const a = Number.parseFloat(parts[3]);
      if (!Number.isNaN(a)) out.push(a);
    }
  }
  return out;
}

/** 是否含 hex 实色（#rgb / #rrggbb / #rrggbbaa）。 */
function hasHexColor(value) {
  return /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/.test(value);
}

/** 是否半透明：至少一个 rgba、所有 alpha 都 < 1、且不含 hex 实色。 */
function isTranslucent(value) {
  const alphas = alphaValues(value);
  if (alphas.length === 0) return false;
  if (hasHexColor(value)) return false;
  return alphas.every((a) => a >= 0 && a < 1);
}

/* ============================================================
   4. 用例
   ============================================================ */

describe('T39 · Electron 深色变量守卫（themeParity）', () => {
  describe('A · 解析 sanity：四个块都要能被静态解析到', () => {
    it('A1 四个块都存在且各自非空', () => {
      for (const [key, sel] of Object.entries(SELECTORS)) {
        const b = blockVars(sel);
        expect(b.blocks.length, `选择器 ${sel} 未找到`).toBeGreaterThan(0);
        expect(b.vars.size, `选择器 ${sel} 无变量`).toBeGreaterThan(0);
        expect(key).toBeTruthy();
      }
    });

    it('A2 :root 是最大的变量池（>100 个），防止解析器只扫到片段', () => {
      expect(ROOT.vars.size).toBeGreaterThan(100);
    });

    it('A3 四个块的变量数都在预期量级（:root>100 / dark>60 / em>=36）', () => {
      expect(ROOT.vars.size).toBeGreaterThan(100);
      expect(DARK.vars.size).toBeGreaterThan(60);
      expect(EM.vars.size).toBeGreaterThanOrEqual(36);
      expect(EM_DARK.vars.size).toBeGreaterThanOrEqual(36);
    });

    it('A4 不存在 @media (prefers-color-scheme: dark)（实测 0 命中，别去找它）', () => {
      expect(cssText).not.toMatch(/prefers-color-scheme/);
    });

        it('A5 源码不含裸 NUL / 裸控制字节', () => {
      // 用转义写法，避免本文件自己出现裸控制字节
      // eslint-disable-next-line no-control-regex
      const ctrlBytes = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
      expect(ctrlBytes.test(cssText), 'src/style.css 含裸控制字节').toBe(false);
      expect(cssText.includes('\u0000'), 'src/style.css 含裸 NUL').toBe(false);
    });

it('A6 .electron-mode 块位于 [data-theme=\'dark\'] 之后（同特异性靠后者胜）', () => {
      const darkStart = DARK.blocks[0].start;
      const emStart = EM.blocks[0].start;
      const emDarkStart = EM_DARK.blocks[0].start;
      expect(emStart).toBeGreaterThan(darkStart);
      expect(emDarkStart).toBeGreaterThan(darkStart);
      expect(emDarkStart).toBeGreaterThan(emStart);
    });
  });

  describe('B · 核心守卫：dark 变量要么两侧都有，要么在白名单里', () => {
    it('B1 每个 [data-theme=\'dark\'] 变量都被覆盖或已登记白名单', () => {
      const missing = [...DARK.vars.keys()].filter(
        (name) => !EM_DARK.vars.has(name) && !EXEMPT_NAMES.includes(name)
      );
      expect(
        missing,
        `以下深色变量既没在 .electron-mode[data-theme='dark'] 里同步，也不在白名单里\n` +
          `缺失 ${missing.length} 个：\n  ${missing.join('\n  ')}\n` +
          `修法：补半透明覆盖，或加进 ELECTRON_DARK_EXEMPT 并写明理由。`
      ).toEqual([]);
    });

    it('B2 .electron-mode[data-theme=\'dark\'] 不引入 dark 里没有的新变量', () => {
      const extra = [...EM_DARK.vars.keys()].filter((name) => !DARK.vars.has(name));
      expect(
        extra,
        `emDark 里有 dark 中不存在的变量（说明 dark 块漏了同步）：${extra.join(', ')}`
      ).toEqual([]);
    });

    it('B3 [data-theme=\'dark\'] 不引入 :root 里没有的新变量', () => {
      const extra = [...DARK.vars.keys()].filter((name) => !ROOT.vars.has(name));
      expect(
        extra,
        `dark 块定义了 :root 里没有的变量（应先在 :root 声明）：${extra.join(', ')}`
      ).toEqual([]);
    });

    it('B4 覆盖数 + 白名单数 === dark 变量总数（账要对得上）', () => {
      const covered = [...DARK.vars.keys()].filter((n) => EM_DARK.vars.has(n)).length;
      const exemptInDark = EXEMPT_NAMES.filter((n) => DARK.vars.has(n)).length;
      expect(covered + exemptInDark).toBe(DARK.vars.size);
    });
  });

  describe('C · 亮/暗对称：.electron-mode 与 .electron-mode[data-theme=\'dark\'] 键集一致', () => {
    it('C1 emDark 的每个键在 em 里也有（暗色不能比亮色多）', () => {
      const onlyDark = [...EM_DARK.vars.keys()].filter((n) => !EM.vars.has(n));
      expect(
        onlyDark,
        `只在暗色 electron 块里出现、亮色没有：${onlyDark.join(', ')}`
      ).toEqual([]);
    });

    it('C2 em 的每个键在 emDark 里也有（亮色不能比暗色多）', () => {
      const onlyLight = [...EM.vars.keys()].filter((n) => !EM_DARK.vars.has(n));
      expect(
        onlyLight,
        `只在亮色 electron 块里出现、暗色没有：${onlyLight.join(', ')}`
      ).toEqual([]);
    });

    it('C3 两个 electron 块变量数相等', () => {
      expect(EM.vars.size).toBe(EM_DARK.vars.size);
    });

    it('C4 .electron-mode 覆盖的变量必须是 :root 已有的（不能凭空造）', () => {
      const extra = [...EM.vars.keys()].filter((n) => !ROOT.vars.has(n));
      expect(extra, `.electron-mode 引入了 :root 没有的变量：${extra.join(', ')}`).toEqual([]);
    });
  });

  describe('D · 白名单卫生', () => {
    it('D1 白名单里的项都没被覆盖 —— 若被覆盖，提示可以从白名单移除', () => {
      const nowCovered = EXEMPT_NAMES.filter((n) => EM_DARK.vars.has(n));
      expect(
        nowCovered,
        `以下变量已经在 .electron-mode[data-theme='dark'] 里覆盖了，可以从 ELECTRON_DARK_EXEMPT 移除：\n  ` +
          nowCovered.join('\n  ')
      ).toEqual([]);
    });

    it('D2 白名单里的项都还真实存在于 [data-theme=\'dark\']（防止条目过期）', () => {
      const stale = EXEMPT_NAMES.filter((n) => !DARK.vars.has(n));
      expect(
        stale,
        `白名单里的变量已不在 [data-theme='dark'] 中，属于过期条目，应删除：${stale.join(', ')}`
      ).toEqual([]);
    });

    it('D3 白名单里的项都存在于 :root（防止拼错变量名）', () => {
      const typo = EXEMPT_NAMES.filter((n) => !ROOT.vars.has(n));
      expect(typo, `白名单变量名拼错或不存在：${typo.join(', ')}`).toEqual([]);
    });

    it('D4 白名单条目形状合法：只允许纯色相 / 焦点环 / 非颜色数值 token', () => {
      const bad = EXEMPT_NAMES.filter((n) => !matchesExemptShape(n));
      expect(
        bad,
        `白名单里出现了承载面类变量，不允许豁免（应改为补半透明覆盖）：${bad.join(', ')}`
      ).toEqual([]);
    });

    it('D5 白名单每条都写了豁免理由（不允许空注释）', () => {
      const noReason = EXEMPT_NAMES.filter((n) => !String(ELECTRON_DARK_EXEMPT[n] || '').trim());
      expect(noReason, `以下白名单条目缺少理由说明：${noReason.join(', ')}`).toEqual([]);
    });

    it('D6 白名单不含重复项', () => {
      expect(new Set(EXEMPT_NAMES).size).toBe(EXEMPT_NAMES.length);
    });
  });

  describe('E · 半透明口径：同步过去的必须是半透明值，否则断层依然存在', () => {
    const covered = [...EM_DARK.vars.keys()];

    it('E1 所有被覆盖的变量都是半透明（含 rgba 且 alpha<1、无 hex 实色）', () => {
      const opaque = covered.filter((n) => !isTranslucent(EM_DARK.vars.get(n)));
      expect(
        opaque,
        `以下变量在 .electron-mode[data-theme='dark'] 里不是半透明值：\n` +
          opaque.map((n) => `  ${n}: ${EM_DARK.vars.get(n)}`).join('\n')
      ).toEqual([]);
    });

    it('E2 亮色 .electron-mode 同样全部半透明', () => {
      const opaque = [...EM.vars.keys()].filter((n) => !isTranslucent(EM.vars.get(n)));
      expect(
        opaque,
        `亮色 .electron-mode 里有非半透明值：\n` +
          opaque.map((n) => `  ${n}: ${EM.vars.get(n)}`).join('\n')
      ).toEqual([]);
    });

    it('E3 抽查 --content-bg：emDark 必须读到半透明值', () => {
      const v = EM_DARK.vars.get('--content-bg');
      expect(v, 'emDark 缺 --content-bg').toBeTruthy();
      expect(isTranslucent(v), `--content-bg = ${v} 不是半透明`).toBe(true);
      expect(alphaValues(v)[0]).toBeLessThan(1);
      expect(alphaValues(v)[0]).toBeGreaterThan(0.5);
    });

    it('E4 抽查 glass 类：--glass-bg / --glass-border 半透明且不是 hex', () => {
      for (const name of ['--glass-bg', '--glass-border']) {
        const v = EM_DARK.vars.get(name);
        expect(v, `emDark 缺 ${name}`).toBeTruthy();
        expect(hasHexColor(v), `${name} = ${v} 含 hex 实色`).toBe(false);
        expect(isTranslucent(v), `${name} = ${v} 不是半透明`).toBe(true);
      }
    });

    it('E5 抽查文本类：text-* / reading-bg 半透明且不是 hex', () => {
      const textVars = [
        '--color-text-primary',
        '--color-text-secondary',
        '--color-text-tertiary',
        '--color-text-inverse',
        '--color-text-on-primary',
        '--color-text-body',
        '--reading-bg',
      ];
      for (const name of textVars) {
        const v = EM_DARK.vars.get(name);
        expect(v, `emDark 缺 ${name}`).toBeTruthy();
        expect(hasHexColor(v), `${name} = ${v} 含 hex 实色`).toBe(false);
        expect(isTranslucent(v), `${name} = ${v} 不是半透明`).toBe(true);
      }
    });

    it('E6 抽查 surface 类：--color-surface-elevated 半透明', () => {
      const v = EM_DARK.vars.get('--color-surface-elevated');
      expect(v, 'emDark 缺 --color-surface-elevated').toBeTruthy();
      expect(isTranslucent(v), `--color-surface-elevated = ${v} 不是半透明`).toBe(true);
    });

    it('E7 shadow 类全部半透明，且 alpha 落在 (0, 1)', () => {
      const shadows = covered.filter((n) => n.includes('shadow'));
      expect(shadows.length).toBeGreaterThanOrEqual(6);
      for (const name of shadows) {
        const alphas = alphaValues(EM_DARK.vars.get(name));
        expect(alphas.length, `${name} 没有 rgba 分量`).toBeGreaterThan(0);
        for (const a of alphas) {
          expect(a, `${name} alpha=${a} 越界`).toBeGreaterThan(0);
          expect(a, `${name} alpha=${a} 越界`).toBeLessThan(1);
        }
      }
    });

    it('E8 主承载面板 alpha 落在亚克力带 0.4~0.95（不透明就不是亚克力、太透就没可读性）', () => {
      // 主面板 = 真正承担「背景」职责的那一层；边框 / 叠加片是低 alpha 的细线，另算。
      const panels = [
        '--color-bg',
        '--color-bg-secondary',
        '--color-bg-tertiary',
        '--color-surface',
        '--color-surface-hover',
        '--color-surface-elevated',
        '--sidebar-bg',
        '--content-bg',
        '--titlebar-bg',
        '--card-bg',
        '--reading-bg',
        '--glass-bg',
      ];
      for (const name of panels) {
        expect(covered, `emDark 缺主面板 ${name}`).toContain(name);
        const alphas = alphaValues(EM_DARK.vars.get(name));
        expect(alphas.length, `${name} 没有 rgba 分量`).toBeGreaterThan(0);
        for (const a of alphas) {
          expect(a, `${name} alpha=${a} 不在 0.4~0.95`).toBeGreaterThanOrEqual(0.4);
          expect(a, `${name} alpha=${a} 不在 0.4~0.95`).toBeLessThanOrEqual(0.95);
        }
      }
    });

    it('E8b 细线/叠加片（*-border、sidebar-search-bg(-hover)、sidebar-count-bg）alpha < 0.5', () => {
      const hairlines = covered.filter(
        (n) =>
          n.endsWith('-border') ||
          /^--sidebar-(search-bg|search-bg-hover|count-bg)$/.test(n)
      );
      expect(hairlines.length).toBeGreaterThanOrEqual(6);
      for (const name of hairlines) {
        const alphas = alphaValues(EM_DARK.vars.get(name));
        expect(alphas.length, `${name} 没有 rgba 分量`).toBeGreaterThan(0);
        for (const a of alphas) {
          expect(a, `${name} alpha=${a} 过实，细线/叠加片不该这么重`).toBeLessThan(0.5);
          expect(a, `${name} alpha=${a} 应为正值`).toBeGreaterThan(0);
        }
      }
    });

    it('E8c 聚焦态（--sidebar-search-bg-focus）要比常态实一些，alpha 落在 0.5~0.95', () => {
      const name = '--sidebar-search-bg-focus';
      expect(covered).toContain(name);
      const alphas = alphaValues(EM_DARK.vars.get(name));
      expect(alphas.length).toBeGreaterThan(0);
      for (const a of alphas) {
        expect(a, `${name} alpha=${a} 不在 0.5~0.95`).toBeGreaterThanOrEqual(0.5);
        expect(a, `${name} alpha=${a} 不在 0.5~0.95`).toBeLessThanOrEqual(0.95);
      }
    });

    it('E9 emDark 的值必须真的和 dark 不同（不是复制粘贴忘了改）', () => {
      const identical = covered.filter(
        (n) => EM_DARK.vars.get(n) === DARK.vars.get(n)
      );
      expect(
        identical,
        `以下变量 emDark 与 dark 取值完全相同，等于没覆盖：${identical.join(', ')}`
      ).toEqual([]);
    });

    it('E10 亮色 em 的值必须真的和 :root 不同（*-border 除外：hairline 可合理一致）', () => {
      const identical = [...EM.vars.keys()].filter(
        (n) => !n.endsWith('-border') && EM.vars.get(n) === ROOT.vars.get(n)
      );
      expect(
        identical,
        `以下变量 .electron-mode 与 :root 取值完全相同，等于没覆盖：${identical.join(', ')}`
      ).toEqual([]);
    });
  });
});
