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
        background: 'var(--color-bg)',
        foreground: 'var(--color-text-primary)',
        secondary: 'var(--color-secondary)',
        'secondary-foreground': 'var(--color-text-on-primary)',
        accent: 'var(--color-accent)',
        'accent-foreground': 'var(--color-text-primary)',
        muted: 'var(--color-bg-tertiary)',
        'muted-foreground': 'var(--color-text-tertiary)',
        card: 'var(--card-bg)',
        'card-foreground': 'var(--color-text-primary)',
        popover: 'var(--color-bg)',
        'popover-foreground': 'var(--color-text-primary)',
        primary: 'var(--color-primary)',
        'primary-foreground': 'var(--color-text-on-primary)',
        border: 'var(--color-border)',
        input: 'var(--color-border-light)',
        ring: 'var(--color-primary-ring)',
      },
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
