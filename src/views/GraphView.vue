<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div 
      class="min-h-[52px] px-6 py-2.5 flex items-center gap-3 border-b acrylic-content shrink-0"
      :style="{ borderColor: 'var(--color-border)' }"
    >
      <div class="flex items-center gap-2">
        <Network class="w-5 h-5" :style="{ color: 'var(--color-primary)' }" />
        <span class="text-lg font-bold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">知识图谱</span>
      </div>
      <div class="flex-1"></div>
      
      <div class="relative mr-2">
        <Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" :style="{ color: 'var(--color-text-tertiary)' }" />
        <input 
          v-model="searchQuery"
          type="text"
          placeholder="搜索节点..."
          class="w-48 h-8 pl-9 pr-3 rounded-lg text-[12px] outline-none transition-all duration-200"
          :style="{ 
            background: 'var(--color-bg-secondary)', 
            color: 'var(--color-text-primary)',
            border: '1px solid var(--color-border-light)',
          }"
        />
      </div>

      <div class="flex items-center gap-1 px-2 py-1 rounded-lg" :style="{ background: 'var(--color-bg-secondary)' }">
        <button 
          class="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-95"
          title="缩小"
          @click="zoomOut"
        >
          <ZoomOut class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
        <span class="text-[11px] font-mono w-10 text-center font-medium" :style="{ color: 'var(--color-text-secondary)' }">{{ Math.round(scale * 100) }}%</span>
        <button 
          class="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-95"
          title="放大"
          @click="zoomIn"
        >
          <ZoomIn class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
      </div>

      <button 
        class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-95"
        title="重置视图"
        @click="resetView"
      >
        <Maximize2 class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
      </button>

      <button 
        class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-95"
        title="重新布局"
        @click="randomize"
      >
        <RefreshCw class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
      </button>
    </div>

    <div class="flex-1 min-h-0 flex overflow-hidden">
      <div 
        class="flex-1 relative overflow-hidden graph-canvas" 
        ref="graphContainer"
        @mousedown="onCanvasMouseDown"
        @mousemove="onCanvasMouseMove"
        @mouseup="onCanvasMouseUp"
        @mouseleave="onCanvasMouseUp"
        @wheel="onWheel"
        :style="{ cursor: isPanning ? 'grabbing' : 'grab' }"
      >
        <svg class="w-full h-full">
          <defs>
            <radialGradient id="nodeGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" :style="{ stopColor: 'var(--color-primary)', stopOpacity: 0.5 }" />
              <stop offset="100%" :style="{ stopColor: 'var(--color-primary)', stopOpacity: 0 }" />
            </radialGradient>
            
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
              <feMerge>
                <feMergeNode in="coloredBlur"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
          </defs>
          
          <g :transform="`translate(${offsetX}, ${offsetY}) scale(${scale})`">
            <g class="links">
              <line 
                v-for="(link, index) in visibleLinks" 
                :key="'link-'+index"
                :x1="link.source.x" 
                :y1="link.source.y" 
                :x2="link.target.x" 
                :y2="link.target.y"
                :stroke="link.opacity > 0.5 ? 'var(--color-primary)' : 'var(--color-text-tertiary)'"
                :stroke-width="link.opacity > 0.5 ? 1.5 : 1"
                :opacity="link.opacity"
                stroke-linecap="round"
                class="transition-opacity duration-300"
              />
            </g>

            <g class="nodes">
              <g 
                v-for="node in visibleNodes" 
                :key="node.id"
                :transform="`translate(${node.x}, ${node.y})`"
                class="cursor-pointer node-group"
                :class="{ 
                  'node-selected': selectedNode === node.id,
                  'node-dimmed': searchQuery && !node.matches,
                  'node-highlighted': searchQuery && node.matches
                }"
                @click.stop="selectNode(node)"
                @dblclick="openNote(node.id)"
              >
                <circle 
                  :r="node.size + 10" 
                  fill="url(#nodeGlow)"
                  :opacity="selectedNode === node.id ? 0.9 : 0.4"
                  class="transition-opacity duration-300"
                />
                
                <circle 
                  :r="node.size" 
                  :fill="selectedNode === node.id ? 'var(--color-primary)' : 'var(--color-surface)'"
                  :stroke="selectedNode === node.id ? 'var(--color-primary)' : 'var(--color-primary)'"
                  :stroke-width="selectedNode === node.id ? 3 : 2"
                  :filter="selectedNode === node.id ? 'url(#glow)' : ''"
                  class="transition-all duration-200"
                />
                
                <text 
                  :y="node.size + 18" 
                  text-anchor="middle" 
                  font-size="12"
                  font-weight="600"
                  :fill="selectedNode === node.id ? 'var(--color-primary)' : 'var(--color-text-primary)'"
                  class="pointer-events-none select-none"
                  style="paint-order: stroke; stroke: var(--color-bg); stroke-width: 3px; stroke-linejoin: round;"
                >
                  {{ node.label.length > 14 ? node.label.substring(0, 14) + '...' : node.label }}
                </text>
              </g>
            </g>
          </g>
        </svg>

        <div 
          v-if="selectedNode && selectedNodeData"
          class="absolute right-5 top-5 w-64 rounded-xl overflow-hidden shadow-lg"
          :style="{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }"
        >
          <div class="px-4 py-3 border-b" :style="{ borderColor: 'var(--color-border-light)' }">
            <div class="flex items-center gap-2">
              <div 
                class="w-2 h-2 rounded-full"
                :style="{ background: 'var(--color-primary)' }"
              ></div>
              <span class="text-[13px] font-semibold truncate" :style="{ color: 'var(--color-text-primary)' }">
                {{ selectedNodeData.title }}
              </span>
            </div>
          </div>
          <div class="px-4 py-3">
            <div class="text-[11px] mb-2 font-medium" :style="{ color: 'var(--color-text-secondary)' }">
              {{ selectedNodeData.folder || '根目录' }}
            </div>
            <div class="text-[12px] leading-relaxed mb-3 line-clamp-3" :style="{ color: 'var(--color-text-secondary)' }">
              {{ getPreview(selectedNodeData.content) }}
            </div>
            <div class="flex items-center gap-2 mb-3">
              <div class="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium" :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }">
                <FileText class="w-3 h-3" />
                <span>{{ Math.round(selectedNodeData.content.length / 100) * 100 }} 字</span>
              </div>
              <div class="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium" :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }">
                <Link2 class="w-3 h-3" />
                <span>{{ getLinkCount(selectedNode.id) }} 链接</span>
              </div>
            </div>
            <button 
              class="w-full py-2 rounded-lg cursor-pointer transition-all duration-200 hover:opacity-90 active:scale-[0.98] text-[12px] font-medium text-white"
              :style="{ background: 'var(--color-primary)' }"
              @click="openNote(selectedNode)"
            >
              打开笔记
            </button>
          </div>
        </div>

        <div class="absolute left-5 bottom-5 flex items-center gap-3 px-3 py-2 rounded-lg shadow-sm" :style="{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }">
          <div class="flex items-center gap-1.5">
            <div class="w-2.5 h-2.5 rounded-full" :style="{ background: 'var(--color-primary)' }"></div>
            <span class="text-[11px] font-medium" :style="{ color: 'var(--color-text-secondary)' }">{{ visibleNodes.length }} 节点</span>
          </div>
          <div class="w-px h-3" :style="{ background: 'var(--color-border)' }"></div>
          <div class="flex items-center gap-1.5">
            <div class="w-2.5 h-2.5 rounded-full" :style="{ background: 'var(--color-text-tertiary)' }"></div>
            <span class="text-[11px] font-medium" :style="{ color: 'var(--color-text-secondary)' }">{{ visibleLinks.length }} 链接</span>
          </div>
        </div>
      </div>

      <aside 
        class="w-[260px] min-w-[260px] h-full acrylic-sidebar flex flex-col overflow-hidden border-l"
        :style="{ borderColor: 'var(--sidebar-border)' }"
      >
        <div 
          class="flex items-center h-12 px-4 border-b"
          :style="{ borderColor: 'var(--color-border)' }"
        >
          <span class="text-[13px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">节点列表</span>
          <div class="flex-1"></div>
          <span class="text-[11px] px-2 py-0.5 rounded-full font-medium" :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }">{{ nodes.length }}</span>
        </div>
        <div class="flex-1 overflow-y-auto cho-scrollbar p-2">
          <div 
            v-for="node in sortedNodes" 
            :key="node.id"
            class="flex items-center gap-2.5 h-10 px-3 rounded-lg cursor-pointer transition-all duration-150 hover:bg-[var(--color-surface-hover)]"
            :class="{ 'node-list-selected': selectedNode === node.id }"
            @click="focusNode(node)"
          >
            <div 
              class="w-2.5 h-2.5 rounded-full flex-shrink-0"
              :style="{ background: selectedNode === node.id ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }"
            ></div>
            <span 
              class="text-[13px] truncate flex-1 font-medium"
              :style="{ color: selectedNode === node.id ? 'var(--color-primary)' : 'var(--color-text-primary)' }"
            >{{ node.label }}</span>
          </div>
        </div>
      </aside>
    </div>

    <div class="cho-statusbar justify-between">
      <span class="cho-statusbar-hint">
        点击节点跳转笔记 · 滚轮缩放 · 拖拽画布平移
      </span>
      <span class="cho-statusbar-meta">
        {{ nodes.length }} 节点 · {{ links.length }} 链接
      </span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { 
  RefreshCw, ZoomIn, ZoomOut, Maximize2, Search, 
  Network, FileText, Link2 
} from 'lucide-vue-next'

