/**
 * 侧边栏改版 · QA 回归闸门（严过关）
 *
 * 与 tests/sidebarChrome.test.js 的分工：那边守「结构事实」（收起按钮位置、窄栏
 * 形态、几何账），这边守「**改了但不一定生效**」的那半边 —— 也就是级联层面和
 * 行为层面的东西：
 *
 *   ① 全局 style.css 与组件 <style scoped> 各写一份同款规则时，谁赢由
 *      特异性 / !important 决定，**不是**由「谁写在后面」决定。本批把选中态
 *      统一成 12% 底色，但 style.css 里躺着两条带 !important 的旧规则，
 *      组件里那份 12% 根本打不过（写了等于没写）。这类 bug 渲染出来肉眼能看见，
 *      但源码里看不出，只能靠闸门钉住「全局那份不许再压组件」。
 *   ② 行内新增的删除入口必须先确认、确认后才能真删 —— 这是行为，得真挂载。
 *
 * 断言口径与 sidebarChrome.test.js 一致：能真挂载的一律真挂载（DOM 父子/CSS 级联
 * 靠字符串证不到），只能查源码的才用源文本。
 */

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, nextTick } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import Sidebar from '../src/components/Sidebar.vue'
import { useNoteStore } from '../src/stores/note'

const PROJECT_ROOT = process.cwd()

/**
 * 读源码文本。
 * @param {string} rel 相对项目根目录的路径
 * @returns {string} 文件全文
 */
function readSrc (rel) {
  return readFileSync(resolve(PROJECT_ROOT, rel.replace(/^\//, '')), 'utf8')
}

let app = null
let host = null

/**
 * 造一条根级笔记。
 * @param {string} id 笔记 id
 * @param {string} title 标题
 * @returns {object} 笔记对象
 */
function makeNote (id, title) {
  return {
    id,
    title,
    folder: '',
    content: '',
    tags: [],
    filePath: null,
    createdAt: 1,
    updatedAt: 1
  }
}

/**
 * 真挂载侧边栏并塞一条根级笔记。
 * @returns {Promise<{host: HTMLElement, noteStore: object}>}
 */
async function mountSidebar () {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/search', component: { template: '<div />' } },
      { path: '/editor/:id', component: { template: '<div />' } }
    ]
  })
  host = document.createElement('div')
  document.body.appendChild(host)

  const noteStore = useNoteStore()
  noteStore.notes.length = 0
  noteStore.notes.push(makeNote('n1', '根级笔记一'))

  app = createApp(Sidebar)
  app.use(pinia)
  app.use(router)
  await router.push('/')
  await router.isReady()
  app.mount(host)
  await nextTick()
  return { host, noteStore }
}

/** 把挂起的微任务 + 一个宏任务都跑完（弹窗 resolve 后的 await 链要用） */
async function flush () {
  await nextTick()
  await new Promise(r => setTimeout(r, 0))
  await nextTick()
}

afterEach(() => {
  if (app) {
    app.unmount()
    app = null
  }
  if (host) {
    host.remove()
    host = null
  }
  // PromptDialog 是 Teleport 到 body 的：卸载后必须确认没留下孤儿节点，
  // 否则下一个用例会 query 到上一个用例的弹窗（假绿）。
  document.body.querySelectorAll('.pd-panel').forEach(n => n.closest('.pd-backdrop')?.remove())
})

