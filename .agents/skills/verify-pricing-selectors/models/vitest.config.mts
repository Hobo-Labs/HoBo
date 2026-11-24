export default { test: { environment: 'node', include: ['test/**/*.test.ts','contracts/consumer/**/*.test.ts'], maxWorkers: 1, fileParallelism: false } };
