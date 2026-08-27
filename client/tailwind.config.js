// Scoped to a single module — Grid Watch was authored with Tailwind utilities
// while the rest of the app uses hand-written CSS. `preflight: false` prevents
// Tailwind's base reset from stomping the existing global styles.
export default {
  content: ['./src/modules/BelizeGridWatch.jsx'],
  corePlugins: { preflight: false },
  theme: { extend: {} },
  plugins: [],
};
