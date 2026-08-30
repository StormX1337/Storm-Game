export default {
  plugins: {
    // Inlines `@import` before Tailwind runs, so the shared design tokens in
    // @storm/ui can use @layer and still land in the right cascade layer.
    'postcss-import': {},
    tailwindcss: {},
    autoprefixer: {},
  },
};
