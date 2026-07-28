import { defineConfig } from 'vitest/config'

// 组件测试独立配置：jsdom 环境（需 DOM + iframe），
// 不加载 vite 的 react/tailwind 插件，仅用 esbuild 自动 jsx 转译。
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.tsx'],
  },
})
