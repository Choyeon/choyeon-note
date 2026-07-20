<template>
  <div class="h-full flex flex-col overflow-hidden">
    <div class="flex-1 min-h-0 overflow-y-auto no-scrollbar acrylic-content flex flex-col">
      <div class="px-8 py-6 pb-4 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <button 
            class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
            @click="prevMonth"
          >
            <ChevronLeft class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
          </button>
          <span class="text-2xl font-semibold" :style="{ color: 'var(--color-text-primary)' }">
            {{ currentYear }}年{{ currentMonth + 1 }}月
          </span>
          <button 
            class="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
            @click="nextMonth"
          >
            <ChevronRight class="w-[18px] h-[18px]" :style="{ color: 'var(--color-text-secondary)' }" />
          </button>
        </div>
        <button 
          class="px-4 py-1.5 rounded-lg cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
          :style="{ background: 'var(--color-primary-lighter)' }"
          @click="goToToday"
        >
          <span class="text-[13px] font-medium" :style="{ color: 'var(--color-primary)' }">今天</span>
        </button>
      </div>

      <div class="px-8 pb-6">
        <div class="grid grid-cols-7 gap-0 mb-1">
          <div 
            v-for="day in weekDays" 
            :key="day"
            class="h-8 flex items-center justify-center text-[12px] font-medium"
            :style="{ color: 'var(--color-text-tertiary)' }"
          >{{ day }}</div>
        </div>

        <div v-for="(week, weekIndex) in calendarDays" :key="weekIndex" class="grid grid-cols-7 gap-0">
          <div 
            v-for="(day, dayIndex) in week" 
            :key="dayIndex"
            class="h-10 flex flex-col items-center justify-center rounded-lg cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
            :class="{ 'day-today': isToday(day) }"
            @click="selectDate(day)"
          >
            <span 
              class="text-[14px]"
              :style="{ color: day.isCurrentMonth ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' }"
            >{{ day.date }}</span>
            <div 
              v-if="day.hasNotes" 
              class="w-1 h-1 rounded-full mt-0.5"
              :style="{ background: isToday(day) ? 'white' : 'var(--color-primary)' }"
            ></div>
          </div>
        </div>
      </div>

      <div class="h-px mx-8" :style="{ background: 'var(--color-border-light)' }"></div>

      <div class="px-8 py-5">
        <div class="text-[15px] font-semibold mb-3" :style="{ color: 'var(--color-text-primary)' }">
          {{ formatSelectedDate() }}
        </div>

        <div 
          v-for="note in selectedDateNotes" 
          :key="note.id"
          class="flex items-center gap-3 h-11 px-4 border-b cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
          :style="{ borderColor: 'var(--color-border-light)' }"
          @click="openNote(note.id)"
        >
          <FileText 
            class="w-4 h-4 flex-shrink-0" 
            :style="{ color: note.id === currentNoteId ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }" 
          />
          <div class="flex-1 min-w-0 flex flex-col">
            <span 
              class="text-[14px] font-medium whitespace-nowrap overflow-hidden text-ellipsis"
              :style="{ color: note.id === currentNoteId ? 'var(--color-primary)' : 'var(--color-text-secondary)' }"
            >{{ note.title }}</span>
            <span class="text-[11px]" :style="{ color: 'var(--color-text-tertiary)' }">
              {{ note.folder || '根目录' }}/
            </span>
          </div>
        </div>

        <div v-if="selectedDateNotes.length === 0" class="py-8 text-center">
          <span class="text-[13px]" :style="{ color: 'var(--color-text-tertiary)' }">这一天没有笔记</span>
        </div>
      </div>
    </div>

    <div 
      class="min-h-7 px-6 py-1 flex items-center border-t"
      :style="{ 
        borderColor: 'var(--color-border-light)', 
        background: 'rgba(240,242,245,0.65)' 
      }"
    >
      <span class="text-[11px] whitespace-nowrap" :style="{ color: 'var(--color-text-primary)' }">
        {{ noteCountThisMonth }} 篇笔记 · {{ currentMonth + 1 }} 月共 {{ noteCountThisMonth }} 条笔记
      </span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useNoteStore } from '@/stores/note'
import { ChevronLeft, ChevronRight, FileText } from 'lucide-vue-next'

const router = useRouter()
const noteStore = useNoteStore()

const today = new Date()
const currentYear = ref(today.getFullYear())
const currentMonth = ref(today.getMonth())
const selectedDate = ref(new Date())

const weekDays = ['一', '二', '三', '四', '五', '六', '日']

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
    days.push({
      date,
      month: month - 1,
      year: month === 0 ? year - 1 : year,
      isCurrentMonth: false,
      hasNotes: hasNotesOnDate(year, month - 1, date)
    })
  }
  
  for (let i = 1; i <= lastDay.getDate(); i++) {
    days.push({
      date: i,
      month,
      year,
      isCurrentMonth: true,
      hasNotes: hasNotesOnDate(year, month, i)
    })
  }
  
  const remainingDays = 42 - days.length
  for (let i = 1; i <= remainingDays; i++) {
    days.push({
      date: i,
      month: month + 1,
      year: month === 11 ? year + 1 : year,
      isCurrentMonth: false,
      hasNotes: hasNotesOnDate(year, month + 1, i)
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

const currentNoteId = computed(() => noteStore.currentNoteId)

const noteCountThisMonth = computed(() => {
  let count = 0
  noteStore.notes.forEach(note => {
    const d = new Date(note.updatedAt)
    if (d.getFullYear() === currentYear.value && d.getMonth() === currentMonth.value) {
      count++
    }
  })
  return count
})

function hasNotesOnDate(year, month, date) {
  const targetDate = new Date(year, month, date)
  return noteStore.notes.some(note => {
    const noteDate = new Date(note.updatedAt)
    return noteDate.toDateString() === targetDate.toDateString()
  })
}

function isToday(day) {
  return day.date === today.getDate() && 
         day.month === today.getMonth() && 
         day.year === today.getFullYear() &&
         day.isCurrentMonth
}

function selectDate(day) {
  selectedDate.value = new Date(day.year, day.month, day.date)
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
  const isToday = d.toDateString() === today.toDateString()
  return `${d.getMonth() + 1}月${d.getDate()}日${isToday ? ' · 今天' : ''}`
}

function openNote(id) {
  noteStore.selectNote(id)
  router.push(`/editor/${id}`)
}
</script>

<style scoped>
.day-today {
  background: var(--color-primary);
}

.day-today span {
  color: white !important;
  font-weight: 600;
}
</style>