describe('侧边栏 · 行内「移到废纸篓」入口（真挂载）', () => {
  it('点删除按钮先弹确认框：危险色 + 标题「删除笔记」+ 正文含标题与回收站口径', async () => {
    await mountSidebar()
    const trashBtn = Array.from(host.querySelectorAll('.tree-note .row-actions button'))
      .find(b => b.getAttribute('title') === '移到废纸篓')
    expect(trashBtn, '找不到行内删除按钮').toBeTruthy()

    trashBtn.click()
    await flush()

    const panel = document.body.querySelector('.pd-panel')
    expect(panel, '点删除按钮没有弹确认框 —— 误点成本极高的破坏性操作必须拦一道').toBeTruthy()
    expect(panel.querySelector('.pd-title').textContent).toBe('删除笔记')
    const msg = panel.querySelector('.pd-message').textContent
    expect(msg).toContain('根级笔记一')
    // 文案必须与真实行为一致：deleteNote → 回收站（可找回），不是物理删除
    expect(msg).toContain('回收站')
    expect(msg).toContain('找回')
    expect(panel.querySelector('.pd-btn--danger'), '确认按钮必须是危险色').toBeTruthy()
  })

  it('确认框点取消 → 笔记还在（不能先删后问）', async () => {
    const { noteStore } = await mountSidebar()
    const trashBtn = Array.from(host.querySelectorAll('.tree-note .row-actions button'))
      .find(b => b.getAttribute('title') === '移到废纸篓')
    trashBtn.click()
    await flush()

    document.body.querySelector('.pd-panel .pd-btn--ghost').click()
    await flush()

    expect(noteStore.notes.map(n => n.id)).toContain('n1')
  })

  it('确认框点删除 → 笔记真的从库里移除', async () => {
    const { noteStore } = await mountSidebar()
    const trashBtn = Array.from(host.querySelectorAll('.tree-note .row-actions button'))
      .find(b => b.getAttribute('title') === '移到废纸篓')
    trashBtn.click()
    await flush()

    document.body.querySelector('.pd-panel .pd-btn--danger').click()
    await flush()

    expect(noteStore.notes.map(n => n.id)).not.toContain('n1')
  })
})

describe('侧边栏 · 行内重命名与操作区互斥（真挂载）', () => {
  it('点重命名 → 标题换成输入框，且操作区整块不渲染（编辑时不挂一排按钮）', async () => {
    await mountSidebar()
    const renameBtn = Array.from(host.querySelectorAll('.tree-note .row-actions button'))
      .find(b => b.getAttribute('title') === '重命名')
    expect(renameBtn).toBeTruthy()

    renameBtn.click()
    await nextTick()

    const row = host.querySelector('.tree-note')
    expect(row.querySelector('input'), '进入重命名后应有输入框').toBeTruthy()
    expect(row.querySelectorAll('.row-actions').length, '编辑态不该再挂操作按钮（既挤又容易误点）').toBe(0)
  })
})

describe('侧边栏 · 选中底色的唯一真源（源文本级联闸门）', () => {
  it('五个选中态用同一个 12% 表达式（Sidebar 三处 + FolderNode 两处）', () => {
    const sidebarSrc = readSrc('src/components/Sidebar.vue')
    const folderSrc = readSrc('src/components/FolderNode.vue')
    const EXPR = 'background: color-mix(in srgb, var(--color-primary) 12%, transparent)'

    // Sidebar：nav-item / tree-note / root-folder-row 三条
    const sidebarHits = sidebarSrc.split(EXPR).length - 1
    expect(sidebarHits, 'Sidebar 里应有 3 条 12% 选中底色').toBeGreaterThanOrEqual(3)
    expect(folderSrc, 'FolderNode 的选中底色也要是同一条表达式').toContain(EXPR)
    // 顺带钉住：不许再混进 8% 的旧写法（--color-primary-surface 浅色模式就是 8%）
    expect(sidebarSrc).not.toContain('color-mix(in srgb, var(--color-primary) 8%, transparent)')
  })

  it('style.css 不再定义 .nav-item 规则（选中态唯一真源在组件 scoped 里）', () => {
    const styleSrc = readSrc('src/style.css')
    // scoped 选择器多一个 [data-v-xxx] 属性 → 特异性天然更高，全局那份是死规则。
    // 留着它的代价不是「多几行」，是下次改选中态的人会在两个文件里各改一处、
    // 改完发现只生效一半。
    expect(/\.nav-item\b/.test(styleSrc),
      'style.css 里还有 .nav-item 规则：它与 Sidebar.vue 的 scoped 规则重复，' +
      '且被 scoped 完全覆盖（死规则）。nav-item 只在 Sidebar.vue 使用，应就地删除。').toBe(false)
  })

  it('style.css 不再定义 folder-row/note-row 的选中底色（唯一真源是 FolderNode scoped）', () => {
    const styleSrc = readSrc('src/style.css')
    const rule = styleSrc.match(/\.folder-row\.is-selected[\s\S]{0,120}?\{[^}]*\}/) ||
      styleSrc.match(/\.note-row\.is-selected[\s\S]{0,120}?\{[^}]*\}/)
    // ① 首选：全局那份压根不该存在（它和 FolderNode.vue 的 scoped 规则重复）
    if (!rule) {
      expect(/.folder-row\.is-selected\s*\{[^}]*background/.test(styleSrc)).toBe(false)
      expect(/.note-row\.is-selected\s*\{[^}]*background/.test(styleSrc)).toBe(false)
      return
    }
    // ② 兜底：万一将来有人把全局那份加回来，也绝不许带 !important ——
    //    它是级联里的最后手段，会连组件 scoped 那份新规则一起压死，
    //    本批「统一选中态」的改动在这两处会等于没生效。
    expect(/!important/.test(rule[0]),
      '这条 !important 会把 FolderNode.vue scoped 的 12% 选中底色整个压掉').toBe(false)
  })
})

