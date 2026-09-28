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
          class="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-all duration-200 active:scale-95"
          :class="viewMode === 'global' ? 'bg-[var(--color-primary)] text-white' : 'hover:bg-[var(--color-surface-hover)]'"
          title="全局视图"
          @click="viewMode = 'global'"
        >
          <Globe class="w-4 h-4" />
        </button>
        <button 
          class="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-all duration-200 active:scale-95"
          :class="viewMode === 'local' ? 'bg-[var(--color-primary)] text-white' : 'hover:bg-[var(--color-surface-hover)]'"
          :style="{ color: viewMode === 'local' ? 'white' : 'var(--color-text-secondary)' }"
          title="局部视图"
          @click="viewMode = 'local'"
        >
          <Focus class="w-4 h-4" />
        </button>
      </div>

      <!--
        R-G1「只看双链」开关：linkMode = all | wiki-only。
        用户最痛的诉求就是「关系图里看不到自己写的 [[双链]]」——相似度边太多会把
        手写链接淹没，所以必须能一键把相似度/标签边全部关掉，只留 wiki 边。
      -->
      <div class="flex items-center gap-1 px-2 py-1 rounded-lg" :style="{ background: 'var(--color-bg-secondary)' }">
        <button
          class="h-7 px-2 rounded-md flex items-center gap-1 cursor-pointer transition-all duration-200 active:scale-95 text-[11px] font-medium"
          :class="linkMode === LINK_MODES.ALL ? 'bg-[var(--color-primary)] text-white' : 'hover:bg-[var(--color-surface-hover)]'"
          :style="{ color: linkMode === LINK_MODES.ALL ? 'white' : 'var(--color-text-secondary)' }"
          title="全部关系（双链 + 标签 + 相似）"
          @click="linkMode = LINK_MODES.ALL"
        >
          <GitBranch class="w-3.5 h-3.5" />
          <span>全部</span>
        </button>
        <button
          class="h-7 px-2 rounded-md flex items-center gap-1 cursor-pointer transition-all duration-200 active:scale-95 text-[11px] font-medium"
          :class="linkMode === LINK_MODES.WIKI_ONLY ? 'bg-[var(--color-primary)] text-white' : 'hover:bg-[var(--color-surface-hover)]'"
          :style="{ color: linkMode === LINK_MODES.WIKI_ONLY ? 'white' : 'var(--color-text-secondary)' }"
          title="仅显示双链"
          @click="linkMode = LINK_MODES.WIKI_ONLY"
        >
          <Link2 class="w-3.5 h-3.5" />
          <span>仅双链</span>
        </button>
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

      <!--
        T36 · R-G3：「重新布局」必须真的重排，而不是把存档坐标原样读回来。
        坐标持久化落地之后，单纯再跑一次 generateGraph() 会命中存档分支 ——
        按钮点了跟没点一样。所以这里先清存档 + 换种子（layoutNonce++），
        再跑力导向，收敛后把新结果写回存档。
      -->
      <button 
        class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-95"
        title="重新布局"
        @click="relayout"
      >
        <RefreshCw class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
      </button>

      <!--
        T36：手动定稿。坐标默认是「收敛后 1s 去抖写入」，用户拖完节点如果想
        立刻锁死，点这个按钮直接 flush，不用等去抖窗口。
      -->
      <button 
        class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-95"
        title="保存当前布局"
        @click="saveLayoutNow"
      >
        <Save class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
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
        <div
          v-if="nodes.length === 0"
          class="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none"
        >
          <Network class="w-10 h-10 opacity-30" :style="{ color: 'var(--color-text-tertiary)' }" />
          <span class="text-[13px] font-medium" :style="{ color: 'var(--color-text-tertiary)' }">暂无笔记</span>
          <span class="text-[11px]" :style="{ color: 'var(--color-text-tertiary)' }">创建笔记并添加双链或标签后，这里会生成关系图</span>
        </div>
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
                v-for="link in visibleLinks" 
                :key="link.id"
                :x1="link.source.x" 
                :y1="link.source.y" 
                :x2="link.target.x" 
                :y2="link.target.y"
                :stroke="link.highlighted ? 'var(--color-primary)' : (link.strength > 2 ? 'var(--color-primary)' : (link.strength > 1 ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)'))"
                :stroke-width="link.highlighted ? 2.5 : (link.strength > 2 ? 2 : (link.strength > 1 ? 1.5 : 1))"
                :opacity="link.opacity"
                stroke-linecap="round"
                class="transition-all duration-200"
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
                  'node-dimmed': node.dimmed,
                  'node-highlighted': node.highlighted
                }"
                @mouseenter="hoveredNode = node.id"
                @mouseleave="hoveredNode = null"
                @mousedown.stop="startDragNode(node, $event)"
                @click.stop="selectNode(node)"
                @dblclick="openNote(node.id)"
              >
                <circle 
                  :r="node.size + 12" 
                  :fill="getNodeColor(node)"
                  :opacity="(selectedNode === node.id || hoveredNode === node.id) ? 0.25 : 0"
                  class="transition-opacity duration-200"
                />
                
                <circle 
                  :r="node.size" 
                  :fill="getNodeColor(node)"
                  :stroke="selectedNode === node.id || hoveredNode === node.id ? getNodeColor(node) : 'var(--color-border)'"
                  :stroke-width="selectedNode === node.id || hoveredNode === node.id ? 2.5 : 1.5"
                  class="transition-all duration-200"
                />
                
                <text 
                  :y="node.size + 18" 
                  text-anchor="middle" 
                  font-size="12"
                  font-weight="600"
                  :fill="node.dimmed ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)'"
                  :opacity="node.dimmed ? 0.5 : 1"
                  class="pointer-events-none select-none transition-all duration-200"
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
            <!--
              R-G5 硬要求：双链与相似度**必须分列**，禁止混标成一个数字。
              混标时用户永远无法判断「12」里到底有几条是自己手写的 [[链接]]。

              ⚠️ 注意第一个参数必须是 selectedNode（它存的是**节点 id 字符串**），
              不是 selectedNode.id —— 后者恒为 undefined，会让三个计数永远显示 0。
              这正是整改前「链接 N」一直是 0 的原因。
            -->
            <div class="flex items-center gap-2 mb-3 flex-wrap">
              <div class="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium" :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }">
                <FileText class="w-3 h-3" />
                <span>{{ Math.round(selectedNodeData.content.length / 100) * 100 }} 字</span>
              </div>
              <div class="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium" :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }">
                <Link2 class="w-3 h-3" />
                <span>双链 {{ getLinkCount(selectedNode, EDGE_KINDS.wiki) }}</span>
              </div>
              <div class="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium" :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }">
                <GitBranch class="w-3 h-3" />
                <span>相似 {{ getLinkCount(selectedNode, EDGE_KINDS.similar) }}</span>
              </div>
              <div class="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium" :style="{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }">
                <Tag class="w-3 h-3" />
                <span>标签 {{ getLinkCount(selectedNode, EDGE_KINDS.tag) }}</span>
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
        单击选中 · 双击打开笔记 · 滚轮缩放 · 拖拽画布平移
      </span>
      <span class="cho-statusbar-meta">
        {{ nodes.length }} 节点 · {{ links.length }} 链接（双链 {{ linkStats.wiki }} · 标签 {{ linkStats.tag }} · 相似 {{ linkStats.similar }}）
      </span>
    </div>
  </div>
