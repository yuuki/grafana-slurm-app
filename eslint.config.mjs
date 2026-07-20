import grafanaConfig from '@grafana/eslint-config';

export default [
  {
    ignores: ['.github', '.yarn', '**/build/', '**/compiled/', '**/dist/', '.config/'],
  },
  ...grafanaConfig,
  {
    name: 'yuuki-slurm-app/defaults',
    files: ['**/*.{ts,tsx,js,jsx}'],
    rules: {
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
];
