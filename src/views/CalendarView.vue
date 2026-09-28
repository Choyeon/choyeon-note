<template>
  <div class="h-full flex flex-col overflow-hidden" :data-view="viewMode">
    <!-- ================= 头部：翻页 / 标题 / 视图切换 / 图例 ================= -->
    <div
      class="min-h-[52px] px-6 py-3 flex items-center gap-3 border-b acrylic-content shrink-0 flex-wrap"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <div class="flex items-center gap-2">
        <button
          class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-95"
          title="上一段"
          @click="shiftAnchor(-1)"
        >
          <ChevronLeft class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
        <button
          class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-95"
          title="下一段"
          @click="shiftAnchor(1)"
        >
          <ChevronRight class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
      </div>

      <h2 class="text-lg font-semibold tracking-tight min-w-[132px]" :style="{ color: 'var(--color-text-primary)' }">
        {{ headerTitle }}
      </h2>

      <button
        class="px-3 py-1.5 rounded-lg cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-95"
        :style="{ background: 'var(--color-primary-surface)' }"
        title="回到今天"
        @click="goToToday"
      >
        <span class="text-[12px] font-semibold" :style="{ color: 'var(--color-primary)' }">今天</span>
      </button>

      <!-- 视图切换：月 / 周 / 议程。切换时锚点跟着选中日期走，选中项绝不丢失 -->
      <div class="flex items-center gap-0.5 p-0.5 rounded-lg" :style="{ background: 'var(--color-bg-tertiary)' }">
        <button
          v-for="mode in viewModeItems"
          :key="mode.key"
          class="mode-btn px-2 py-1 rounded-md flex items-center gap-1 cursor-pointer transition-all duration-150"
          :class="{ 'mode-btn-active': viewMode === mode.key }"
          :data-mode="mode.key"
          :title="mode.title"
          @click="setView(mode.key)"
        >
          <component :is="mode.icon" class="w-3.5 h-3.5" />
          <span class="text-[11px] font-medium">{{ mode.label }}</span>
        </button>
      </div>

      <div class="flex-1"></div>

      <div class="flex items-center gap-4">
        <!-- 密度图例：0 / 1-2 / ≥3 三档，一眼看懂格子的深浅 -->
        <div class="flex items-center gap-2" title="单日笔记数：浅 = 1-2 篇，深 = 3 篇及以上">
          <span class="text-[11px]" :style="{ color: 'var(--color-text-tertiary)' }">密度</span>
          <span class="density-swatch density-swatch-none"></span>
          <span class="density-swatch density-swatch-low"></span>
          <span class="density-swatch density-swatch-high"></span>
        </div>
        <!-- ④ 级日期可见信号：这些笔记的日历位置是「按最近修改时间推测」的 -->
        <div
          v-if="inferredTotal > 0"
          class="flex items-center gap-1.5"
          :title="`${inferredTotal} 篇笔记没有可确定的创建日期，日历位置按最近修改时间推测`"
        >
          <HelpCircle class="w-3.5 h-3.5" :style="{ color: 'var(--state-warning)' }" />
          <span class="text-[11px]" :style="{ color: 'var(--color-text-tertiary)' }">推测 {{ inferredTotal }} 篇</span>
        </div>
        <div class="flex items-center gap-2">
          <Calendar class="w-3.5 h-3.5" :style="{ color: 'var(--color-text-tertiary)' }" />
          <span class="text-[11px] font-mono" :style="{ color: 'var(--color-text-tertiary)' }">
            {{ monthStats.days }} / {{ monthData.daysInMonth }} 天
          </span>
        </div>
      </div>
    </div>

    <!-- ================= 主体 ================= -->
    <div class="flex-1 min-h-0 overflow-hidden flex flex-col acrylic-content">
      <!-- ---------- 月视图 ---------- -->
      <template v-if="viewMode === 'month'">
        <div class="px-6 py-3 shrink-0">
          <div class="grid grid-cols-7 gap-1">
            <div
              v-for="(day, idx) in weekdayHeader"
              :key="day"
              class="h-6 flex items-center justify-center text-[10px] font-semibold uppercase tracking-wider"
              :style="{ color: idx >= 5 ? 'var(--state-error)' : 'var(--color-text-tertiary)' }"
            >{{ day }}</div>
          </div>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar px-6 pb-6 pt-1" data-region="month-grid">
          <div
            v-for="(week, weekIndex) in monthWeeks"
            :key="weekIndex"
            class="grid grid-cols-7 gap-1 mb-0.5"
          >
            <div
              v-for="cell in week"
              :key="cell.iso"
              class="day-cell relative rounded-lg cursor-pointer transition-all duration-200"
              :class="{
                'day-selected': cell.iso === selectedIso,
                'day-today': cell.iso === todayIso,
                'day-other-month': !cell.inMonth,
                'day-density-low': cell.density.level === 1,
                'day-density-high': cell.density.level === 2
              }"
              :data-iso="cell.iso"
              @click="selectCell(cell)"
            >
              <button
                class="day-add-btn absolute top-1 right-1 w-5 h-5 rounded-md flex items-center justify-center opacity-0 cursor-pointer transition-all duration-150 hover:bg-[var(--color-primary-surface)] active:scale-90"
                :style="{ color: 'var(--color-primary)' }"
                title="在此日期创建笔记"
                @click.stop="createNoteForDate(cell.iso)"
              >
                <Plus class="w-3 h-3" />
              </button>

              <div class="day-content flex flex-col items-center justify-start pt-1.5 pb-1.5 px-1">
                <div
                  class="day-number flex items-center justify-center w-6 h-6 rounded-full text-[12px] font-medium transition-all duration-200"
                  :class="{
                    'day-number-today': cell.iso === todayIso,
                    'day-number-selected': cell.iso === selectedIso,
                    'day-number-other': !cell.inMonth
                  }"
                >
                  {{ cell.date }}
                </div>

                <div class="w-full mt-1 min-h-[36px] flex flex-col gap-0.5">
                  <div
                    v-for="note in cell.notes.slice(0, 2)"
                    :key="note.id"
                    class="day-note px-1 py-0.5 rounded text-[9px] font-medium truncate transition-all duration-200 hover:opacity-80"
                    :style="{
                      background: 'var(--color-bg-tertiary)',
                      color: 'var(--color-text-secondary)'
                    }"
                    :title="note.title"
                    @click.stop="openNote(note.id)"
                  >
                    {{ truncate(note.title, 8) }}
                  </div>
                  <div
                    v-if="cell.count > 2"
                    class="text-[9px] text-center"
                    :style="{ color: 'var(--color-text-tertiary)' }"
                  >
                    +{{ cell.count - 2 }}
                  </div>
                </div>
              </div>

              <!-- 密度条：≥3 篇用实心三格 + 更亮的底色，不再只是一个 +N -->
              <div
                v-if="cell.count > 0"
                class="density-strip absolute bottom-1.5 left-1/2 -translate-x-1/2 flex items-center gap-0.5"
              >
                <span
                  v-for="i in densityDots(cell)"
                  :key="i"
                  class="density-dot"
                  :class="{ 'density-dot-strong': cell.density.level === 2 }"
                ></span>
              </div>

              <div
                class="today-indicator absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-3 h-0.5 rounded-full"
                :style="{
                  background: cell.iso === todayIso && cell.iso !== selectedIso ? 'var(--color-primary)' : 'transparent'
                }"
              ></div>
            </div>
          </div>
        </div>
      </template>

      <!-- ---------- 周视图：连续 7 天的分布 ---------- -->
      <template v-else-if="viewMode === 'week'">
        <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar px-6 pb-6 pt-3" data-region="week-grid">
          <div class="grid grid-cols-7 gap-2 min-h-[320px]">
            <div
              v-for="cell in weekColumns"
              :key="cell.iso"
              class="week-col flex flex-col rounded-lg overflow-hidden transition-all duration-200 cursor-pointer"
              :class="{
                'week-col-today': cell.iso === todayIso,
                'week-col-selected': cell.iso === selectedIso,
                'week-col-other': !cell.inMonth,
                'week-col-busy': cell.density.level === 2
              }"
              :data-iso="cell.iso"
              @click="selectCell(cell)"
            >
              <div class="week-col-head px-2 py-1.5 flex flex-col items-center">
                <span class="text-[10px]" :style="{ color: 'var(--color-text-tertiary)' }">
                  {{ weekdayFull(cell) }}
                </span>
                <span
                  class="text-[13px] font-semibold leading-tight"
                  :style="{ color: cell.iso === todayIso ? 'var(--color-primary)' : 'var(--color-text-primary)' }"
                >
                  {{ cell.month }}月{{ cell.date }}日
                </span>
                <span class="text-[9px]" :style="{ color: 'var(--color-text-tertiary)' }">
                  {{ cell.count > 0 ? cell.count + ' 篇' : '—' }}
                </span>
              </div>
              <div class="week-col-body flex-1 p-1 flex flex-col gap-1 min-h-0">
                <div
                  v-for="note in cell.notes"
                  :key="note.id"
                  class="week-note px-1.5 py-1 rounded text-[10px] truncate transition-all duration-150 hover:opacity-80"
                  :style="{
                    background: 'var(--color-bg-tertiary)',
                    color: 'var(--color-text-secondary)'
                  }"
                  :title="note.title"
                  @click.stop="openNote(note.id)"
                >
                  {{ truncate(note.title, 12) }}
                </div>
                <div
                  v-if="cell.count === 0"
                  class="flex-1 flex items-center justify-center text-[10px]"
                  :style="{ color: 'var(--color-text-tertiary)' }"
                >无</div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- ---------- 议程视图：按日分组的列表 ---------- -->
      <template v-else>
        <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar px-6 pb-6 pt-3" data-region="agenda">
          <div
            v-for="cell in agendaGroups"
            :key="cell.iso"
            class="agenda-day mb-2"
            :data-iso="cell.iso"
          >
            <div class="flex items-center gap-2 mb-1">
              <span class="text-[12px] font-semibold" :style="{ color: 'var(--color-text-primary)' }">
                {{ cell.month }}月{{ cell.date }}日
              </span>
              <span class="text-[10px]" :style="{ color: 'var(--color-text-tertiary)' }">
                {{ weekdayFull(cell) }}
              </span>
              <span
                v-if="cell.density.level === 2"
                class="px-1.5 py-0.5 rounded text-[9px] font-medium"
                :style="{ background: 'var(--color-primary-surface)', color: 'var(--color-primary)' }"
              >高产 {{ cell.count }} 篇</span>
              <span v-else class="text-[10px]" :style="{ color: 'var(--color-text-tertiary)' }">
                {{ cell.count }} 篇
              </span>
              <div class="flex-1 h-px" :style="{ background: 'var(--color-border-light)' }"></div>
            </div>
            <div class="flex flex-col gap-1 pl-2">
              <div
                v-for="note in cell.notes"
                :key="note.id"
                class="agenda-note px-2 py-1.5 rounded-lg cursor-pointer transition-all duration-150 hover:bg-[var(--color-surface-hover)]"
                :style="{ borderLeft: '2px solid var(--color-primary-surface)' }"
                @click="openNote(note.id)"
              >
                <span class="text-[12px]" :style="{ color: 'var(--color-text-primary)' }">{{ note.title }}</span>
                <span class="ml-2 text-[10px]" :style="{ color: 'var(--color-text-tertiary)' }">
                  {{ note.folder || '根目录' }}
                </span>
              </div>
            </div>
          </div>
          <div v-if="agendaGroups.length === 0" class="py-10 text-center">
            <p class="text-[12px]" :style="{ color: 'var(--color-text-secondary)' }">本月没有任何笔记</p>
          </div>
        </div>
      </template>
    </div>

    <!-- ================= 底部：选中日期的笔记 ================= -->
    <div
      class="border-t acrylic-content shrink-0"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <div class="px-6 py-3">
        <div class="flex items-center gap-3 mb-3">
          <div class="w-7 h-7 rounded-lg flex items-center justify-center" :style="{ background: 'var(--color-primary-surface)' }">
            <CalendarDays class="w-3.5 h-3.5" :style="{ color: 'var(--color-primary)' }" />
          </div>
          <div>
            <div class="text-[14px] font-semibold tracking-tight" :style="{ color: 'var(--color-text-primary)' }">
              {{ formatSelectedDate() }}
            </div>
            <div class="text-[10px]" :style="{ color: 'var(--color-text-tertiary)' }">
              {{ selectedNotes.length }} 篇笔记<template v-if="selectedInferred > 0"> · {{ selectedInferred }} 篇日期为推测</template>
            </div>
          </div>
          <div class="flex-1"></div>
          <button
            class="px-3 py-1.5 rounded-lg text-[12px] font-medium cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-95"
            :style="{ background: 'var(--color-primary)', color: 'white' }"
            title="在选中日期创建笔记"
            @click="createNoteForDate()"
          >
            <span class="flex items-center gap-1">
              <Plus class="w-3.5 h-3.5" />
              新建笔记
            </span>
          </button>
        </div>

        <div
          v-if="selectedNotes.length > 0"
          class="flex gap-2 overflow-x-auto cho-scrollbar pb-2 -mx-1 px-1"
        >
          <div
            v-for="note in selectedNotes"
            :key="note.id"
            class="note-card flex-shrink-0 w-52 p-3 rounded-lg cursor-pointer transition-all duration-200 hover:scale-[1.02] hover:shadow-sm"
            :style="{
              background: 'var(--card-bg)',
              border: '1px solid var(--card-border)'
            }"
            @click="openNote(note.id)"
          >
            <div class="flex items-start gap-2 mb-2">
              <FileText
                class="w-3.5 h-3.5 flex-shrink-0 mt-0.5"
                :style="{ color: 'var(--color-primary)' }"
              />
              <div class="flex-1 min-w-0">
                <div class="text-[12px] font-semibold truncate" :style="{ color: 'var(--color-text-primary)' }">
                  {{ note.title }}
                </div>
              </div>
              <!-- ④ 级日期的可见信号：这一篇的日历位置是推测出来的 -->
              <span
                v-if="isInferred(note.id)"
                class="flex-shrink-0 flex items-center gap-0.5"
                :title="inferredHint"
                :data-inferred="note.id"
              >
                <HelpCircle class="w-3 h-3" :style="{ color: 'var(--state-warning)' }" />
              </span>
            </div>
            <div class="text-[10px] mb-1.5" :style="{ color: 'var(--color-text-tertiary)' }">
              {{ note.folder || '根目录' }}
            </div>
            <div class="text-[10px] leading-relaxed line-clamp-2" :style="{ color: 'var(--color-text-secondary)' }">
              {{ getNotePreview(note.content) }}
            </div>
            <div class="flex items-center gap-2 mt-2 pt-2 border-t" :style="{ borderColor: 'var(--color-border-light)' }">
              <Clock class="w-2.5 h-2.5" :style="{ color: 'var(--color-text-tertiary)' }" />
              <span class="text-[9px]" :style="{ color: 'var(--color-text-tertiary)' }">
                {{ formatTime(note.updatedAt) }}
              </span>
            </div>
          </div>
        </div>

        <div v-else class="py-5 text-center">
          <div
            class="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-2"
            :style="{ background: 'var(--color-bg-tertiary)' }"
          >
            <FileText class="w-5 h-5" :style="{ color: 'var(--color-text-tertiary)' }" />
          </div>
          <p class="text-[12px] mb-1" :style="{ color: 'var(--color-text-secondary)' }">这一天没有笔记</p>
          <p class="text-[10px]" :style="{ color: 'var(--color-text-tertiary)' }">点击上方按钮创建一篇新笔记</p>
        </div>
      </div>
    </div>

    <div class="cho-statusbar justify-between">
      <span class="cho-statusbar-hint">
        点击日期查看当天笔记 · 点击笔记卡片打开编辑
      </span>
      <span class="cho-statusbar-meta">
        本月共 {{ monthStats.total }} 篇笔记
      </span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import {
  ChevronLeft, ChevronRight, Calendar, CalendarDays,
  FileText, Clock, Plus, HelpCircle, List, CalendarRange, Grid3x3
} from 'lucide-vue-next'
import {
  monthGrid, weekOfIso, dayRange, densityOf, addDays, addMonths,
  isoOf, isoOfTs, parseIso, startOfDayTs, daysInMonth, weekdayLabels,
  WEEK_START_MONDAY
} from '@/utils/calendarGrid.js'
import { resolveNoteDate, DATE_SOURCE } from '@/utils/dateAttribution.js'