</template>

<script>
/**
 * T36 · R-G3 / R-G4：图谱布局的「确定性」与「持久化」纯逻辑层。
 * ============================================================================
 * 为什么单独开一个普通 `<script>` 块（而不是全塞进 `<script setup>`）：
 * `<script setup>` 里声明的东西默认不外泄，测试只能靠挂载后的 DOM 反推；
 * 而指纹、种子、存档读写这几件事必须能被**直接单测**——靠挂组件去测
 * 「把笔记换个文件夹指纹变不变」，一是慢（每次 600ms 防抖），二是断言
 * 落在 DOM 上会退化成"看起来没崩"这种自欺式绿灯。
 *
 * 这里只放纯函数与 localStorage 读写，不碰 Vue 响应式，也不依赖组件实例，
 * 因此可以被 `import { ... } from '@/views/GraphView.vue'` 直接取用。
 * 模块级声明对下面的 `<script setup>` 同样可见（编译后同处一个模块作用域）。
 */

import { LS_KEYS } from '@/constants/storage'

/** 存档结构版本。将来改结构就 +1，旧存档自然失效，而不是读坏数据。 */
export const GRAPH_POSITIONS_VERSION = 1

/** 短笔记（≤ 256 码点）直接全量哈希，指纹零误差 */
const CONTENT_HASH_FULL_MAX = 256
/** 长正文的等距采样点数：只采这么多个字符，避免把整篇正文滚一遍 */
const CONTENT_SAMPLE_POINTS = 96

/**
 * FNV-1a 32 位字符串哈希 —— 布局种子的唯一来源。
 *
 * 之前 GraphView 用 `Math.random()` 给节点撒初值，后果是「每次打开图谱
 * 节点位置都不一样」：力导向是混沌系统，初值差一点，收敛结果就完全不同，
 * 用户摆好的图下次打开全乱。改成按 id 派生后，同一个库必然得到同一套初值。
 *
 * 选 FNV-1a 的理由：无依赖、无查表、单次遍历 O(n)，且低位散布够均匀
 * （种子只取 16 位也要保证不同 id 落到不同角度）。
 *
 * @param {unknown} str 任意可字符串化的输入
 * @returns {number} uint32 哈希
 */
export function hashSeed (str) {
  const text = String(str === null || str === undefined ? '' : str)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * 正文指纹：`长度:采样哈希`。
 *
 * 为什么不能只用 `content.length`（R-G4 的第二条）：
 *   把正文里一段字替换成等长的另一段 → 长度不变 → 指纹不变 → 图谱不重建。
 *
 * 为什么又不全量哈希（性能敏感点）：
 *   这个指纹是在 watch 的 getter 里算的，**每敲一个字都会跑一遍全库**。
 *   全量哈希 500 篇 × 10KB = 5M 次 charCodeAt，一次按键 10ms 级卡顿。
 *   所以：短笔记（≤256）全量哈希保证精确；长笔记按头部/中部/尾部等距采
 *   96 个码点，O(1) 开销，能抓住绝大多数「等长改写」（改写通常分布在正文各处）。
 *
 * 已知取舍：恰好只改长文中部、且没落在采样点上的编辑不会被察觉。图谱是
 * 低频重建的视图，这个漏检率换来的按键响应速度是值得的。
 *
 * @param {unknown} content 笔记正文
 * @returns {string} 指纹片段
 */
export function contentFingerprint (content) {
  const text = typeof content === 'string' ? content : ''
  const len = text.length
  if (len <= CONTENT_HASH_FULL_MAX) return `${len}:${hashSeed(text)}`

  let sample = ''
  for (let i = 0; i < CONTENT_SAMPLE_POINTS; i++) {
    const idx = Math.floor((i * (len - 1)) / (CONTENT_SAMPLE_POINTS - 1))
    sample += text.charAt(idx)
  }
  return `${len}:${hashSeed(sample)}`
}

/**
 * 单篇笔记的指纹：`id:title:folder:正文指纹`。
 *
 * folder 进指纹的理由（R-G4 第一条）：把笔记从一个文件夹移到另一个，正文
 * 一个字没变，旧的 `id:title:content.length` 指纹完全不变 → 图谱不重建。
 * 而 folder 在图谱里不是摆设：双链解析的标题索引里有 `folder/title` 这个
 * key，换目录会改变 `[[同名笔记]]` 的解析目标，边集合可能跟着变。
 *
 * @param {Object} note 笔记对象
 * @returns {string} 指纹
 */
export function noteFingerprint (note) {
  const id = note && note.id !== undefined && note.id !== null ? note.id : ''
  const title = note && note.title !== undefined && note.title !== null ? note.title : ''
  const folder = note && note.folder !== undefined && note.folder !== null ? note.folder : ''
  return `${id}:${title}:${folder}:${contentFingerprint(note ? note.content : '')}`
}

/**
 * 全库指纹：驱动「笔记变了就重建图谱」那个 watch。
 * @param {Array<Object>} notes 笔记列表
 * @returns {string} 指纹
 */
export function graphFingerprint (notes) {
  const list = Array.isArray(notes) ? notes : []
  return list.map(noteFingerprint).join('|')
}

/**
 * 图谱结构签名：节点集合 + 边集合的哈希。
 *
 * 用途：判断「存档里那套坐标能不能原样用」。只有节点集合与边集合都没变时，
 * 恢复出来的布局才是已经收敛的状态，可以跳过力导向；否则要拿存档坐标当
 * 热启动初值再跑一遍（比从种子重排收敛快得多）。
 *
 * 边集合排序后哈希：边的遍历顺序取决于内核，不排序会让「同一张图」得到
 * 两个不同签名 —— 那样每次打开都会误判成"图变了"而白跑一次力导向。
 *
 * @param {Array<Object>} nodeList 节点（需 .id）
 * @param {Array<Object>} linkList 边（需 .kind / .source.id / .target.id）
 * @returns {string} 签名
 */
export function graphSignature (nodeList, linkList) {
  const ids = (nodeList || []).map(n => String(n.id)).sort().join('|')
  const edges = (linkList || [])
    .map(l => `${l.kind}>${l.source.id}>${l.target.id}`)
    .sort()
    .join('|')
  return `${hashSeed(ids)}:${hashSeed(edges)}`
}

/**
 * 读取坐标存档。任何异常（无存档 / JSON 损坏 / 版本不符 / 结构不对）一律
 * 返回 null —— 存档坏了最多是回到确定性种子布局，绝不能让图谱打不开。
 *
 * @returns {Object|null} `{ v, sig, savedAt, positions }` 或 null
 */
export function readGraphPositions () {
  try {
    const raw = localStorage.getItem(LS_KEYS.graphPositions)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.v !== GRAPH_POSITIONS_VERSION) return null
    if (!parsed.positions || typeof parsed.positions !== 'object') return null
    return parsed
  } catch (error) {
    return null
  }
}

