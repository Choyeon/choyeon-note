<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div 
      class="min-h-[52px] px-6 py-3 flex items-center gap-4 border-b acrylic-content shrink-0"
      :style="{ borderColor: 'var(--color-border-light)' }"
    >
      <div class="flex items-center gap-2">
        <button 
          class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-95"
          @click="prevMonth"
        >
          <ChevronLeft class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
        <button 
          class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-95"
          @click="nextMonth"
        >
          <ChevronRight class="w-4 h-4" :style="{ color: 'var(--color-text-secondary)' }" />
        </button>
      </div>

      <h2 class="text-lg font-semibold tracking-tight min-w-[120px]" :style="{ color: 'var(--color-text-primary)' }">
        {{ currentYear }}年{{ currentMonth + 1 }}月
      </h2>

      <button 
        class="px-3 py-1.5 rounded-lg cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-95"
        :style="{ background: 'var(--color-primary-surface)' }"
        @click="goToToday"
      >
        <span class="text-[12px] font-semibold" :style="{ color: 'var(--color-primary)' }">今天</span>
      </button>

      <div class="flex-1"></div>

      <div class="flex items-center gap-4">
        <div class="flex items-center gap-2">
          <div class="w-2 h-2 rounded-full" :style="{ background: 'var(--color-primary)' }"></div>
          <span class="text-[11px]" :style="{ color: 'var(--color-text-tertiary)' }">有笔记</span>
        </div>
        <div class="flex items-center gap-2">
          <Calendar class="w-3.5 h-3.5" :style="{ color: 'var(--color-text-tertiary)' }" />
          <span class="text-[11px] font-mono" :style="{ color: 'var(--color-text-tertiary)' }">
            {{ noteCountThisMonth }} / {{ daysInMonth }} 天
          </span>
        </div>
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-hidden flex flex-col acrylic-content">
      <div class="px-6 py-3 shrink-0">
        <div class="grid grid-cols-7 gap-1">
          <div 
            v-for="(day, idx) in weekDays" 
            :key="day"
            class="h-6 flex items-center justify-center text-[10px] font-semibold uppercase tracking-wider"
            :style="{ color: idx >= 5 ? 'var(--state-error)' : 'var(--color-text-tertiary)' }"
          >{{ day }}</div>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto cho-scrollbar px-6 pb-6 pt-1">
        <div 
          v-for="(week, weekIndex) in calendarDays" 
          :key="weekIndex" 
          class="grid grid-cols-7 gap-1 mb-0.5"
        >
          <div 
            v-for="(day, dayIndex) in week" 
            :key="dayIndex"
            class="day-cell relative rounded-lg cursor-pointer transition-all duration-200"
            :class="{
              'day-selected': isSelected(day),
              'day-other-month': !day.isCurrentMonth
            }"
            @click="selectDate(day)"
          >
            <div class="day-content flex flex-col items-center justify-start pt-1.5 pb-1.5 px-1">
              <div 
                class="day-number flex items-center justify-center w-6 h-6 rounded-full text-[12px] font-medium transition-all duration-200"
                :class="{
                  'day-number-today': isToday(day),
                  'day-number-selected': isSelected(day),
                  'day-number-other': !day.isCurrentMonth
                }"
              >
                {{ day.date }}
              </div>
              
              <div class="w-full mt-1 min-h-[36px] flex flex-col gap-0.5">
                <div 
                  v-for="(note, noteIdx) in getDayNotes(day).slice(0, 2)" 
                  :key="note.id"
                  class="day-note px-1 py-0.5 rounded text-[9px] font-medium truncate transition-all duration-200 hover:opacity-80"
                  :style="{ 
                    background: 'var(--color-bg-tertiary)',
                    color: 'var(--color-text-secondary)'
                  }"
                  @click.stop="openNote(note.id)"
                >
                  {{ note.title.length > 8 ? note.title.substring(0, 8) + '...' : note.title }}
                </div>
                <div 
                  v-if="day.noteCount > 2"
                  class="text-[9px] text-center"
                  :style="{ color: 'var(--color-text-tertiary)' }"
                >
                  +{{ day.noteCount - 2 }}
                </div>
              </div>
            </div>

            <div 
              v-if="day.noteCount > 0"
              class="heatmap-dots absolute bottom-1.5 left-1/2 -translate-x-1/2 flex gap-0.5"
            >
              <div 
                v-for="i in Math.min(day.noteCount, 4)" 
                :key="i"
                class="w-1 h-1 rounded-full"
                :style="{ 
                  background: 'var(--color-primary)',
                  opacity: 0.3 + (i * 0.15)
                }"
              ></div>
            </div>

            <div 
              class="today-indicator absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-3 h-0.5 rounded-full"
              :style="{
                background: isToday(day) && !isSelected(day) ? 'var(--color-primary)' : 'transparent'
              }"
            ></div>
          </div>
        </div>
      </div>
    </div>

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
              {{ selectedDateNotes.length }} 篇笔记
            </div>
          </div>
          <div class="flex-1"></div>
          <button 
            class="px-3 py-1.5 rounded-lg text-[12px] font-medium cursor-pointer transition-all duration-200 hover:bg-[var(--color-surface-hover)] active:scale-95"
            :style="{ background: 'var(--color-primary)', color: 'white' }"
            @click="createNoteForDate"
          >
            <span class="flex items-center gap-1">
              <Plus class="w-3.5 h-3.5" />
              新建笔记
            </span>
          </button>
        </div>

        <div 
          v-if="selectedDateNotes.length > 0"
          class="flex gap-2 overflow-x-auto cho-scrollbar pb-2 -mx-1 px-1"
        >
          <div 
            v-for="note in selectedDateNotes" 
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
        本月共 {{ totalNotesThisMonth }} 篇笔记
      </span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { 
  ChevronLeft, ChevronRight, Calendar, CalendarDays, 
  FileText, Clock, Plus
} from 'lucide-vue-next'

