/** Shared styles and a tiny DOM helper for the library's UI components (rendered in shadow roots). */

export function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string | null)[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v) e.setAttribute(k, v);
  for (const c of children) if (c !== null) e.append(c);
  return e;
}

export const CSS = `
:host {
  --wh-bg: #fff; --wh-fg: #1d1d1b; --wh-muted: #6b6b66; --wh-border: #dddcd6; --wh-accent: #2f6fdb;
  --wh-font: 13px/1.4 system-ui, sans-serif;
  display: block; font: var(--wh-font); color: var(--wh-fg);
}
@media (prefers-color-scheme: dark) {
  :host { --wh-bg: #1e1e1e; --wh-fg: #ececea; --wh-muted: #9a9a94; --wh-border: #333331; --wh-accent: #6b9cff; }
}
.panel { display: flex; flex-direction: column; gap: 10px; }
section { border: 1px solid var(--wh-border); border-radius: 8px; padding: 8px 10px; background: var(--wh-bg); }
section.done { border-color: color-mix(in srgb, #22803f 50%, var(--wh-border)); }
h3 { font-size: 13px; margin: 0 0 4px; display: flex; gap: 6px; align-items: center; }
.mark { font-weight: bold; color: var(--wh-muted); }
section.done .mark { color: #22803f; }
.hint { color: var(--wh-muted); font-size: 12px; margin: 2px 0 6px; }
.hint.warn { color: #b3261e; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 6px 0; }
.name { font-weight: 600; min-width: 6em; }
.chip { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: var(--wh-border); }
.chip.done { background: #22803f; color: #fff; }
.chip.warn { background: #c77700; color: #fff; }
.chip.todo { background: var(--wh-border); color: var(--wh-fg); }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; width: 100%; }
.actions.reset { justify-content: flex-end; }
.or { color: var(--wh-muted); font-size: 12px; }
button, select, input { font: inherit; }
button { padding: 4px 10px; border-radius: 6px; border: 1px solid var(--wh-border); background: var(--wh-bg); color: var(--wh-fg); cursor: pointer; }
button.primary { background: var(--wh-accent); border-color: var(--wh-accent); color: #fff; }
button.running { background: #b3261e; border-color: #b3261e; color: #fff; }
button:disabled { opacity: 0.5; cursor: default; }
input[type='number'] { width: 64px; }
details { margin-top: 6px; } summary { cursor: pointer; color: var(--wh-muted); font-size: 12px; }
.banner {
  position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 2147483000;
  max-width: min(92vw, 720px); padding: 10px 16px; border-radius: 10px; font: 15px/1.35 system-ui, sans-serif;
  text-align: center; background: #24324a; color: #fff; box-shadow: 0 4px 18px rgba(0,0,0,0.35);
}
.banner:empty { display: none; }
.banner[data-kind='busy'] { background: #1f5fbf; }
.banner[data-kind='ok'] { background: #22803f; }
.banner[data-kind='error'] { background: #b3261e; }
.banner[data-kind='busy']::before { content: '⏳ '; }
.banner[data-kind='ok']::before { content: '✓ '; }
.banner[data-kind='error']::before { content: '⚠ '; }
`;
