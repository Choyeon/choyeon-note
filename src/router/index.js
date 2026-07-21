import { createRouter, createWebHashHistory } from 'vue-router'

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
  const notesLocation = localStorage.getItem('choyeon-notes-location')

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