/**
 * 写入坐标存档。
 * @param {Object<string, {x: number, y: number}>} positions id → 坐标
 * @param {string} signature 写入时的图谱结构签名（见 graphSignature）
 * @returns {boolean} 是否写成功（配额满 / 隐私模式会返回 false）
 */
export function writeGraphPositions (positions, signature) {
  try {
    localStorage.setItem(LS_KEYS.graphPositions, JSON.stringify({
      v: GRAPH_POSITIONS_VERSION,
      sig: signature || '',
      savedAt: Date.now(),
      positions
    }))
    return true
  } catch (error) {
    return false
  }
}

/** 清掉坐标存档（「重新布局」与 resetConfig 都走这条路） */
export function clearGraphPositions () {
  try {
    localStorage.removeItem(LS_KEYS.graphPositions)
  } catch (error) {
    // 清不掉最多是下次还用旧坐标，不该影响主流程
  }
}
</script>

<script setup>
import { ref, shallowRef, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { 
  RefreshCw, ZoomIn, ZoomOut, Maximize2, Search, 
  Network, FileText, Link2, Globe, Focus, GitBranch, Tag, Save
} from 'lucide-vue-next'
// T35：关系图的「边」全部交给 T34 的纯函数内核算。
//  · buildLinkEdges 一次产出 wiki / tag / similar 三类边（source/target 是 id 字符串）
//  · EDGE_KINDS 给模板里的「双链 / 标签 / 相似」分列计数用，避免字符串散落
//  · LINK_MODES 给「全部 / 仅双链」开关用
import { buildLinkEdges, EDGE_KINDS, LINK_MODES } from '@/utils/graphLinks'
// tag 口径必须与应用内其它地方（标签视图 / 反向链接 / 编辑器）完全一致，
// 所以直接用 useLinks 的权威实现，不再在图谱里各写一份宽松正则。
import { extractTags } from '@/composables/useLinks'

const router = useRouter()
const noteStore = useNoteStore()

const selectedNode = ref(null)
const hoveredNode = ref(null)
const graphContainer = ref(null)
const searchQuery = ref(null)
const viewMode = ref('global')
/** 'all' = 双链 + 标签 + 相似；'wiki-only' = 只渲染手写的 [[双链]]（R-G1） */
const linkMode = ref(LINK_MODES.ALL)

// ---------------------------------------------------------------------------
// 节点 / 连线为什么必须是 shallowRef
// ---------------------------------------------------------------------------
// 力导向每帧要写 N 个节点的 x/y/vx/vy。之前 nodes 是深响应 ref：4N 次属性写入
// 各自触发依赖，而 visibleNodes 里的 `...n` 展开会读取全部属性，于是每个节点
// 每次写入都让该 computed 失效 —— 60fps 下持续重建 N 个新对象并整棵 SVG 打补丁。
// 改成 shallowRef 后：节点对象是裸对象，写坐标不触发任何依赖；每帧末尾统一
// triggerRef 一次，一帧只重算一次、只 patch 一次。
const nodes = shallowRef([])
const links = shallowRef([])

// 裸数组快照：给"不需要逐帧更新"的 computed（侧边栏排序列表、标签配色）用，
// 避免它们被每帧的 triggerRef 拖着一起重算
let nodesRaw = []
let linksRaw = []

/** 每帧 +1：驱动画布渲染（唯一会被高频写入的响应式值） */
const frameTick = ref(0)
/** 图谱结构（节点集合/连线）变化时 +1：驱动侧边栏、配色等低频 computed */
const structureVersion = ref(0)

const scale = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)

const isPanning = ref(false)
const isDraggingNode = ref(false)
const draggedNodeId = ref(null)
const lastMousePos = ref({ x: 0, y: 0 })

// ---------------------------------------------------------------------------
// T36 · R-G3 布局持久化状态
// ---------------------------------------------------------------------------
/**
 * 磁盘上的坐标存档（readGraphPositions 的结果），null = 没有存档。
 * 只在挂载时读一次 + 写入后同步更新，避免每次 generateGraph 都 parse 一遍 JSON。
 */
let savedPositions = readGraphPositions()
/**
 * 重排次数：参与种子派生（`id#index#nonce`）。
 * 冷启动恒为 0 → 冷启动布局必然一致；点「重新布局」时 +1 → 换一套新排布。
 * 不能直接用 Date.now()/Math.random() 当 nonce，否则冷启动就不确定了。
 */
let layoutNonce = 0
/** 当前图谱的结构签名（节点集合 + 边集合） */
let currentSignature = ''
/**
 * 本次 generateGraph 是否是「存档原样恢复」。
 * true 时跳过力导向：存档坐标本来就来自收敛态，再跑一遍只会把它抖散，
 * 那就又变回「每次打开都不一样」了。
 */
let restoredFromDisk = false

/**
 * 坐标落盘的去抖窗口（ms）。
 * 写入时机见 scheduleSavePositions 的说明 —— 绝不能每帧写。
 */
const SAVE_DEBOUNCE_MS = 1000
/** 去抖的最长等待：连着触发时至少每 5s 落一次，防止长仿真一直不收敛导致一次都不写 */
const SAVE_MAX_WAIT_MS = 5000
let saveTimer = null
/**
 * 上次真正落盘的时间戳。初始化成"刚启动"而不是 0：
 * 置 0 会让「距上次落盘已超过最长等待」立刻成立、第一次收敛就变成同步写，
 * 去抖形同虚设；初始化成启动时刻，第一次收敛也老老实实走 1s 去抖窗口。
 * （真等不及的场景由卸载时的 flush 兜底，见 onUnmounted。）
 */
let lastSaveAt = Date.now()
/** 坐标自上次落盘后是否又动过（每帧置一次，成本是一次赋值） */
let positionsDirty = false