const router = useRouter()
const noteStore = useNoteStore()

const selectedNode = ref(null)
const graphContainer = ref(null)
const searchQuery = ref('')

const nodes = ref([])
const links = ref([])

const scale = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)

const isPanning = ref(false)
const lastMousePos = ref({ x: 0, y: 0 })

let animationFrame = null
let simulationRunning = false

const selectedNodeData = computed(() => {
  if (!selectedNode.value) return null
  return noteStore.notes.find(n => n.id === selectedNode.value)
})

const visibleNodes = computed(() => {
  if (!searchQuery.value.trim()) {
    return nodes.value.map(n => ({ ...n, matches: true }))
  }
  const query = searchQuery.value.toLowerCase()
  return nodes.value.map(n => ({
    ...n,
    matches: n.label.toLowerCase().includes(query)
  }))
})

const visibleLinks = computed(() => {
  if (!searchQuery.value.trim()) {
    return links.value.map(l => ({ ...l, opacity: 0.6 }))
  }
  
  const highlightedIds = new Set(
    visibleNodes.value.filter(n => n.matches).map(n => n.id)
  )
  
  return links.value.map(l => {
    const sourceMatch = highlightedIds.has(l.source.id)
    const targetMatch = highlightedIds.has(l.target.id)
    const bothMatch = sourceMatch && targetMatch
    return {
      ...l,
      opacity: bothMatch ? 0.9 : (sourceMatch || targetMatch ? 0.3 : 0.1)
    }
  })
})

