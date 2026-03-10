const grafanaConfig = require("@grafana/eslint-config/flat");

/**
 * @type {Array<import('eslint').Linter.Config>}
 */
module.exports = [
  {
    ignores: [".github", ".yarn", "**/build/", "**/compiled/", "**/dist/", ".config/"],
  },
  ...grafanaConfig,
  {
    name: "yuuki-slurm-app/defaults",
    files: ["**/*.{ts,tsx,js,jsx}"],
    rules: {
      "react/prop-types": "off",
      // React 17+ JSX transform does not require React in scope
      "react/react-in-jsx-scope": "off",
      // Downgrade exhaustive-deps to warning to match pre-migration behavior
      "react-hooks/exhaustive-deps": "warn",
      // Disable purity rule that flags Date.now() in render helpers
      "react-hooks/purity": "off",
    },
  },
];
