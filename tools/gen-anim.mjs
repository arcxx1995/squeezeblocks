// Generates public/assets/demo.svg — a looping pixel-art Dots-and-Boxes match.
// Pure SMIL (calcMode="discrete") so GitHub renders it as an animated <img>.
// Tweak COLS/ROWS/PERIOD/palette and re-run: node tools/gen-anim.mjs
import { writeFileSync } from 'node:fs';

const COLS = 4, ROWS = 4;          // dots per side -> (COLS-1)x(ROWS-1) boxes
const SP = 64, M = 40;             // dot spacing, margin
const PERIOD = 10;                 // loop length (s)
const HOLD = 0.9;                  // fraction where the full board snaps back to empty
const P = {                        // matches the in-game palette (engine.ts seats + board.tsx)
  bg: '#000000', grid: '#2b2b2b', dot: '#ffffff',
  lit: '#ffffff', p1: '#C5B0F4' /* Lilac */, p2: '#DCEEB1' /* Lime */,
};

const dx = (c) => M + c * SP;
const dy = (r) => M + r * SP;
const W = M * 2 + (COLS - 1) * SP;
const H = M * 2 + (ROWS - 1) * SP + 8;

// --- edges: h(c,r) horizontal from (c,r)->(c+1,r); v(c,r) vertical (c,r)->(c,r+1)
const key = (t, c, r) => `${t}:${c}:${r}`;
const order = [];                  // play order (snake fill, box by box)
const seen = new Set();
const add = (t, c, r) => { const k = key(t, c, r); if (!seen.has(k)) { seen.add(k); order.push({ t, c, r }); } };
for (let r = 0; r < ROWS - 1; r++)
  for (let c = 0; c < COLS - 1; c++) {
    add('h', c, r); add('v', c, r); add('v', c + 1, r); add('h', c, r + 1);
  }

const N = order.length;
const appear = new Map();          // edge -> fraction of period when it lights up
order.forEach((e, i) => appear.set(key(e.t, e.c, e.r), 0.05 + 0.62 * (i / (N - 1))));

// box completion time = when its last edge appears; players alternate by completion order
const boxes = [];
for (let r = 0; r < ROWS - 1; r++)
  for (let c = 0; c < COLS - 1; c++) {
    const es = [key('h', c, r), key('h', c, r + 1), key('v', c, r), key('v', c + 1, r)];
    boxes.push({ c, r, done: Math.max(...es.map((k) => appear.get(k))) });
  }
boxes.sort((a, b) => a.done - b.done).forEach((b, i) => (b.player = i % 2 === 0 ? P.p1 : P.p2));

// discrete on/off timeline: hidden -> shown at f -> hidden at HOLD, looping every PERIOD
const anim = (f) =>
  `<animate attributeName="opacity" calcMode="discrete" values="0;1;0" ` +
  `keyTimes="0;${f.toFixed(3)};${HOLD}" dur="${PERIOD}s" repeatCount="indefinite"/>`;

const parts = [];
// captured boxes (behind the lines)
for (const b of boxes) {
  const x = dx(b.c) + 5, y = dy(b.r) + 5;
  parts.push(`<rect x="${x}" y="${y}" width="${SP - 10}" height="${SP - 10}" fill="${b.player}" opacity="0">${anim(b.done)}</rect>`);
}
// unlit track (always visible) + lit edges (animated)
for (let r = 0; r < ROWS; r++)
  for (let c = 0; c < COLS; c++) {
    if (c < COLS - 1) { // horizontal
      const x = dx(c) + 5, y = dy(r) - 3, w = SP - 10;
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="6" fill="${P.grid}"/>`);
      const f = appear.get(key('h', c, r));
      if (f != null) parts.push(`<rect x="${x}" y="${y}" width="${w}" height="6" fill="${P.lit}" opacity="0">${anim(f)}</rect>`);
    }
    if (r < ROWS - 1) { // vertical
      const x = dx(c) - 3, y = dy(r) + 5, h = SP - 10;
      parts.push(`<rect x="${x}" y="${y}" width="6" height="${h}" fill="${P.grid}"/>`);
      const f = appear.get(key('v', c, r));
      if (f != null) parts.push(`<rect x="${x}" y="${y}" width="6" height="${h}" fill="${P.lit}" opacity="0">${anim(f)}</rect>`);
    }
  }
// dots on top (pixel squares)
for (let r = 0; r < ROWS; r++)
  for (let c = 0; c < COLS; c++)
    parts.push(`<rect x="${dx(c) - 4}" y="${dy(r) - 4}" width="8" height="8" fill="${P.dot}"/>`);

const svg =
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="squeezeblocks — a Dots and Boxes match playing out in pixel art">
<rect width="${W}" height="${H}" fill="${P.bg}"/>
${parts.join('\n')}
</svg>
`;

writeFileSync(new URL('../public/assets/demo-v2.svg', import.meta.url), svg);
console.log(`wrote public/assets/demo-v2.svg (${N} edges, ${boxes.length} boxes)`);