const sortedNodes = computed(() => {
  return [...nodes.value].sort((a, b) => {
    if (selectedNode.value === a.id) return -1
    if (selectedNode.value === b.id) return 1
    return b.size - a.size
  })
})

function generateGraph() {
  const notes = noteStore.notes
  if (!graphContainer.value) return
  
  const rect = graphContainer.value.getBoundingClientRect()
  const width = rect.width / scale.value
  const height = rect.height / scale.value
  const centerX = width / 2
  const centerY = height / 2

  nodes.value = notes.map((note, index) => {
    const angle = (index / notes.length) * 2 * Math.PI + Math.random() * 0.3
    const radius = 120 + Math.random() * 80
    const size = 8 + Math.min(note.content.length / 300, 12)
    
    return {
      id: note.id,
      label: note.title,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      size
    }
  })

  links.value = []
  for (let i = 0; i < nodes.value.length; i++) {
    for (let j = i + 1; j < nodes.value.length; j++) {
      if (Math.random() > 0.75) {
        links.value.push({
          source: nodes.value[i],
          target: nodes.value[j]
        })
      }
    }
  }

  offsetX.value = rect.width / 2 - centerX * scale.value
  offsetY.value = rect.height / 2 - centerY * scale.value
}

function startSimulation() {
  if (simulationRunning) return
  simulationRunning = true
  
  function tick() {
    const repulsionStrength = 2000
    const attractionStrength = 0.01
    const centerStrength = 0.02
    const damping = 0.9
    
    if (!graphContainer.value) {
      simulationRunning = false
      return
    }
    
    const rect = graphContainer.value.getBoundingClientRect()
    const centerX = rect.width / 2 / scale.value - offsetX.value / scale.value
    const centerY = rect.height / 2 / scale.value - offsetY.value / scale.value

    for (let i = 0; i < nodes.value.length; i++) {
      for (let j = i + 1; j < nodes.value.length; j++) {
        const dx = nodes.value[j].x - nodes.value[i].x
        const dy = nodes.value[j].y - nodes.value[i].y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const force = repulsionStrength / (dist * dist)
        
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        
        nodes.value[i].vx -= fx
        nodes.value[i].vy -= fy
        nodes.value[j].vx += fx
        nodes.value[j].vy += fy
      }
    }

    for (const link of links.value) {
      const dx = link.target.x - link.source.x
      const dy = link.target.y - link.source.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const force = (dist - 150) * attractionStrength
      
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      
      link.source.vx += fx
      link.source.vy += fy
      link.target.vx -= fx
      link.target.vy -= fy
    }

    for (const node of nodes.value) {
      node.vx += (centerX - node.x) * centerStrength
      node.vy += (centerY - node.y) * centerStrength
      
      node.vx *= damping
      node.vy *= damping
      
      node.x += node.vx
      node.y += node.vy
    }

    let maxVelocity = 0
    for (const node of nodes.value) {
      maxVelocity = Math.max(maxVelocity, Math.abs(node.vx), Math.abs(node.vy))
    }

    if (maxVelocity > 0.1) {
      animationFrame = requestAnimationFrame(tick)
    } else {
      simulationRunning = false
    }
  }
  
  tick()
}

