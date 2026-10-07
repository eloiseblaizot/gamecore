/** Vérifications rapides avant chaque commit (le CI refait tout, plus le typage et les tests). */
export default {
  "*.{ts,tsx,js,mjs}": ["prettier --write", "eslint --max-warnings=0 --no-warn-ignored"],
  "*.{json,md,yml,yaml,css,html}": ["prettier --write"],
};
