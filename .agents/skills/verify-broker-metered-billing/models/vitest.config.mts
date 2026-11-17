import path from 'node:path';
const pricingRoot = process.env.BROKER_METER_VERIFY_PRICING_ROOT ?? path.resolve('packages/pricing');
export default {
  resolve: { alias: { '@hobo/pricing': path.resolve(pricingRoot, 'src/index.ts') } },
  test: { environment: 'node', include: ['test/**/*.test.ts'], maxWorkers: 1, fileParallelism: false }
};