const router = useRouter()
const noteStore = useNoteStore()

// ---------------------------------------------------------------------------
// 状态：全部用 `YYYY-MM-DD` 字符串当天身份
//
// 为什么不用 Date：
//   ① Date 是对象，每次 `new Date()` 都是新引用，放进 ref 会无谓地触发重算
//      （这就是旧实现「每分钟刷新会带着整个日历重渲染」的根源）；
//   ② 字符串可以直接比较相等，`cell.iso === todayIso` 就是「是不是今天」，
//      不再需要逐格构造 Date 再比三个分量；
//   ③ 跨视图保住选中日期只需要保住一个字符串。
// ---------------------------------------------------------------------------

/** 三种视图。`anchorIso` 是「当前看的那一段」的锚点日，选中日是 `selectedIso` */
const VIEW_MONTH = 'month'
const VIEW_WEEK = 'week'
const VIEW_AGENDA = 'agenda'

const viewMode = ref(VIEW_MONTH)
/** 今天的本地日历日（每分钟校准，但只在真的换日时才写 ref） */
const todayIso = ref(isoOfTs(new Date()))
/** 当前查看的月 / 周所在的锚点日 */
const anchorIso = ref(todayIso.value)
/** 选中的日期：切视图、翻页都不会动它 */
const selectedIso = ref(todayIso.value)

