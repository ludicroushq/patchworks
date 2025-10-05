import neostandard, { resolveIgnoresFromGitignore } from "neostandard";
import reactHooksPlugin from "eslint-plugin-react-hooks";

const gitignorePatterns = resolveIgnoresFromGitignore();
gitignorePatterns.push("dist/**/*");

export default [
  ...neostandard({
    ignores: gitignorePatterns,
    ts: true,
    noStyle: true,
  }),
  {
    files: ["**/*.{ts,mts,cts,tsx,mtsx,ctsx}"],
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          disallowTypeAnnotations: false,
          fixStyle: "separate-type-imports",
          prefer: "type-imports",
        },
      ],
    },
  },
  {
    plugins: {
      "react-hooks": reactHooksPlugin,
    },
    rules: reactHooksPlugin.configs.recommended.rules,
  },
];
