import type { Configuration } from 'webpack';
import { merge } from 'webpack-merge';
import grafanaConfig from './.config/webpack/webpack.config.ts';

// Grafana provides these as shared modules; bundling React 18's copy breaks under React 19 (Grafana 13).
// webpack-merge appends them after the externals from .config.
const config = (env: Record<string, unknown>): Configuration =>
  merge(grafanaConfig(env), {
    externals: ['react/jsx-runtime', 'react/jsx-dev-runtime'],
  });

export default config;