const viewModeItems = [
  { key: VIEW_MONTH, label: '月', title: '月视图', icon: Grid3x3 },
  { key: VIEW_WEEK, label: '周', title: '周视图（连续 7 天）', icon: CalendarRange },
  { key: VIEW_AGENDA, label: '议程', title: '议程视图（按日分组）', icon: List }
]

const weekdayHeader = weekdayLabels(WEEK_START_MONDAY)
const WEEKDAY_FULL = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/** ④ 级日期的解释文案（图例与卡片共用同一份口径） */
const inferredHint = '这篇笔记没有 frontmatter 日期 / 创建时间 / 标题日期，日历位置是按最近修改时间推测的'

/** 锚点日的年月日（非法时回落到今天，保证组件永远有东西可渲染） */
const anchorYmd = computed(() => parseIso(anchorIso.value) || parseIso(todayIso.value) || { year: 1970, month: 1, date: 1 })
const viewYear = computed(() => anchorYmd.value.year)
const viewMonth = computed(() => anchorYmd.value.month)

// ---------------------------------------------------------------------------
// 网格：纯内核算几何，本文件只负责「贴数据」
// ---------------------------------------------------------------------------

/** 月网格（行数按内核取最小，不再是恒定 6 行） */
const monthData = computed(() => monthGrid(viewYear.value, viewMonth.value, { weekStartsOn: WEEK_START_MONDAY }))

