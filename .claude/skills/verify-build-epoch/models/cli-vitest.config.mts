import path from 'node:path';
import { defineConfig, mergeConfig } from 'vitest/config';
import cliConfig from '../../../../packages/cli/vitest.config.js';
const component = process.env.BUILD_EPOCH_COMPONENT_ROOT ?? path.resolve('packages/componentize');
export default mergeConfig(cliConfig, defineConfig({ resolve: { alias: { '@hobo/componentize': path.join(component, 'src/index.ts') } } }));
