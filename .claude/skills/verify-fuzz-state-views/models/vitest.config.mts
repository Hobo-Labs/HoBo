import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', pool: 'forks', testTimeout: 10000, hookTimeout: 10000, reporters: ['dot'] } });
