import { defineConfig } from 'vitest/config'

// 独立配置：不加载 vite.config.ts 的 react/tailwind 插件，
// 仅用于纯函数单测（node 环境，无需 jsdom）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
