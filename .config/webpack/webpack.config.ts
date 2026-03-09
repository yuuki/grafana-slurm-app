// @ts-nocheck
const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const ReplaceInFileWebpackPlugin = require('replace-in-file-webpack-plugin');
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const pluginJson = require('../../src/plugin.json');

module.exports = (env) => {
  const isProduction = env.production === true;

  return {
    mode: isProduction ? 'production' : 'development',
    devtool: isProduction ? 'source-map' : 'eval-source-map',
    context: path.resolve(__dirname, '../..'),

    entry: {
      module: './src/module.tsx',
    },

    output: {
      path: path.resolve(__dirname, '../../dist'),
      filename: '[name].js',
      library: {
        type: 'amd',
      },
      publicPath: `public/plugins/${pluginJson.id}/`,
      uniqueName: pluginJson.id,
      clean: true,
    },

    externals: [
      'lodash',
      'jquery',
      'moment',
      'slate',
      'emotion',
      '@emotion/css',
      '@emotion/react',
      'prismjs',
      'slate-plain-serializer',
      '@grafana/slate-react',
      'react',
      'react-dom',
      'react-redux',
      'redux',
      'rxjs',
      'react-router',
      'react-router-dom',
      'd3',
      'angular',
      '@grafana/data',
      '@grafana/ui',
      '@grafana/runtime',
      function (_context, request, callback) {
        const prefix = 'grafana/';
        if (request.indexOf(prefix) === 0) {
          return callback(null, request.substring(prefix.length));
        }
        callback();
      },
    ],

    resolve: {
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
    },

    module: {
      rules: [
        {
          test: /\.[tj]sx?$/,
          exclude: /node_modules/,
          use: {
            loader: 'swc-loader',
            options: {
              jsc: {
                parser: {
                  syntax: 'typescript',
                  tsx: true,
                  decorators: true,
                },
                target: 'es2021',
                transform: {
                  react: {
                    runtime: 'automatic',
                  },
                },
              },
            },
          },
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
        {
          test: /\.svg$/,
          type: 'asset/source',
        },
        {
          test: /\.(png|jpe?g|gif|woff2?|ttf|eot)$/,
          type: 'asset/resource',
        },
      ],
    },

    plugins: [
      new CopyWebpackPlugin({
        patterns: [
          { from: 'src/plugin.json', to: '.' },
          { from: 'src/img', to: 'img', noErrorOnMissing: true },
          { from: 'README.md', to: '.', noErrorOnMissing: true },
          { from: 'CHANGELOG.md', to: '.', noErrorOnMissing: true },
          { from: 'LICENSE', to: '.', noErrorOnMissing: true },
        ],
      }),
      new ReplaceInFileWebpackPlugin([
        {
          dir: path.resolve(__dirname, '../../dist'),
          files: ['plugin.json'],
          rules: [
            { search: '%VERSION%', replace: require('../../package.json').version },
            { search: '%TODAY%', replace: new Date().toISOString().substring(0, 10) },
          ],
        },
      ]),
      new ForkTsCheckerWebpackPlugin({
        typescript: {
          configFile: path.resolve(__dirname, '../../tsconfig.json'),
        },
      }),
    ],
  };
};
