// MD3 のカラートークンを web/src/theme/colors.css に生成する(Material Theme Builder と同じ計算)。
// 使い方: node web/scripts/gen-theme.mjs  シードカラーを変えたら実行し直す
import { writeFileSync } from 'node:fs';
import { register } from 'node:module';

// このライブラリは拡張子なしで import しており Node からそのまま読めないため、.js を補う
register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function resolve(s, c, next) {
      try { return await next(s, c); }
      catch (e) { if (s.startsWith('.') && !s.endsWith('.js')) return next(s + '.js', c); throw e; }
    }`),
);
const { argbFromHex, hexFromArgb, Hct, SchemeTonalSpot, MaterialDynamicColors } = await import(
  '@material/material-color-utilities'
);

const seed = '#3f6fd8'; // 青系(9.1)
const roles = [
  'primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer',
  'secondary', 'onSecondary', 'secondaryContainer', 'onSecondaryContainer',
  'tertiary', 'onTertiary', 'tertiaryContainer', 'onTertiaryContainer',
  'error', 'onError', 'errorContainer', 'onErrorContainer',
  'surface', 'onSurface', 'surfaceVariant', 'onSurfaceVariant',
  'surfaceContainerLowest', 'surfaceContainerLow', 'surfaceContainer',
  'surfaceContainerHigh', 'surfaceContainerHighest',
  'inverseSurface', 'inverseOnSurface', 'inversePrimary',
  'outline', 'outlineVariant', 'shadow', 'scrim',
];
const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function block(isDark) {
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(seed)), isDark, 0);
  return roles
    .map((r) => `  --md-sys-color-${kebab(r)}: ${hexFromArgb(MaterialDynamicColors[r].getArgb(scheme))};`)
    .join('\n');
}

const css = `/* 生成ファイル: web/scripts/gen-theme.mjs で作る。手で編集しない(シード ${seed}) */
:root {
  color-scheme: light dark;
${block(false)}
}

@media (prefers-color-scheme: dark) {
  :root {
${block(true).replace(/^/gm, '  ')}
  }
}
`;
writeFileSync(new URL('../src/theme/colors.css', import.meta.url), css);
console.log('web/src/theme/colors.css を生成しました');