/**
 * 每一格的笔记：整张网格只在这里取一次。
 *
 * 旧实现里 `getDayNotes(day)` 是在模板里逐格调用的 —— 每渲染一次（包括
 * 「今天」跨日刷新）就是 42 次全库扫描。现在一次遍历把整月装进 Map，
 * 周视图 / 议程视图 / 底部面板全部复用这一份，切换视图零额外开销。
 *
 * 取数走 `noteStore.getNotesByDate`，它读的是索引里按**四级归属日期**
 * （frontmatter > birthtime > 标题日期 > updatedAt）算好的 dateKey，
 * 所以日历归格用的是「归属日期」而不是 `updatedAt`。
 */
const noteBuckets = computed(() => {
  const map = new Map()
  for (const cell of monthData.value.cells) {
    map.set(cell.iso, noteStore.getNotesByDate(cell.ts))
  }
  return map
})

/** 给单元格贴上笔记与密度（纯映射，不再触发任何取数） */
function decorate (cell) {
  const notes = noteBuckets.value.get(cell.iso) || []
  return { ...cell, notes, count: notes.length, density: densityOf(notes.length) }
}

const monthWeeks = computed(() => monthData.value.weeks.map(week => week.map(decorate)))
const weekColumns = computed(() => weekOfIso(anchorIso.value, { weekStartsOn: WEEK_START_MONDAY }).days.map(decorate))
const agendaGroups = computed(() => {
  const range = dayRange(monthData.value.monthStartIso, monthData.value.monthEndIso, { weekStartsOn: WEEK_START_MONDAY, inMonth: true })
  return range.map(decorate).filter(cell => cell.count > 0)
})

