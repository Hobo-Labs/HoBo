import os from 'node:os';
import path from 'node:path';
export default {
	cacheDir:
		process.env.BROKER_MUTANT_CACHE ??
		path.join(os.tmpdir(), 'hobo-broker-vitest-cache'),
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
		maxWorkers: 1,
		fileParallelism: false,
	},
};