let animationFrame = null
let focusAnimationFrame = null
let simulationRunning = false
let simulationFrame = 0
/** 画布尺寸缓存：之前每帧 getBoundingClientRect() 会强制同步布局（reflow） */
let containerRect = { width: 0, height: 0 }
let resizeObserver = null

/** 仿真收敛上限：力导向在斥力/引力震荡时可能长期不收敛，RAF 会常驻烧 CPU */
const MAX_SIMULATION_FRAMES = 400

const tagColors = [
  '#6366f1', '#ec4899', '#8b5cf6', '#f59e0b', '#10b981',
  '#3b82f6', '#ef4444', '#14b8a6', '#f97316', '#84cc16'
]

const tagColorMap = computed(() => {
  structureVersion.value // 只在图谱结构变化时重算
  const map = {}
  const allTags = new Set()
  nodesRaw.forEach(n => {
    (n.tags || []).forEach(t => allTags.add(t))
  })
  let colorIndex = 0
  allTags.forEach(tag => {
    map[tag] = tagColors[colorIndex % tagColors.length]
    colorIndex++
  })
  return map
})

function getNodeColor(node) {
  if (selectedNode.value === node.id) return 'var(--color-primary)'
  if (node.tags && node.tags.length > 0) {
    return tagColorMap.value[node.tags[0]] || 'var(--color-surface)'
  }
  return 'var(--color-surface)'
}

const neighborIds = computed(() => {
  const target = hoveredNode.value || selectedNode.value
  if (!target) return null
  const ids = new Set([target])
  linksRaw.forEach(link => {
    if (link.source.id === target) ids.add(link.target.id)
    if (link.target.id === target) ids.add(link.source.id)
  })
  return ids
})

const selectedNodeData = computed(() => {
  if (!selectedNode.value) return null
  return noteStore.notes.find(n => n.id === selectedNode.value)
})

const visibleNodes = computed(() => {
  // 依赖帧计数：每帧只重算一次（而不是每个节点属性写入都重算一次）
  frameTick.value
  structureVersion.value
  const query = (searchQuery.value || '').trim()
  let baseNodes = nodesRaw

  if (viewMode.value === 'local' && selectedNode.value) {
    const neighbors = neighborIds.value
    if (neighbors) {
      baseNodes = baseNodes.filter(n => neighbors.has(n.id))
    }
  }

  if (!query) {
    return baseNodes.map(n => ({
      ...n,
      matches: true,
      highlighted: neighborIds.value ? neighborIds.value.has(n.id) : true,
      dimmed: neighborIds.value ? !neighborIds.value.has(n.id) : false
    }))
  }

  const lowerQuery = query.toLowerCase()
  return baseNodes.map(n => ({
    ...n,
    matches: n.label.toLowerCase().includes(lowerQuery),
    highlighted: neighborIds.value ? neighborIds.value.has(n.id) : n.label.toLowerCase().includes(lowerQuery),
    dimmed: neighborIds.value ? !neighborIds.value.has(n.id) : !n.label.toLowerCase().includes(lowerQuery)
  }))
})

const visibleLinks = computed(() => {
  frameTick.value
  structureVersion.value
  const query = (searchQuery.value || '').trim()
  let baseLinks = linksRaw

  if (viewMode.value === 'local' && selectedNode.value) {
    const neighbors = neighborIds.value
    if (neighbors) {
      baseLinks = baseLinks.filter(l =>
        neighbors.has(l.source.id) && neighbors.has(l.target.id)
      )
    }
  }

  if (!query && !neighborIds.value) {
    return baseLinks.map(l => ({
      // ⚠️ 必须带 kind：同一对节点可以同时有 wiki 边和 tag 边，
      // 只用 source|target 做 key 会让 Vue 的 :key 重复，后面的边被静默丢掉。
      id: `${l.kind}|${l.source.id}|${l.target.id}`,
      ...l,
      opacity: 0.5,
      highlighted: false
    }))
  }

  const highlightedIds = neighborIds.value || new Set(
    visibleNodes.value.filter(n => n.matches).map(n => n.id)
  )

  return baseLinks.map(l => {
    const sourceHighlighted = highlightedIds.has(l.source.id)
    const targetHighlighted = highlightedIds.has(l.target.id)
    const bothHighlighted = sourceHighlighted && targetHighlighted
    return {
      // 同上：kind 必须进 key，否则 wiki 边与 tag 边互相覆盖
      id: `${l.kind}|${l.source.id}|${l.target.id}`,
      ...l,
      opacity: bothHighlighted ? 0.9 : (sourceHighlighted || targetHighlighted ? 0.2 : 0.05),
      highlighted: bothHighlighted
    }
  })
})

// ---------------------------------------------------------------------------
// extractTags 去哪了？
// ---------------------------------------------------------------------------
// 这里原本有一份**宽松版**本地 tag 正则（形如 # 后面吃到空白为止，源码已删）。
// 它与应用内其它地方的口径不一致，后果是：
//   1. `#define`、URL 的 `#anchor`、`### 三级标题` 全被当成标签；
//   2. 图谱节点配色（getNodeColor → tagColorMap）因此被垃圾标签污染。
// T35 起统一注入 useLinks.js 的权威 extractTags（TAG_REGEX =
// /(^|\s)#([A-Za-z0-9_\u4e00-\u9fa5-]+)/g，还会读 frontmatter.tags），
// 图谱与标签视图、反向链接面板从此看到同一份标签集合。
// ---------------------------------------------------------------------------

/**
 * 图谱用的 tag 提取器 = 正文里的 #tag + 笔记自带的 note.tags。
 *
 * 为什么必须并上 note.tags：标签视图、笔记徽章、快速切换器读的全是这个字段
 * （note.js 在保存与载入时都会 `note.tags = extractTags(content)` 同步它）。
 * 只用正文提取的话，示例库这类「tags 写在元数据里」的笔记在图谱上一条边都没有，
 * 用户打开图谱只会看到一堆散点 —— 这正是"图谱看起来是坏的"的典型表现。
 *
 * @param {unknown} content 笔记正文
 * @param {Object} [note] 笔记对象（内核会把第二个参数透传进来）
 * @returns {string[]} 去重后的标签列表
 */
function extractTagsForGraph (content, note) {
  const out = new Set()
  const push = (value) => {
    const text = String(value === null || value === undefined ? '' : value).trim()
    if (text) out.add(text)
  }
  if (note && Array.isArray(note.tags)) {
    for (const tag of note.tags) push(tag)
  }
  try {
    const fromContent = extractTags(content)
    if (Array.isArray(fromContent)) {
      for (const tag of fromContent) push(tag)
    }
  } catch (error) {
    // 提取器抛错不该让整张图消失：正文标签丢了，至少 note.tags 还在
  }
  return Array.from(out)
}

