/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Montserrat', 'system-ui', 'sans-serif'],
        serif: ['Playfair Display', 'Georgia', 'serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        // Story Group brand — pink scale centered on #FF2257
        brand: {
          50:  '#FFE4EC',
          100: '#FFC9D8',
          200: '#FFA3BB',
          300: '#FF7B96',
          400: '#FF4A77',
          500: '#FF2257',
          600: '#E0144A',
          700: '#B80E3D',
          800: '#8C0A2E',
          900: '#5C0620',
        },
        coral: {
          400: '#FF8A5A',
          500: '#FF743F',
          600: '#E55A28',
        },
        navy: {
          DEFAULT: '#00193B',
          card:    '#0D1F3C',
          border:  '#2A3F5F',
        },
        body: '#E8ECF1',
        muted: '#8A99B0',
        surface: {
          DEFAULT: 'rgba(255, 255, 255, 0.06)',
          light:   'rgba(255, 255, 255, 0.1)',
          lighter: 'rgba(255, 255, 255, 0.15)',
        },
      },
    },
  },
  plugins: [],
};
