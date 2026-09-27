/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  // 应用写的是 documentElement 上的 data-theme="dark"，不是祖先的 .dark 类。
  // 配成 'class' 会让模板里所有 dark: 工具类全部失效（实际生效的只有 CSS 变量兜底）。
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        full: 'var(--radius-full)',
      },
      fontFamily: {
        sans: ['var(--font-body)'],
        mono: ['var(--font-mono)'],
      },
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        float: 'var(--shadow-float)',
        card: 'var(--card-shadow)',
      },
    },
  },
  plugins: [],
}