/** 本月统计：与网格共用同一次取数，不再另扫一遍全库 */
const monthStats = computed(() => {
  let days = 0
  let total = 0
  for (const cell of monthData.value.cells) {
    if (!cell.inMonth) continue
    const count = (noteBuckets.value.get(cell.iso) || []).length
    if (count > 0) {
      days += 1
      total += count
    }
  }
  return { days, total }
})

/** 全局四级来源直方图（读 store 里现成的统计，不重新解析正文） */
const sourceStats = computed(() => {
  // getDateSourceStats 直接读索引 Map，本身不建立响应式依赖 —— 借 noteBuckets
  // （它取数时读过索引版本号）把这条 computed 挂到同一个失效信号上
  void noteBuckets.value
  return noteStore.getDateSourceStats()
})
/** ④ 级（updatedAt）笔记总数：图例里给用户一个可见信号 */
const inferredTotal = computed(() => {
  const bySource = sourceStats.value && sourceStats.value.bySource ? sourceStats.value.bySource : {}
  return bySource[DATE_SOURCE.UPDATED_AT] || 0
})

// ---------------------------------------------------------------------------
// 选中日期
// ---------------------------------------------------------------------------

/** 选中日的笔记：优先复用网格已经取到的那一格，取不到（翻页后选中日不在视野内）才补一次 */
const selectedNotes = computed(() => {
  const hit = noteBuckets.value.get(selectedIso.value)
  if (hit) return hit
  const ymd = parseIso(selectedIso.value)
  if (!ymd) return []
  const ts = startOfDayTs(ymd.year, ymd.month, ymd.date)
  return ts === null ? [] : noteStore.getNotesByDate(ts)
})

