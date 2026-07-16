/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "renderer-does-not-import-privileged-processes",
      severity: "error",
      from: { path: "^(apps/(desktop/src/renderer|web)|packages/renderer)" },
      to: { path: "^apps/desktop/src/(main|preload)" },
    },
    {
      name: "packages-do-not-import-apps",
      severity: "error",
      from: { path: "^packages" },
      to: { path: "^apps" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(build|dist|node_modules|out|release)(/|$)" },
  },
};