describe('侧边栏 · 长标题 truncate 不被操作区破坏（源文本）', () => {
  it('.row-actions 不用 absolute，标题三件套齐全，操作区 shrink-0', () => {
    const sidebarSrc = readSrc('src/components/Sidebar.vue')
    const rowBlock = sidebarSrc.slice(
      sidebarSrc.indexOf('class="tree-note group'),
      sidebarSrc.indexOf('<!-- before/after indicator -->')
    )
    // ① 操作区一旦 absolute 就会浮在标题上，长标题直接被盖掉一截
    expect(/class="row-actions[^"]*"/.exec(rowBlock)[0]).not.toContain('absolute')
    // ② 标题必须有 nowrap + overflow-hidden + ellipsis 三件套，缺一个就不截断
    expect(rowBlock).toContain('whitespace-nowrap')
    expect(rowBlock).toContain('overflow-hidden')
    expect(rowBlock).toContain('text-ellipsis')
    // ③ 操作区必须在正常流里占位（shrink-0），否则会被 flex 压扁
    expect(/class="row-actions[^"]*"/.exec(rowBlock)[0]).toContain('shrink-0')
  })

  it('导航项标题自带显式字重，挡住全局 font-weight:600 的继承（不横向抖动）', () => {
    const sidebarSrc = readSrc('src/components/Sidebar.vue')
    const navBlock = sidebarSrc.slice(
      sidebarSrc.indexOf('class="nav-item'),
      sidebarSrc.indexOf('class="sidebar-section-title mt-4')
    )
    // 全局 .nav-item.is-active 曾经带 font-weight:600；子元素若没有自己的字重
    // 声明就会继承它 → 切换导航项时文字变粗、宽度变化 → 横向抖动。
    // 标题 span 自带 font-medium(500)，继承被自己的声明挡掉，抖动不成立。
    expect(navBlock).toContain('font-medium')
  })
})