/**
 * 选中日里每一篇是不是 ④ 级（日期为推测）。
 *
 * 只对「选中那一天」的笔记跑 `resolveNoteDate`（通常个位数），不整月跑 ——
 * 网格里已经拿到的是归属后的分组，再逐篇反解析一遍纯属浪费。
 */
const selectedInferredMap = computed(() => {
  const marks = new Map()
  let inferred = 0
  for (const note of selectedNotes.value) {
    const resolved = resolveNoteDate(note, {
      birthtime: note && note.birthtime !== undefined ? note.birthtime : null
    })
    const isInferred = resolved.source === DATE_SOURCE.UPDATED_AT
    if (isInferred) inferred += 1
    marks.set(note.id, isInferred)
  }
  return { marks, inferred }
})

const selectedInferred = computed(() => selectedInferredMap.value.inferred)

function isInferred (id) {
  return selectedInferredMap.value.marks.get(id) === true
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

const headerTitle = computed(() => {
  if (viewMode.value === VIEW_WEEK) {
    const start = parseIso(weekColumns.value.length > 0 ? weekColumns.value[0].iso : anchorIso.value)
    const end = parseIso(weekColumns.value.length > 0 ? weekColumns.value[6].iso : anchorIso.value)
    if (!start || !end) return ''
    const left = `${start.month}月${start.date}日`
    const right = start.year === end.year ? `${end.month}月${end.date}日` : `${end.year}年${end.month}月${end.date}日`
    return `${start.year}年${left} - ${right}`
  }
  const suffix = viewMode.value === VIEW_AGENDA ? ' · 议程' : ''
  return `${viewYear.value}年${viewMonth.value}月${suffix}`
})

/** 切视图：把锚点挪到选中日，保证刚点中的那天在新视图里仍然可见、仍然选中 */
function setView (mode) {
  if (mode !== viewMode.value) {
    anchorIso.value = selectedIso.value || anchorIso.value
  }
  viewMode.value = mode
}

function selectCell (cell) {
  selectedIso.value = cell.iso
  // 点到上个月 / 下个月的格子时跟着翻页（与旧行为一致）
  if (!cell.inMonth) anchorIso.value = cell.iso
}

/** 翻页：月视图 ±1 月，周视图 ±7 天，议程 ±1 月 */
function shiftAnchor (delta) {
  const ymd = anchorYmd.value
  if (viewMode.value === VIEW_WEEK) {
    const next = addDays(ymd.year, ymd.month, ymd.date, delta * 7)
    if (next) anchorIso.value = isoOf(next.year, next.month, next.date)
    return
  }
  const next = addMonths(viewYear.value, viewMonth.value, delta)
  if (!next) return
  // 3 月 31 日往前翻一月是 2 月 28/29 日，不能凭空造一个 2 月 31 日
  const date = Math.min(ymd.date, daysInMonth(next.year, next.month))
  anchorIso.value = isoOf(next.year, next.month, date)
}

function goToToday () {
  syncToday()
  anchorIso.value = todayIso.value
  selectedIso.value = todayIso.value
}

/**
 * 每分钟校准「今天」。
 *
 * 关键取舍：`todayIso` 是**字符串**，值没变时赋值不会触发 Vue 的重渲染，
 * 所以这里可以无条件赋值、省掉旧实现那一堆「比年月日」的判等代码；
 * 而网格 / 取数那条 computed 根本不读 `todayIso`（今天高亮是模板里
 * `cell.iso === todayIso` 算的），所以跨零点时只有「今天那一格」的样式变，
 * 42 次取数一次都不会重跑。
 */
function syncToday () {
  todayIso.value = isoOfTs(new Date())
}

function weekdayFull (cell) {
  const ts = Number(cell.ts)
  if (!Number.isFinite(ts)) return ''
  return WEEKDAY_FULL[new Date(ts).getDay()]
}

function densityDots (cell) {
  return Math.min(cell.count, 3)
}

function truncate (text, max) {
  const s = text === null || text === undefined ? '' : String(text)
  return s.length > max ? s.substring(0, max) + '...' : s
}

function formatSelectedDate () {
  const ymd = parseIso(selectedIso.value)
  if (!ymd) return '未选择日期'
  const ts = startOfDayTs(ymd.year, ymd.month, ymd.date)
  if (ts === null) return '未选择日期'
  const label = `${ymd.month}月${ymd.date}日 ${WEEKDAY_FULL[new Date(ts).getDay()]}`
  return selectedIso.value === todayIso.value ? `${label} · 今天` : label
}

function formatTime (dateStr) {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return '--:--'
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

function getNotePreview (content) {
  if (!content) return '暂无内容'
  const text = content.replace(/[#*`\[\]\-]/g, '').replace(/\n/g, ' ').trim()
  return text.length > 50 ? text.substring(0, 50) + '...' : text
}

function openNote (id) {
  noteStore.selectNote(id)
  router.push(`/editor/${id}`)
}

/** 入参既接受 `YYYY-MM-DD`（格子上的 + 按钮直接给 iso），也接受 Date（兼容旧调用） */
function createNoteForDate (date) {
  const iso = typeof date === 'string' ? date : isoOfTs(date || selectedIso.value)
  if (!iso) return
  const title = `${iso} 的笔记`
  // 已有同名日记则直接打开，避免重复创建
  const existing = noteStore.notes.find(n => n.title === title)
  if (existing) {
    openNote(existing.id)
    return
  }
  const note = noteStore.createNote('', title)
  router.push(`/editor/${note.id}`)
}

let todayTimer = null

onMounted(() => {
  syncToday()
  // 每分钟校准一次「今天」，并在窗口重新可见时立刻校准（休眠唤醒后补一次）。
  // 见 syncToday()：这次校准不再牵动整张网格的重算。
  todayTimer = setInterval(syncToday, 60 * 1000)
  document.addEventListener('visibilitychange', syncToday)
})

onUnmounted(() => {
  if (todayTimer) {
    clearInterval(todayTimer)
    todayTimer = null
  }
  document.removeEventListener('visibilitychange', syncToday)
})
</script>

<style scoped>
.day-cell {
  min-height: 80px;
}

.day-cell:hover {
  background: var(--color-surface-hover);
}

/* ---- 密度：0 / 1-2 / ≥3 三档底色，≥3 篇再叠一层强调。
       写在「非本月」之前是刻意的：非本月的格子无论有多少篇都必须保持可区分 ---- */
.day-density-low {
  background: var(--color-primary-surface);
}

.day-density-high {
  background: var(--color-primary-surface);
  background: color-mix(in srgb, var(--color-primary) 22%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-primary) 30%, transparent);
}

/* ---- 非本月：换底色 + 条目降饱和，而不是把整格（含笔记条目）一起压暗 ---- */
.day-other-month,
.day-other-month.day-density-low,
.day-other-month.day-density-high {
  background: var(--color-bg-secondary);
  box-shadow: none;
}

.day-other-month .day-note {
  opacity: 0.6;
}

.day-selected {
  background: var(--color-primary-surface);
  border: 1px solid var(--color-primary);
}

.day-today {
  box-shadow: inset 0 0 0 1px var(--color-border);
}

.day-number-today {
  background: var(--color-primary);
  color: white !important;
  font-weight: 600;
}

.day-number-selected {
  background: var(--color-primary);
  color: white !important;
  font-weight: 600;
}

.day-number-other {
  color: var(--color-text-tertiary);
}

.day-number:not(.day-number-today):not(.day-number-selected):not(.day-number-other) {
  color: var(--color-text-primary);
}

.day-cell:hover .day-number:not(.day-number-today):not(.day-number-selected) {
  background: var(--color-bg-tertiary);
}

.day-cell:hover .day-add-btn {
  opacity: 1;
}

.day-note {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- 密度点 ---- */
.density-strip {
  transition: opacity 0.2s ease;
}

.day-cell:hover .density-strip {
  opacity: 0.8;
}

.density-dot {
  width: 4px;
  height: 4px;
  border-radius: 9999px;
  background: var(--color-primary);
  opacity: 0.45;
}

.density-dot-strong {
  width: 5px;
  height: 5px;
  opacity: 1;
}

.density-swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  border: 1px solid var(--color-border);
}

.density-swatch-none {
  background: transparent;
}

.density-swatch-low {
  background: var(--color-primary-surface);
}

.density-swatch-high {
  background: var(--color-primary-surface);
  background: color-mix(in srgb, var(--color-primary) 45%, transparent);
}

/* ---- 视图切换按钮 ---- */
.mode-btn {
  color: var(--color-text-tertiary);
}

.mode-btn:hover {
  color: var(--color-text-primary);
}

.mode-btn-active {
  background: var(--color-surface);
  color: var(--color-primary);
}

/* ---- 周视图 ---- */
.week-col {
  background: var(--color-bg-secondary);
  border: 1px solid transparent;
}

.week-col:hover {
  background: var(--color-surface-hover);
}

.week-col-other {
  opacity: 0.75;
}

.week-col-today {
  border-color: color-mix(in srgb, var(--color-primary) 45%, transparent);
}

.week-col-selected {
  border-color: var(--color-primary);
  background: var(--color-primary-surface);
}

.week-col-busy .week-col-head {
  background: var(--color-primary-surface);
}

.week-note {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- 议程视图 ---- */
.agenda-note:hover {
  border-left-color: var(--color-primary) !important;
}

.note-card:hover {
  border-color: var(--color-primary) !important;
}

.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
