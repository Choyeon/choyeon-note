<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div 
      class="min-h-[52px] px-6 py-2.5 flex items-center border-b acrylic-content"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <span class="text-2xl font-bold" :style="{ color: 'var(--color-text-primary)' }">图谱</span>
      <div class="flex-1"></div>
      <button 
        class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
        @click="randomize"
      >
        <RefreshCw class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
      </button>
    </div>

    <div class="flex-1 min-h-0 flex overflow-hidden">
      <div class="flex-1 relative acrylic-content" ref="graphContainer">
        <svg class="w-full h-full" :viewBox="viewBox">
          <defs>
            <linearGradient id="lineGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" :style="{ stopColor: 'var(--color-primary)', stopOpacity: 0.1 }" />
              <stop offset="100%" :style="{ stopColor: 'var(--color-primary)', stopOpacity: 0.3 }" />
            </linearGradient>
          </defs>
          
          <g>
            <line 
              v-for="(link, index) in links" 
              :key="index"
              :x1="link.source.x" 
              :y1="link.source.y" 
              :x2="link.target.x" 
              :y2="link.target.y"
              stroke="url(#lineGradient)"
              stroke-width="1"
            />
          </g>

          <g>
            <g 
              v-for="node in nodes" 
              :key="node.id"
              :transform="`translate(${node.x}, ${node.y})`"
              class="cursor-pointer"
              @click="selectNode(node)"
            >
              <circle 
                :r="node.size" 
                :fill="selectedNode === node.id ? 'var(--color-primary)' : 'var(--color-bg-secondary)'"
                :stroke="selectedNode === node.id ? 'var(--color-primary)' : 'var(--color-border)'"
                stroke-width="2"
                class="transition-all duration-300"
              />
              <text 
                v-if="node.size > 8"
                y="4" 
                text-anchor="middle" 
                font-size="11"
                :fill="selectedNode === node.id ? 'white' : 'var(--color-text-secondary)'"
                class="pointer-events-none select-none"
              >{{ node.label.substring(0, node.size > 15 ? 4 : 2) }}</text>
            </g>
          </g>
        </svg>

        <div 
          v-if="selectedNode"
          class="absolute right-6 top-6 acrylic-card p-4 w-64"
        >
          <div class="text-[15px] font-semibold mb-1" :style="{ color: 'var(--color-text-primary)' }">
            {{ selectedNodeData?.title }}
          </div>
          <div class="text-[12px] mb-3" :style="{ color: 'var(--color-text-tertiary)' }">
            {{ selectedNodeData?.folder || '根目录' }}
          </div>
          <div class="text-[12px] mb-3" :style="{ color: 'var(--color-text-secondary)', lineHeight: '1.6' }">
            {{ getPreview(selectedNodeData?.content) }}
          </div>
          <button 
            class="w-full py-2 rounded-lg cursor-pointer transition-colors hover:opacity-90 text-[13px] font-medium text-white"
            :style="{ background: 'var(--color-primary)' }"
            @click="openNote(selectedNode)"
          >打开笔记</button>
        </div>
      </div>

      <aside 
        class="w-[240px] min-w-[240px] h-full acrylic-sidebar flex flex-col overflow-hidden border-l"
        :style="{ borderColor: 'var(--sidebar-border)' }"
      >
        <div 
          class="flex items-center h-11 px-4 border-b"
          :style="{ borderColor: 'var(--color-border)' }"
        >
          <span class="text-[13px] font-medium" :style="{ color: 'var(--color-text-primary)' }">节点</span>
          <div class="flex-1"></div>
          <span class="text-[12px]" :style="{ color: 'var(--color-text-tertiary)' }">{{ nodes.length }}</span>
        </div>
        <div class="flex-1 overflow-y-auto no-scrollbar p-2">
          <div 
            v-for="node in nodes" 
            :key="node.id"
            class="flex items-center gap-2 h-9 px-3 rounded-md cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
            :class="{ 'bg-primary-surface': selectedNode === node.id }"
            @click="selectNode(node)"
          >
            <div 
              class="w-3 h-3 rounded-full flex-shrink-0"
              :style="{ background: selectedNode === node.id ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }"
            ></div>
            <span 
              class="text-[13px] truncate flex-1"
              :style="{ color: selectedNode === node.id ? 'var(--color-primary)' : 'var(--color-text-secondary)' }"
            >{{ node.label }}</span>
          </div>
        </div>
      </aside>
    </div>

    <div 
      class="min-h-7 px-6 py-1 flex items-center border-t"
      :style="{ 
        borderColor: 'var(--color-border-light)', 
        background: 'rgba(240,242,245,0.65)' 
      }"
    >
      <span class="text-[11px] whitespace-nowrap" :style="{ color: 'var(--color-text-primary)' }">
        {{ nodes.length }} 个节点 · {{ links.length }} 条链接
      </span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { RefreshCw } from 'lucide-vue-next'

const router = useRouter()
const noteStore = useNoteStore()

const selectedNode = ref(null)
const graphContainer = ref(null)
const viewBox = ref('0 0 800 600')

const nodes = ref([])
const links = ref([])

const selectedNodeData = computed(() => {
  if (!selectedNode.value) return null
  return noteStore.notes.find(n => n.id === selectedNode.value)
})

function generateGraph() {
  const notes = noteStore.notes
  const width = 800
  const height = 600
  const centerX = width / 2
  const centerY = height / 2

  nodes.value = notes.map((note, index) => {
    const angle = (index / notes.length) * 2 * Math.PI
    const radius = 150 + Math.random() * 100
    const size = 10 + Math.min(note.content.length / 500, 10)
    
    return {
      id: note.id,
      label: note.title,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      size
    }
  })

  links.value = []
  for (let i = 0; i < nodes.value.length; i++) {
    for (let j = i + 1; j < nodes.value.length; j++) {
      if (Math.random() > 0.7) {
        links.value.push({
          source: nodes.value[i],
          target: nodes.value[j]
        })
      }
    }
  }
}

function selectNode(node) {
  selectedNode.value = node.id
}

function openNote(id) {
  noteStore.selectNote(id)
  router.push(`/editor/${id}`)
}

function randomize() {
  generateGraph()
}

function getPreview(content) {
  if (!content) return ''
  const text = content.replace(/[#*`\[\]\-]/g, '').replace(/\n/g, ' ').trim()
  return text.length > 80 ? text.substring(0, 80) + '...' : text
}

onMounted(() => {
  nextTick(() => {
    generateGraph()
    if (graphContainer.value) {
      const rect = graphContainer.value.getBoundingClientRect()
      viewBox.value = `0 0 ${rect.width} ${rect.height}`
    }
  })
})
</script>
