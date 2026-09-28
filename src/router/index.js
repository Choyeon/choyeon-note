import { createRouter, createWebHashHistory } from 'vue-router'
// localStorage key 的唯一来源。守卫判定的「有没有选过笔记库」与 App.vue 启动加载、
// WelcomeView 首次选库写的是同一个键，三处必须同出一源 —— 抄三份字面量迟早漂移，
// 而这里漂移的后果是「守卫读不到 → 永远跳回欢迎页 / 或放行到空白笔记列表」。
// 注意：LS_KEYS.notesLocation 的字符串值本身是线上历史 key，禁止修改。
import { LS_KEYS } from '@/constants/storage'

const routes = [
  {
    path: '/',
    name: 'welcome',
    component: () => import('@/views/WelcomeView.vue'),
    meta: { showSidebar: false }
  },
  {
    path: '/editor/:id?',
    name: 'editor',
    component: () => import('@/views/EditorView.vue')
  },
  {
    path: '/notes',
    name: 'notes',
    component: () => import('@/views/NotesListView.vue')
  },
  {
    path: '/calendar',
    name: 'calendar',
    component: () => import('@/views/CalendarView.vue')
  },
  {
    path: '/graph',
    name: 'graph',
    component: () => import('@/views/GraphView.vue')
  },
  {
    path: '/tags',
    name: 'tags',
    component: () => import('@/views/TagsView.vue')
  },
  {
    path: '/vault',
    name: 'vault',
    component: () => import('@/views/VaultView.vue')
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue')
  },
  {
    path: '/search',
    name: 'search',
    component: () => import('@/views/SearchView.vue')
  },
  {
    // T28 ·「最近删除」。
    // 放在通配 not-found 之前（数组顺序 = 匹配优先级），否则 /trash 会掉进
    // NotFound —— 那种故障的表现是「侧边栏点了没反应 / 白屏」，很难联想到路由。
    path: '/trash',
    name: 'trash',
    component: () => import('@/views/TrashView.vue')
  },
  {
    path: '/reading/:id',
    name: 'reading',
    component: () => import('@/views/ReadingView.vue')
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFound.vue')
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

router.beforeEach((to, from, next) => {
  const notesLocation = localStorage.getItem(LS_KEYS.notesLocation)

  if (to.name === 'welcome') {
    notesLocation ? next({ name: 'notes' }) : next()
    return
  }

  if (!notesLocation) {
    next({ name: 'welcome' })
    return
  }

  next()
})

export default router
