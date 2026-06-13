import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        accent:   '#0052cc',
        'accent-lt': '#e6f0ff',
        panel:    'rgba(255,255,255,0.94)',
        danger:   '#cc2200',
        warn:     '#ff8800',
        success:  '#00875a',
      },
      backdropBlur: { panel: '6px' },
    },
  },
  plugins: [],
}
export default config
