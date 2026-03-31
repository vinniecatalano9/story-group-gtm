/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        brand: {
          50: '#e8eeff',
          100: '#d4e0ff',
          400: '#5B8DEF',
          500: '#1856FF',
          600: '#1248D9',
          700: '#0D3AB3',
          800: '#0A2D8C',
          900: '#071F66',
        },
        surface: {
          DEFAULT: 'rgba(255, 255, 255, 0.06)',
          light: 'rgba(255, 255, 255, 0.1)',
          lighter: 'rgba(255, 255, 255, 0.15)',
        },
      },
    },
  },
  plugins: [],
};
