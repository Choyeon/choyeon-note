/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: 'var(--cho-background)',
        foreground: 'var(--cho-foreground)',
        card: 'var(--cho-card)',
        'card-foreground': 'var(--cho-card-foreground)',
        popover: 'var(--cho-popover)',
        'popover-foreground': 'var(--cho-popover-foreground)',
        primary: 'var(--cho-primary)',
        'primary-foreground': 'var(--cho-primary-foreground)',
        muted: 'var(--cho-muted)',
        'muted-foreground': 'var(--cho-muted-foreground)',
        border: 'var(--cho-border)',
        input: 'var(--cho-input)',
        ring: 'var(--cho-ring)',
      },
      borderRadius: {
        sm: 'var(--cho-radius-sm)',
        md: 'var(--cho-radius-md)',
        lg: 'var(--cho-radius-lg)',
        xl: 'var(--cho-radius-xl)',
      },
      fontFamily: {
        sans: ['Segoe UI', 'Microsoft YaHei', 'PingFang SC', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['Cascadia Code', 'SF Mono', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