const router = useRouter()
const noteStore = useNoteStore()

const today = new Date()
const currentYear = ref(today.getFullYear())
const currentMonth = ref(today.getMonth())
const selectedDate = ref(new Date())

const weekDays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

const daysInMonth = computed(() => {
  return new Date(currentYear.value, currentMonth.value + 1, 0).getDate()
})

const calendarDays = computed(() => {
  const year = currentYear.value
  const month = currentMonth.value
  
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0)
  
  let startDayOfWeek = firstDay.getDay()
  startDayOfWeek = startDayOfWeek === 0 ? 6 : startDayOfWeek - 1
  
  const days = []
  const prevMonthLastDay = new Date(year, month, 0).getDate()
  
  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    const date = prevMonthLastDay - i
    const notesForDay = getNotesForDate(year, month - 1, date)
    days.push({
      date,
      month: month - 1,
      year: month === 0 ? year - 1 : year,
      isCurrentMonth: false,
      noteCount: notesForDay.length
    })
  }
  
  for (let i = 1; i <= lastDay.getDate(); i++) {
    const notesForDay = getNotesForDate(year, month, i)
    days.push({
      date: i,
      month,
      year,
      isCurrentMonth: true,
      noteCount: notesForDay.length
    })
  }
  
  const remainingDays = 42 - days.length
  for (let i = 1; i <= remainingDays; i++) {
    const notesForDay = getNotesForDate(year, month + 1, i)
    days.push({
      date: i,
      month: month + 1,
      year: month === 11 ? year + 1 : year,
      isCurrentMonth: false,
      noteCount: notesForDay.length
    })
  }
  
  const weeks = []
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7))
  }
  
  return weeks
})

const selectedDateNotes = computed(() => {
  return noteStore.getNotesByDate(selectedDate.value)
})

const noteCountThisMonth = computed(() => {
  const datesWithNotes = new Set()
  noteStore.notes.forEach(note => {
    const d = new Date(note.updatedAt)
    if (d.getFullYear() === currentYear.value && d.getMonth() === currentMonth.value) {
      datesWithNotes.add(d.getDate())
    }
  })
  return datesWithNotes.size
})

const totalNotesThisMonth = computed(() => {
  let count = 0
  noteStore.notes.forEach(note => {
    const d = new Date(note.updatedAt)
    if (d.getFullYear() === currentYear.value && d.getMonth() === currentMonth.value) {
      count++
    }
  })
  return count
})

function getNotesForDate(year, month, date) {
  const targetDate = new Date(year, month, date)
  return noteStore.notes.filter(note => {
    const noteDate = new Date(note.updatedAt)
    return noteDate.toDateString() === targetDate.toDateString()
  })
}

function getDayNotes(day) {
  return getNotesForDate(day.year, day.month, day.date)
}

function isToday(day) {
  return day.date === today.getDate() && 
         day.month === today.getMonth() && 
         day.year === today.getFullYear()
}

function isSelected(day) {
  return day.date === selectedDate.value.getDate() && 
         day.month === selectedDate.value.getMonth() && 
         day.year === selectedDate.value.getFullYear()
}

function selectDate(day) {
  selectedDate.value = new Date(day.year, day.month, day.date)
  if (!day.isCurrentMonth) {
    currentMonth.value = day.month
    currentYear.value = day.year
  }
}

function prevMonth() {
  if (currentMonth.value === 0) {
    currentMonth.value = 11
    currentYear.value--
  } else {
    currentMonth.value--
  }
}

function nextMonth() {
  if (currentMonth.value === 11) {
    currentMonth.value = 0
    currentYear.value++
  } else {
    currentMonth.value++
  }
}

function goToToday() {
  currentYear.value = today.getFullYear()
  currentMonth.value = today.getMonth()
  selectedDate.value = new Date()
}

function formatSelectedDate() {
  const d = selectedDate.value
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  const isToday = d.toDateString() === today.toDateString()
  return `${d.getMonth() + 1}月${d.getDate()}日 ${weekdays[d.getDay()]}${isToday ? ' · 今天' : ''}`
}

function formatTime(dateStr) {
  const d = new Date(dateStr)
  const hours = d.getHours().toString().padStart(2, '0')
  const minutes = d.getMinutes().toString().padStart(2, '0')
  return `${hours}:${minutes}`
}

function getNotePreview(content) {
  if (!content) return '暂无内容'
  const text = content.replace(/[#*`\[\]\-]/g, '').replace(/\n/g, ' ').trim()
  return text.length > 50 ? text.substring(0, 50) + '...' : text
}

function openNote(id) {
  noteStore.selectNote(id)
  router.push(`/editor/${id}`)
}

async function createNoteForDate() {
  const dateStr = selectedDate.value.toISOString().split('T')[0]
  const title = `${dateStr} 的笔记`
  const note = noteStore.createNote('', title)
  router.push(`/editor/${note.id}`)
}
</script>

<style scoped>
.day-cell {
  min-height: 80px;
}

.day-cell:hover {
  background: var(--color-surface-hover);
}

.day-selected {
  background: var(--color-primary-surface);
  border: 1px solid var(--color-primary);
}

.day-other-month {
  opacity: 0.35;
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

.day-note {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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

.heatmap-dots {
  transition: opacity 0.2s ease;
}

.day-cell:hover .heatmap-dots {
  opacity: 0.8;
}
</style>
