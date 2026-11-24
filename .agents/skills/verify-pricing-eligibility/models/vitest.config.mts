import path from 'node:path';
const pricingRoot = process.env.PRICING_ELIGIBILITY_PRICING_ROOT ?? path.resolve('packages/pricing');
export default {
  resolve: { alias: { '@hobo/pricing': path.resolve(pricingRoot, 'src/index.ts') } },
  test: { environment: 'node', include: ['test/**/*.test.ts','contracts/consumer/**/*.test.ts'], maxWorkers: 1, fileParallelism: false }
};
