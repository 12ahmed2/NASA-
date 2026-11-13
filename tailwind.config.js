/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        forest: '#163D2A',
        greenLight: '#8BCB88',
        beige: '#F3F0E6',
        night: '#101813',
      },
      boxShadow: {
        soft: '0 24px 60px rgba(8, 18, 13, 0.22)',
      },
    },
  },
  plugins: [],
};