describe('侧边栏 · 删除口径一致（源文本）', () => {
  it('删除失败不得上报成功：失败分支先 return，成功上报在其后', () => {
    const sidebarSrc = readSrc('src/components/Sidebar.vue')
    const fn = sidebarSrc.slice(
      sidebarSrc.indexOf('async function deleteNoteAndReport'),
      sidebarSrc.indexOf('async function requestDeleteRootNote')
    )
    expect(fn).toContain('lastDeleteError')
    const failIdx = fn.indexOf('if (reason)')
    const okIdx = fn.indexOf('reportTrashMethodIfKnown')
    expect(failIdx, '缺失败分支').toBeGreaterThan(-1)
    expect(okIdx, '缺成功上报').toBeGreaterThan(-1)
    expect(okIdx, '成功上报必须排在失败分支之后，失败分支里要直接 return').toBeGreaterThan(failIdx)
    expect(/if \(reason\)[\s\S]{0,800}?return/.test(fn), '失败分支没有 return → 会走下去上报成功').toBe(true)
  })

  it('两条删除入口（行内按钮 / 右键菜单）口径一致：confirm + danger + 回收站文案', () => {
    const sidebarSrc = readSrc('src/components/Sidebar.vue')
    const req = sidebarSrc.slice(
      sidebarSrc.indexOf('async function requestDeleteRootNote'),
      sidebarSrc.indexOf('async function deleteFolderWithNotice')
    )
    const menu = sidebarSrc.slice(
      sidebarSrc.indexOf('async function deleteItemHere'),
      sidebarSrc.indexOf('// ============= 递归组件事件接收器')
    )
    ;[req, menu].forEach((src, i) => {
      const who = i === 0 ? '行内删除按钮' : '右键菜单删除'
      expect(src, `${who}：缺 mode:'confirm'`).toContain("mode: 'confirm'")
      expect(src, `${who}：缺 danger:true`).toContain('danger: true')
      expect(src, `${who}：文案与真实行为不符（应说明进回收站、可找回）`).toContain('回收站')
      expect(src, `${who}：文案与真实行为不符（应说明可找回）`).toContain('找回')
      expect(src, `${who}：取消后必须直接 return`).toContain('if (!ok) return')
      expect(src, `${who}：必须复用同一个 deleteNoteAndReport`).toContain('deleteNoteAndReport(')
    })
  })
})

describe('侧边栏 · 收起态窄栏在关闭毛玻璃时不塌（源文本）', () => {
  it('窄栏用的三个 token 在 [data-glass="false"] 下都有定义', () => {
    const styleSrc = readSrc('src/style.css')
    const appSrc = readSrc('src/App.vue')

    const railRule = appSrc.match(/\.sidebar-rail\s*\{[^}]*\}/)
    expect(railRule, '找不到 .sidebar-rail 规则').toBeTruthy()
    ;['--sidebar-bg', '--sidebar-blur', '--sidebar-saturate'].forEach(token => {
      expect(railRule[0], `.sidebar-rail 应该用到 ${token}`).toContain(token)
    })

    // 关闭毛玻璃时这三个 token 必须有值：否则 blur(undefined) 整条声明失效，
    // 而 --sidebar-bg 若为空则窄栏直接塌成透明 —— 按钮悬在空白里。
    const glassOff = styleSrc.match(/\[data-glass='false'\]\s*\{[\s\S]*?\}/)
    expect(glassOff, '找不到 [data-glass=false] 的 token 覆盖块').toBeTruthy()
    ;['--sidebar-bg', '--sidebar-blur', '--sidebar-saturate'].forEach(token => {
      expect(glassOff[0], `[data-glass=false] 缺 ${token} 的定义`).toContain(token)
    })
    // 实色模式下 blur 必须是 0px（不是空），饱和 100%
    expect(/--sidebar-blur:\s*0px/.test(glassOff[0])).toBe(true)
    expect(/--sidebar-bg:\s*var\(--color-surface\)/.test(glassOff[0])).toBe(true)
  })

  it('窄栏与展开态侧边栏用同一组 token（同一块面板两种形态，不是两种质感）', () => {
    const styleSrc = readSrc('src/style.css')
    const appSrc = readSrc('src/App.vue')
    const acrylic = styleSrc.match(/\.acrylic-sidebar\s*\{[^}]*\}/)
    const rail = appSrc.match(/\.sidebar-rail\s*\{[^}]*\}/)
    expect(acrylic, '找不到 .acrylic-sidebar').toBeTruthy()
    expect(acrylic[0]).toContain('var(--sidebar-bg)')
    expect(rail[0]).toContain('var(--sidebar-bg)')
    expect(acrylic[0]).toContain('backdrop-filter')
    expect(rail[0]).toContain('backdrop-filter')
  })
})