function selectNode(node) {
  selectedNode.value = selectedNode.value === node.id ? null : node.id
}

function focusNode(node) {
  selectedNode.value = node.id
  
  if (!graphContainer.value) return
  const rect = graphContainer.value.getBoundingClientRect()
  const targetX = rect.width / 2 - node.x * scale.value
  const targetY = rect.height / 2 - node.y * scale.value
  
  const startX = offsetX.value
  const startY = offsetY.value
  const duration = 300
  const startTime = performance.now()
  
  function animate(currentTime) {
    const elapsed = currentTime - startTime
    const progress = Math.min(elapsed / duration, 1)
    const ease = 1 - Math.pow(1 - progress, 3)
    
    offsetX.value = startX + (targetX - startX) * ease
    offsetY.value = startY + (targetY - startY) * ease
    
    if (progress < 1) {
      requestAnimationFrame(animate)
    }
  }
  
  requestAnimationFrame(animate)
}

function openNote(id) {
  noteStore.selectNote(id)
  router.push(`/editor/${id}`)
}

function getLinkCount(nodeId) {
  return links.value.filter(l => l.source.id === nodeId || l.target.id === nodeId).length
}

function randomize() {
  generateGraph()
  startSimulation()
}

function zoomIn() {
  scale.value = Math.min(scale.value * 1.2, 3)
}

function zoomOut() {
  scale.value = Math.max(scale.value / 1.2, 0.3)
}

function resetView() {
  if (!graphContainer.value) return
  const rect = graphContainer.value.getBoundingClientRect()
  
  scale.value = 1
  
  const centerX = nodes.value.reduce((sum, n) => sum + n.x, 0) / nodes.value.length || rect.width / 2
  const centerY = nodes.value.reduce((sum, n) => sum + n.y, 0) / nodes.value.length || rect.height / 2
  
  offsetX.value = rect.width / 2 - centerX
  offsetY.value = rect.height / 2 - centerY
}

function onWheel(e) {
  e.preventDefault()
  const delta = e.deltaY > 0 ? 0.9 : 1.1
  const newScale = Math.max(0.3, Math.min(3, scale.value * delta))
  
  if (!graphContainer.value) return
  const rect = graphContainer.value.getBoundingClientRect()
  const mouseX = e.clientX - rect.left
  const mouseY = e.clientY - rect.top
  
  const graphX = (mouseX - offsetX.value) / scale.value
  const graphY = (mouseY - offsetY.value) / scale.value
  
  scale.value = newScale
  offsetX.value = mouseX - graphX * newScale
  offsetY.value = mouseY - graphY * newScale
}

function onCanvasMouseDown(e) {
  if (e.button !== 0) return
  isPanning.value = true
  lastMousePos.value = { x: e.clientX, y: e.clientY }
}

function onCanvasMouseMove(e) {
  if (isPanning.value) {
    const dx = e.clientX - lastMousePos.value.x
    const dy = e.clientY - lastMousePos.value.y
    offsetX.value += dx
    offsetY.value += dy
    lastMousePos.value = { x: e.clientX, y: e.clientY }
  }
}

function onCanvasMouseUp() {
  isPanning.value = false
}

function getPreview(content) {
  if (!content) return ''
  const text = content.replace(/[#*`\[\]\-]/g, '').replace(/\n/g, ' ').trim()
  return text.length > 100 ? text.substring(0, 100) + '...' : text
}

watch(searchQuery, () => {})

onMounted(() => {
  nextTick(() => {
    generateGraph()
    startSimulation()
  })
  
  window.addEventListener('mouseup', onCanvasMouseUp)
})

onUnmounted(() => {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame)
  }
  simulationRunning = false
  window.removeEventListener('mouseup', onCanvasMouseUp)
})
</script>

<style scoped>
.graph-canvas {
  background: var(--color-bg-secondary);
  background-image: 
    radial-gradient(circle at 1px 1px, var(--color-border) 1px, transparent 0);
  background-size: 24px 24px;
}

.node-group circle {
  transition: r 0.2s ease, fill 0.2s ease, stroke 0.2s ease;
}

.node-group:hover circle {
  filter: url(#glow);
}

.node-selected circle {
  filter: url(#glow);
}

.node-dimmed {
  opacity: 0.25;
  transition: opacity 0.3s ease;
}

.node-highlighted {
  opacity: 1;
}

.node-list-selected {
  background: var(--color-primary-lighter);
}

.line-clamp-3 {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