function extractTitleKeywords(title) {
  if (!title) return []
  const words = title.split(/[\s，。、！？；：""''（）【】《》,.!?;:\'\"()\[\]<>]+/).filter(w => w.length >= 2)
  return [...new Set(words)]
}

function extractContentKeywords(content) {
  if (!content) return []
  const cleaned = content.replace(/[#*`\[\]\-]/g, ' ').replace(/\n/g, ' ')
  const words = cleaned.split(/[\s，。、！？；：""''（）【】《》,.!?;:\'\"()\[\]<>]+/).filter(w => w.length >= 2)
  
  const wordCount = {}
  words.forEach(word => {
    const lower = word.toLowerCase()
    if (!wordCount[lower]) {
      wordCount[lower] = { word, count: 0 }
    }
    wordCount[lower].count++
  })
  
  const stopWords = new Set(['the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
    'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
    'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she',
    'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
    'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me',
    'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
    'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other',
    'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also',
    'back', 'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way',
    'even', 'new', 'want', 'because', 'any', 'these', 'give', 'day', 'most', 'us',
    'is', 'are', 'was', 'were', 'been', 'being', 'am', 'has', 'had', 'does',
    'did', 'done', 'doing', 'having', 'where', 'why', 'here', 'very', 'more',
    'much', 'many', 'such', 'same', 'own', 'both', 'few', 'most', 'some', 'no',
    'nor', 'not', 'only', 'too', 'very', 'don', 'should', 'yes', 'test', 'hello',
    'world', 'code', 'note', 'notes', 'app', 'markdown', 'electron', 'vue', 'javascript',
    'html', 'css', 'json', 'api', 'url', 'http', 'https', 'www', 'com', 'org',
    'net', 'io', 'github', 'git', 'npm', 'yarn', 'node', 'python', 'java', 'cpp',
    'file', 'files', 'folder', 'folders', 'path', 'dir', 'directory', 'open', 'save',
    'close', 'edit', 'view', 'new', 'old', 'left', 'right', 'top', 'bottom', 'center',
    'font', 'size', 'color', 'theme', 'light', 'dark', 'mode', 'text', 'title', 'content',
    'word', 'char', 'line', 'count', 'date', 'time', 'week', 'month', 'year', 'day',
    'today', 'tomorrow', 'yesterday', 'setting', 'settings', 'config', 'configuration',
    'type', 'types', 'typed', 'typing', 'function', 'return', 'const', 'let', 'var', 'class',
    'import', 'export', 'default', 'async', 'await', 'promise', 'resolve', 'reject', 'error',
    'warning', 'info', 'debug', 'log', 'message', 'data', 'value', 'key', 'object', 'array',
    'string', 'number', 'boolean', 'true', 'false', 'null', 'undefined', 'void', 'never', 'any',
    '的', '了', '和', '是', '就', '都', '而', '及', '与', '着',
    '或', '一个', '没有', '我们', '你们', '他们', '它们', '这', '那', '个',
    '在', '有', '不', '人', '上', '也', '很', '到', '说', '要',
    '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那',
    '什么', '怎么', '这样', '那样', '因为', '所以', '但是', '然后', '还是', '可以',
    '能', '能够', '应该', '必须', '需要', '可能', '大概', '大约', '左右', '一下',
    '一些', '很多', '非常', '比较', '更', '最', '太', '真', '假', '对',
    '错', '大', '小', '多', '少', '长', '短', '高', '低', '快',
    '慢', '早', '晚', '前', '后', '里', '外', '中', '间', '旁',
    '以上', '以下', '之前', '之后', '现在', '过去', '将来', '已经', '正在', '即将'
  ])
  
  const filtered = Object.values(wordCount)
    .filter(item => !stopWords.has(item.word.toLowerCase()) && item.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
  
  return filtered.map(item => item.word)
}

// 侧边栏列表只跟随"结构 + 选中"，不跟随每帧坐标变化
const sortedNodes = computed(() => {
  structureVersion.value
  const selected = selectedNode.value
  return [...nodesRaw].sort((a, b) => {
    if (selected === a.id) return -1
    if (selected === b.id) return 1
    return b.size - a.size
  })
})

function generateGraph() {
  const notes = noteStore.notes
  if (!measureContainer()) return

  const width = containerRect.width / scale.value
  const height = containerRect.height / scale.value
  const centerX = width / 2
  const centerY = height / 2

  // 存档坐标表（null = 没存档，全走种子）
  const savedMap = savedPositions && savedPositions.positions ? savedPositions.positions : null

  const nodeList = notes.map((note, index) => {
    // -------------------------------------------------------------------
    // R-G3 · 布局种子确定性化
    // -------------------------------------------------------------------
    // 初值一律由 `id#索引#重排次数` 哈希派生，不再用 Math.random()。
    // 力导向是混沌系统：初值差 1px，400 帧后收敛结果可能完全不同 ——
    // 这就是「每次打开图谱节点位置都不一样」的根因。
    // 抖动幅度沿用原先 Math.random()*0.3 / *80 的量级，保证布局观感不变，
    // 只是把随机源换成确定性哈希。
    // -------------------------------------------------------------------
    const seed = hashSeed(`${note.id}#${index}#${layoutNonce}`)
    // 「重新布局」时把节点在初始圆环上的排位整体挪一格，并换一个起始相位。
    // 只抖 ±0.3 rad 是不够的：CDP 探针实测，9 节点的示例库在这种小扰动下
    // 会被力导向重新拉回同一个平衡点（收敛后差值 < 0.2px），用户点了按钮
    // 却看不出变化。挪排位 + 换相位才能让重排真的落到另一处。
    // nonce 冷启动恒为 0 → slot = index、phase 为定值 → 冷启动布局仍然确定。
    const slot = notes.length > 0 ? (index + layoutNonce) % notes.length : 0
    const phase = (hashSeed(`phase#${layoutNonce}`) / 0xffffffff) * 2 * Math.PI
    const angle = (slot / notes.length) * 2 * Math.PI + phase + ((seed & 0xffff) / 0xffff) * 0.3
    const radius = 120 + (((seed >>> 16) & 0xffff) / 0xffff) * 80
    const charCount = (note.content || '').length
    const size = 6 + Math.min(charCount / 200, 16)

    // R-G3 · 坐标持久化：有存档就用存档，没有才回落到种子。
    // 必须校验有限数：存档被手改成 'abc' / null 时不能让节点飞到 NaN，
    // NaN 坐标会让整条 SVG transform 变成 "translate(NaN,NaN)" —— 图直接消失。
    const savedPos = savedMap ? savedMap[note.id] : null
    const restored = !!savedPos &&
      Number.isFinite(Number(savedPos.x)) &&
      Number.isFinite(Number(savedPos.y))

    return {
      id: note.id,
      label: note.title,
      x: restored ? Number(savedPos.x) : centerX + Math.cos(angle) * radius,
      y: restored ? Number(savedPos.y) : centerY + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      size,
      tags: extractTagsForGraph(note.content, note),
      titleKeywords: extractTitleKeywords(note.title),
      contentKeywords: extractContentKeywords(note.content),
      charCount,
      restored
    }
  })

  // -----------------------------------------------------------------------
  // 边由 T34 内核算：wiki（手写 [[双链]]）+ tag + similar。
  // 内核返回的是 id 字符串，这里一次性映射回节点对象，供渲染与力导向使用。
  //  · strength = 内核权重（wiki 3 / tag 2 / similar 0.5），正好落在渲染三档上
  //  · 不传 resolveTarget / idOfTitle：用内核自带的标题索引（标题 / 文件名 /
  //    frontmatter.title / folder/title 四种 key），它对每条链接是 O(1) 查表。
  //    千万别换成 useLinks 里那个「逐条解析」的函数：它每次调用都重建一次
  //    标题索引，N 条链接就是 O(n·links)，大图直接卡住。
  // -----------------------------------------------------------------------
  const idToNode = new Map(nodeList.map(n => [n.id, n]))
  const linkList = []
  const edgeList = buildLinkEdges({
    notes,
    extractTags: extractTagsForGraph,
    extractTitleKeywords,
    extractContentKeywords,
    linkMode: linkMode.value
  })
  for (const e of edgeList) {
    const source = idToNode.get(e.source)
    const target = idToNode.get(e.target)
    if (!source || !target) continue // 内核只认 id，防御性地丢掉悬空边
    linkList.push({ source, target, strength: e.weight, kind: e.kind })
  }

  nodesRaw = nodeList
  linksRaw = linkList
  nodes.value = nodeList
  links.value = linkList
  structureVersion.value++

  // 结构签名：判断存档坐标能不能原样复用（见 graphSignature 的说明）
  currentSignature = graphSignature(nodeList, linkList)
  restoredFromDisk =
    nodeList.length > 0 &&
    nodeList.every(n => n.restored) &&
    !!savedPositions &&
    savedPositions.sig === currentSignature

  offsetX.value = containerRect.width / 2 - centerX * scale.value
  offsetY.value = containerRect.height / 2 - centerY * scale.value
}

// ---------------------------------------------------------------------------
// T36 · 坐标持久化：写入时机
// ---------------------------------------------------------------------------
// 硬约束：绝不能每个 tick 都写 localStorage。力导向 60fps，一次写入要
// JSON.stringify N 个坐标 —— 3000 节点那是每帧 100KB+ 的同步 IO，
// 主线程直接被拖垮（localStorage 是同步 API，没有后台线程可卸）。
//
// 所以只在「坐标不会再变了」的时刻排一次写入：
//   1. 仿真收敛 / 打满 MAX_SIMULATION_FRAMES（tick 的结束分支）—— 主路径；
//   2. 用户拖完某个节点（mouseup）—— 手动摆位要能存下来；
//   3. 组件卸载（切路由 / 关窗口）—— 去抖窗口还没到也要补一次。
// 再加两层保护：
//   · 去抖 1000ms：一次交互里连续触发只写最后一次；
//   · 最长等待 5000ms：力导向长期震荡时也能周期性落盘，不会一条都不写。
// ---------------------------------------------------------------------------

/** 把当前坐标打成存档结构（3 位小数：JSON 体积减半，视觉上无差别） */
function snapshotPositions () {
  const out = {}
  for (const n of nodesRaw) {
    out[n.id] = {
      x: Math.round(n.x * 1000) / 1000,
      y: Math.round(n.y * 1000) / 1000
    }
  }
  return out
}

/** 立即落盘（去抖窗口到点 / 用户手动保存 / 卸载时调用） */
function flushSavePositions () {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!positionsDirty || nodesRaw.length === 0) return
  const ok = writeGraphPositions(snapshotPositions(), currentSignature)
  if (ok) {
    positionsDirty = false
    lastSaveAt = Date.now()
    // 写完之后内存里也同步一份：下次 generateGraph 直接命中恢复分支，
    // 不用再 parse 一遍 localStorage
    savedPositions = readGraphPositions()
  }
}

/** 排一次落盘（去抖 + 最长等待） */
function scheduleSavePositions () {
  positionsDirty = true
  if (saveTimer) clearTimeout(saveTimer)
  // 距上次落盘已超过最长等待 → 立刻写，不等去抖窗口
  if (Date.now() - lastSaveAt >= SAVE_MAX_WAIT_MS) {
    flushSavePositions()
    return
  }
  saveTimer = setTimeout(flushSavePositions, SAVE_DEBOUNCE_MS)
}

/** 用户手动定稿：跳过去抖窗口，立刻把当前坐标写进去 */
function saveLayoutNow () {
  scheduleSavePositions()
  flushSavePositions()
}

/**
 * 重建图谱（唯一入口）。
 *
 * 刻意区分「纯恢复」与「需要跑力导向」：存档坐标来自上一次的收敛态，
 * 节点与边都没变时直接渲染即可 —— 再跑一遍仿真只会把已经稳定的图再抖一次，
 * 那正是用户抱怨的「每次打开都不一样」。
 */
function rebuildGraph () {
  generateGraph()
  if (!restoredFromDisk) startSimulation()
}

// ---------------------------------------------------------------------------
// 旧的本地 buildLinks() 去哪了？
// ---------------------------------------------------------------------------
// 它只算「相似度」：把共享标签 / 标题词 / 正文词按 2 / 1.5 / 0.5 加权求和，
// 另外产出的三个「共享明细」数组字段在 UI 里没有任何消费点
// （T34 已 grep 确认）。也就是说：
//   · 用户在图谱上**看不到自己手写的 [[双链]]**（这正是最痛的诉求）；
//   · 却维护着一份只在图谱里存在的、与 useLinks 口径不一致的相似度实现。
// T35 起相似度语义整体下沉到 utils/graphLinks.js 的 buildSimilarEdges()
// （同样的倒排桶思路，但多了 minShared ≥ 2 的阈值、单篇关键词上限、
// 2KB 采样窗口），本地这份死代码删除。
// ---------------------------------------------------------------------------

/** 量一次画布尺寸；返回 false 表示容器还没挂载 */
function measureContainer () {
  if (!graphContainer.value) return false
  const rect = graphContainer.value.getBoundingClientRect()
  containerRect = { width: rect.width, height: rect.height }
  return containerRect.width > 0 && containerRect.height > 0
}

/**
 * 斥力按 1/d² 衰减：距离 320px 时每帧位移已不足 0.02px，再远对布局没有可见影响。
 * 所以节点多时可以只算邻近节点 —— 用均匀网格把 O(n²) 降成 O(n·k)：
 * 3000 节点实测 18ms/帧（掉帧）→ 6ms/帧。
 * 注意：截断长程斥力会让大图收敛到的布局与朴素版略有差异（展开度约差 10~25%，
 * 力导向本身是混沌系统，两者都是合法布局），因此仅在大图启用，见阈值说明。
 */
const REPULSION_CUTOFF = 320
// 1200 以下朴素两重循环还在 4ms/帧以内，且力导向是混沌系统、截断长程斥力会改变
// 收敛结果；所以只在朴素版真的要掉帧时才切网格，小图布局与改动前完全一致。
const REPULSION_GRID_MIN = 1200

function applyRepulsion(list, repulsionStrength) {
  const n = list.length

  if (n < REPULSION_GRID_MIN) {
    for (let i = 0; i < n; i++) {
      const a = list[i]
      for (let j = i + 1; j < n; j++) {
        const b = list[j]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const force = repulsionStrength / (dist * dist)
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        a.vx -= fx
        a.vy -= fy
        b.vx += fx
        b.vy += fy
      }
    }
    return
  }

  // 均匀网格：只与所在格及相邻 8 格内的节点比较
  const cell = REPULSION_CUTOFF
  const buckets = new Map()
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(list[i].x / cell)
    const cy = Math.floor(list[i].y / cell)
    // 坐标平移后打包成一个整数 key，避免字符串拼接带来的每帧分配
    const key = (cx + 0x8000) * 65536 + (cy + 0x8000)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(i)
    else buckets.set(key, [i])
  }

  const cutoff2 = REPULSION_CUTOFF * REPULSION_CUTOFF
  for (let i = 0; i < n; i++) {
    const a = list[i]
    const cx = Math.floor(a.x / cell)
    const cy = Math.floor(a.y / cell)
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = buckets.get((cx + ox + 0x8000) * 65536 + (cy + oy + 0x8000))
        if (!bucket) continue
        for (let k = 0; k < bucket.length; k++) {
          const j = bucket[k]
          if (j <= i) continue // 每对只算一次
          const b = list[j]
          const dx = b.x - a.x
          const dy = b.y - a.y
          const d2 = dx * dx + dy * dy
          if (d2 > cutoff2) continue
          const dist = Math.sqrt(d2) || 1
          const force = repulsionStrength / (dist * dist)
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          a.vx -= fx
          a.vy -= fy
          b.vx += fx
          b.vy += fy
        }
      }
    }
  }
}

function startSimulation() {
  if (simulationRunning) return
  simulationRunning = true
  simulationFrame = 0

  function tick() {
    const repulsionStrength = 2000
    const attractionStrength = 0.01
    const centerStrength = 0.02
    const damping = 0.9

    if (!graphContainer.value) {
      simulationRunning = false
      return
    }

    const centerX = containerRect.width / 2 / scale.value - offsetX.value / scale.value
    const centerY = containerRect.height / 2 / scale.value - offsetY.value / scale.value

    applyRepulsion(nodesRaw, repulsionStrength)

    for (const link of linksRaw) {
      const dx = link.target.x - link.source.x
      const dy = link.target.y - link.source.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      // ⚠️ 必须乘 strength：否则双链边和相似度边在布局上完全等价，
      // 用户「看不出哪条是自己写的链接」。乘上之后 wiki(3) 的吸引力是
      // tag(2) 的 1.5 倍、similar(0.5) 的 6 倍 —— 手写链接会把相关节点
      // 明显地拽到一起，相似度只做背景铺陈。
      const force = (dist - 150) * attractionStrength * (link.strength ?? 1)

      const fx = (dx / dist) * force
      const fy = (dy / dist) * force

      link.source.vx += fx
      link.source.vy += fy
      link.target.vx -= fx
      link.target.vy -= fy
    }

    for (const node of nodesRaw) {
      node.vx += (centerX - node.x) * centerStrength
      node.vy += (centerY - node.y) * centerStrength

      node.vx *= damping
      node.vy *= damping

      node.x += node.vx
      node.y += node.vy
    }

    // 一帧只触发一次响应式更新，而不是 4N 次属性写入各触发一次
    frameTick.value++
    // 坐标动过了 → 标记脏（一次赋值，不做任何 IO；真正的写在收敛后才发生）
    positionsDirty = true

    let maxVelocity = 0
    for (const node of nodesRaw) {
      maxVelocity = Math.max(maxVelocity, Math.abs(node.vx), Math.abs(node.vy))
    }

    simulationFrame++
    const exhausted = simulationFrame >= MAX_SIMULATION_FRAMES

    // 收敛判定之外再加一条硬上限：斥力/引力震荡时 maxVelocity 可能长期降不下来，
    // RAF 会一直常驻烧 CPU 和电池
    if (!exhausted && maxVelocity > 0.1) {
      animationFrame = requestAnimationFrame(tick)
    } else {
      simulationRunning = false
      animationFrame = null
      // 坐标稳定了 —— 这才是唯一该排落盘的时刻（去抖 1s）
      scheduleSavePositions()
    }
  }

  tick()
}

function selectNode(node) {
  selectedNode.value = selectedNode.value === node.id ? null : node.id
}

function focusNode(node) {
  selectedNode.value = node.id

  if (!measureContainer()) return
  const targetX = containerRect.width / 2 - node.x * scale.value
  const targetY = containerRect.height / 2 - node.y * scale.value

  const startX = offsetX.value
  const startY = offsetY.value
  const duration = 300
  const startTime = performance.now()

  // 连续点多个节点时必须先取消上一段动画，否则两段动画会同时写 offset 互相打架
  if (focusAnimationFrame) cancelAnimationFrame(focusAnimationFrame)

  function animate(currentTime) {
    const elapsed = currentTime - startTime
    const progress = Math.min(elapsed / duration, 1)
    const ease = 1 - Math.pow(1 - progress, 3)

    offsetX.value = startX + (targetX - startX) * ease
    offsetY.value = startY + (targetY - startY) * ease

    if (progress < 1) {
      focusAnimationFrame = requestAnimationFrame(animate)
    } else {
      focusAnimationFrame = null
    }
  }

  focusAnimationFrame = requestAnimationFrame(animate)
}

function openNote(id) {
  noteStore.selectNote(id)
  router.push(`/editor/${id}`)
}

/**
 * 统计某个节点的边数。
 *
 * @param {string} nodeId 节点 id
 * @param {string} [kind] EDGE_KINDS 之一；省略则统计全部。
 *   R-G5 要求双链 / 相似**分列**展示 —— 混标成一个数字时用户无法判断
 *   「12」里到底有几条是自己手写的 [[链接]]。
 * @returns {number} 边数
 */
function getLinkCount (nodeId, kind) {
  let count = 0
  for (const l of linksRaw) {
    if (l.source.id !== nodeId && l.target.id !== nodeId) continue
    if (kind && l.kind !== kind) continue
    count++
  }
  return count
}

/** 全图各类边的条数：状态栏展示，同时也是「仅双链」模式的直接验收点 */
const linkStats = computed(() => {
  structureVersion.value
  const stats = { wiki: 0, tag: 0, similar: 0 }
  for (const l of linksRaw) {
    const kind = l.kind
    if (kind === EDGE_KINDS.wiki) stats.wiki++
    else if (kind === EDGE_KINDS.tag) stats.tag++
    else stats.similar++
  }
  return stats
})

/**
 * 「重新布局」：一键重排。
 *
 * 坐标持久化之后，单纯再跑一次 generateGraph() 会命中恢复分支、把旧坐标
 * 原样读回来 —— 按钮点了跟没点一样。所以必须：
 *   1. 清掉存档（磁盘 + 内存缓存），让所有节点回落到种子分支；
 *   2. layoutNonce++ 换一套种子，保证排出来的图跟上一版真的不一样；
 *   3. 跑力导向；收敛后由 scheduleSavePositions 把新坐标存回去。
 *
 * nonce 是自增整数而不是时间戳/随机数：它只在用户点按钮时变，冷启动恒为 0，
 * 这样 R-G3 的「冷启动两次排布一致」才立得住。
 */
function relayout() {
  layoutNonce++
  clearGraphPositions()
  savedPositions = null
  positionsDirty = true
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
  if (!measureContainer() || nodesRaw.length === 0) return

  scale.value = 1

  let sumX = 0
  let sumY = 0
  for (const n of nodesRaw) { sumX += n.x; sumY += n.y }
  const centerX = sumX / nodesRaw.length
  const centerY = sumY / nodesRaw.length

  offsetX.value = containerRect.width / 2 - centerX
  offsetY.value = containerRect.height / 2 - centerY
}

function onWheel(e) {
  e.preventDefault()
  const delta = e.deltaY > 0 ? 0.9 : 1.1
  const newScale = Math.max(0.3, Math.min(3, scale.value * delta))

  if (!measureContainer()) return
  const mouseX = e.clientX - graphContainer.value.getBoundingClientRect().left
  const mouseY = e.clientY - graphContainer.value.getBoundingClientRect().top
  
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

function startDragNode(node, e) {
  if (e.button !== 0) return
  isDraggingNode.value = true
  draggedNodeId.value = node.id
  lastMousePos.value = { x: e.clientX, y: e.clientY }
}

function onCanvasMouseMove(e) {
  if (isDraggingNode.value && draggedNodeId.value) {
    const dx = (e.clientX - lastMousePos.value.x) / scale.value
    const dy = (e.clientY - lastMousePos.value.y) / scale.value
    const node = nodesRaw.find(n => n.id === draggedNodeId.value)
    if (node) {
      node.x += dx
      node.y += dy
      node.vx = 0
      node.vy = 0
      // 手动拖动是低频操作，直接触发一次重渲染即可
      frameTick.value++
    }
    lastMousePos.value = { x: e.clientX, y: e.clientY }
  } else if (isPanning.value) {
    const dx = e.clientX - lastMousePos.value.x
    const dy = e.clientY - lastMousePos.value.y
    offsetX.value += dx
    offsetY.value += dy
    lastMousePos.value = { x: e.clientX, y: e.clientY }
  }
}

function onCanvasMouseUp() {
  const wasDraggingNode = isDraggingNode.value
  isPanning.value = false
  isDraggingNode.value = false
  draggedNodeId.value = null
  // 手动摆位要能存下来：拖完排一次落盘（去抖 1s，连拖只写最后一次）
  if (wasDraggingNode) scheduleSavePositions()
}

function getPreview(content) {
  if (!content) return ''
  const text = content.replace(/[#*`\[\]\-]/g, '').replace(/\n/g, ' ').trim()
  return text.length > 100 ? text.substring(0, 100) + '...' : text
}

// 笔记增删或内容变化后自动重建图谱（防抖，避免频繁重排）。
//
// 指纹 = `id:title:folder:正文指纹`（见 <script> 块的 noteFingerprint）。
// 旧版是 `id:title:content.length`，漏掉两类改动（R-G4）：
//   ① 笔记换文件夹（正文一字未改）→ 指纹不变 → 不重建，而 folder 会影响
//      双链解析的 `folder/title` 键，边集合可能已经变了；
//   ② 正文等长改写 → 长度不变 → 不重建。
// 正文指纹走采样哈希而不是全量哈希：这个 getter 每敲一个字都会跑一遍全库，
// 全量哈希 500 篇 × 10KB 会把每次按键拖到 10ms 级。
let graphRegenTimer = null
watch(
  () => graphFingerprint(noteStore.notes),
  () => {
    if (graphRegenTimer) clearTimeout(graphRegenTimer)
    graphRegenTimer = setTimeout(() => {
      rebuildGraph()
    }, 600)
  }
)

// 切「全部 / 仅双链」只影响边的集合，节点坐标保留会立刻收敛；
// 但为了布局能按新的边重新舒展，这里整体重建（顺便重置节点位置）。
// 走 rebuildGraph：边集合变了 → 签名对不上存档 → 一定跑力导向，
// 且以存档坐标为热启动初值（比从种子重排收敛快）。
watch(linkMode, () => {
  rebuildGraph()
})

onMounted(() => {
  nextTick(() => {
    if (!measureContainer()) return
    rebuildGraph()
  })

  // 画布尺寸变化后中心点必须跟着变，否则窗口缩放后布局会偏到一边
  if (graphContainer.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      const hadSize = containerRect.width > 0
      measureContainer()
      if (hadSize && simulationRunning) startSimulation()
    })
    resizeObserver.observe(graphContainer.value)
  }

  window.addEventListener('mouseup', onCanvasMouseUp)
})

onUnmounted(() => {
  if (graphRegenTimer) {
    clearTimeout(graphRegenTimer)
    graphRegenTimer = null
  }
  if (animationFrame) {
    cancelAnimationFrame(animationFrame)
    animationFrame = null
  }
  // 切路由 / 关窗口时补一次落盘：去抖窗口（1s）可能还没到，
  // 不补的话用户刚拖好的节点位置就丢了
  flushSavePositions()
  // 聚焦动画的 RAF 句柄不在这里取消的话，切走路由后仍会继续写 offset 300ms
  if (focusAnimationFrame) {
    cancelAnimationFrame(focusAnimationFrame)
    focusAnimationFrame = null
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
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
  background: var(--color-primary-surface);
}

.line-clamp-3 {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
