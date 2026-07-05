// Generates public/assets/demo-v3.svg — a looping pixel-art Dots-and-Boxes match.
// Pure SMIL (calcMode="discrete") so GitHub renders it as an animated <img>.
// It SIMULATES a real game: lines are colored by the player who drew them,
// capturing a box grants another turn, and a line greys once its box is filled
// (LINE_ON_BOX in board.tsx). Tweak + re-run: node tools/gen-anim.mjs
import { writeFileSync } from 'node:fs';

const COLS = 4, ROWS = 4;          // dots per side -> (COLS-1)x(ROWS-1) boxes
const SP = 64, M = 40;             // dot spacing, margin
const PERIOD = 10;                 // loop length (s)
const HOLD = 0.9;                  // fraction where the full board snaps back to empty
const P = {                        // matches the in-game palette (engine.ts seats + board.tsx)
  bg: '#000000', grid: '#2b2b2b', dot: '#ffffff',
  onBox: '#bcbcbc' /* LINE_ON_BOX */, p1: '#C5B0F4' /* Lilac */, p2: '#DCEEB1' /* Lime */,
};
const seat = (i) => (i === 0 ? P.p1 : P.p2);

const dx = (c) => M + c * SP;
const dy = (r) => M + r * SP;
const W = M * 2 + (COLS - 1) * SP;
const H = M * 2 + (ROWS - 1) * SP + 8;

// --- edges: h(c,r) horizontal (c,r)->(c+1,r); v(c,r) vertical (c,r)->(c,r+1)
const key = (e) => `${e.t}:${e.c}:${e.r}`;
const order = [];                  // play order (snake fill, box by box)
const seen = new Set();
const add = (t, c, r) => { const k = `${t}:${c}:${r}`; if (!seen.has(k)) { seen.add(k); order.push({ t, c, r }); } };
for (let r = 0; r < ROWS - 1; r++)
  for (let c = 0; c < COLS - 1; c++) { add('h', c, r); add('v', c, r); add('v', c + 1, r); add('h', c, r + 1); }

const N = order.length;
const appear = new Map();          // edge -> fraction of period when it lights up
order.forEach((e, i) => appear.set(key(e), 0.05 + 0.62 * (i / (N - 1))));

// a box (bc,br) owns these four edges:
const boxEdges = (bc, br) => [{ t: 'h', c: bc, r: br }, { t: 'h', c: bc, r: br + 1 }, { t: 'v', c: bc, r: br }, { t: 'v', c: bc + 1, r: br }];
const boxes = [];
for (let br = 0; br < ROWS - 1; br++)
  for (let bc = 0; bc < COLS - 1; bc++)
    boxes.push({ bc, br, done: Math.max(...boxEdges(bc, br).map((e) => appear.get(key(e)))) });

// --- simulate the match: who drew each line, who captured each box, alternate
// turns except an extra turn on capture (the real rule) ---
const edgeOwner = new Map();
const present = new Set();
let cur = 0;
for (const e of order) {
  edgeOwner.set(key(e), cur);
  present.add(key(e));
  let captured = 0;
  for (const b of boxes) {
    if (b.owner === undefined && boxEdges(b.bc, b.br).every((x) => present.has(key(x)))) { b.owner = cur; captured++; }
  }
  cur = captured > 0 ? cur : cur ^ 1;   // capture => go again
}

// a line greys when it borders a filled box: earliest adjacent box completion
const greyAt = (e) => {
  const t = boxes.filter((b) => boxEdges(b.bc, b.br).some((x) => key(x) === key(e))).map((b) => b.done);
  return Math.min(...t);
};

// discrete on/off timeline (opacity), looping every PERIOD
const fade = (f) => `<animate attributeName="opacity" calcMode="discrete" values="0;1;0" keyTimes="0;${f.toFixed(3)};${HOLD}" dur="${PERIOD}s" repeatCount="indefinite"/>`;
// discrete owner-color -> grey-on-captured-box (fill), same loop
const recolor = (owner, g) => `<animate attributeName="fill" calcMode="discrete" values="${owner};${P.onBox}" keyTimes="0;${g.toFixed(3)}" dur="${PERIOD}s" repeatCount="indefinite"/>`;

const parts = [];
// captured boxes (behind the lines), filled in their owner's color
for (const b of boxes) {
  const x = dx(b.bc) + 5, y = dy(b.br) + 5;
  parts.push(`<rect x="${x}" y="${y}" width="${SP - 10}" height="${SP - 10}" fill="${seat(b.owner)}" opacity="0">${fade(b.done)}</rect>`);
}
// unlit track (always visible) + drawn edges (player-colored, greying on capture)
for (let r = 0; r < ROWS; r++)
  for (let c = 0; c < COLS; c++) {
    for (const [t, gx, gy, gw, gh] of [
      c < COLS - 1 ? ['h', dx(c) + 5, dy(r) - 3, SP - 10, 6] : null,
      r < ROWS - 1 ? ['v', dx(c) - 3, dy(r) + 5, 6, SP - 10] : null,
    ].filter(Boolean)) {
      parts.push(`<rect x="${gx}" y="${gy}" width="${gw}" height="${gh}" fill="${P.grid}"/>`);
      const e = { t, c, r }, f = appear.get(key(e));
      const owner = seat(edgeOwner.get(key(e)));
      parts.push(`<rect x="${gx}" y="${gy}" width="${gw}" height="${gh}" fill="${owner}" opacity="0">${fade(f)}${recolor(owner, greyAt(e))}</rect>`);
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

writeFileSync(new URL('../public/assets/demo-v3.svg', import.meta.url), svg);
console.log(`wrote public/assets/demo-v3.svg (${N} edges, ${boxes.length} boxes, P1 ${boxes.filter((b) => b.owner === 0).length} : P2 ${boxes.filter((b) => b.owner === 1).length})`);
