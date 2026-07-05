// Ambient dot-grid animation: white pulsating dots with random lime/lilac lines
// that draw between adjacent dots then fade — mimics the game being played.
// Purely decorative, no sparks, no game state. Plain canvas + rAF (no React) so
// both the React lobby and the vanilla splash can share it. Returns a cleanup fn.
const LIME = "#DCEEB1";
const LILAC = "#C5B0F4";
const SPAWN_MS = 380; // gap between new lines
const DRAW_MS = 260; // grow dot→dot
const HOLD_MS = 900; // stay full
const FADE_MS = 700; // fade out
const MAX_SEGS = 16;

type Seg = { ax: number; ay: number; bx: number; by: number; color: string; t: number };

// "#RRGGBB" -> "rgba(r,g,b,a)".
function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},${a})`;
}

export function startLobbyAnim(
  canvas: HTMLCanvasElement,
  opts: {
    cols?: number;
    rows?: number;
    pad?: number;
    // Auto-fill the canvas with ~square cells of this pixel size (splash).
    // Overrides cols/rows, which are recomputed on resize.
    cell?: number;
    // Vertical band [top, bottom] as height fractions to keep clear of lines
    // and dim of dots — so nothing spawns over the centered text.
    avoidY?: [number, number];
  } = {},
): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const padX = opts.pad ?? 18;
  const padY = opts.pad ?? 16;
  let w = 0;
  let h = 0;
  let cols = opts.cols ?? 6;
  let rows = opts.rows ?? 4;
  let stepX = 0;
  let stepY = 0;

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    w = r.width;
    h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (opts.cell) {
      cols = Math.max(2, Math.round((w - padX * 2) / opts.cell) + 1);
      rows = Math.max(2, Math.round((h - padY * 2) / opts.cell) + 1);
    }
    stepX = (w - padX * 2) / (cols - 1);
    stepY = (h - padY * 2) / (rows - 1);
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  const dotX = (c: number) => padX + c * stepX;
  const dotY = (r: number) => padY + r * stepY;
  // True if a y falls inside the text band (to skip lines / dim dots there).
  const inBand = (y: number) =>
    !!opts.avoidY && y >= opts.avoidY[0] * h && y <= opts.avoidY[1] * h;

  const segs: Seg[] = [];
  let flip = 0;
  const spawn = () => {
    // A few attempts to land a segment clear of the text band, else skip a beat.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const horizontal = Math.random() < 0.5;
      const c = Math.floor(Math.random() * (horizontal ? cols - 1 : cols));
      const r = Math.floor(Math.random() * (horizontal ? rows : rows - 1));
      const ay = dotY(r);
      const by = horizontal ? ay : dotY(r + 1);
      if (inBand(ay) || inBand(by)) continue;
      const ax = dotX(c);
      segs.push({
        ax,
        ay,
        bx: horizontal ? dotX(c + 1) : ax,
        by,
        color: flip++ % 2 ? LILAC : LIME,
        t: 0,
      });
      if (segs.length > MAX_SEGS) segs.shift();
      return;
    }
  };

  let raf = 0;
  let last = performance.now();
  let sinceSpawn = SPAWN_MS; // spawn one immediately
  const total = DRAW_MS + HOLD_MS + FADE_MS;
  const frame = (nowT: number) => {
    const dt = Math.min(64, nowT - last);
    last = nowT;
    sinceSpawn += dt;
    if (sinceSpawn >= SPAWN_MS) {
      sinceSpawn = 0;
      spawn();
    }

    ctx.clearRect(0, 0, w, h);

    // Match the game's proportions: dot radius and line width scale to cell size.
    const step = Math.min(stepX, stepY);
    const dotR = Math.max(2, step * 0.12);
    const lineW = Math.max(2, step * 0.13);

    // Endpoint glow: a dot a line reaches lights up in that line's color, so the
    // dot reads as a visible extension of the line. Key by grid cell -> {level,
    // color}; a line's start dot lights fully, its far dot lights as it arrives.
    const lit = new Map<string, { level: number; color: string }>();
    const addLit = (c: number, r: number, level: number, color: string) => {
      const k = `${c},${r}`;
      const prev = lit.get(k);
      if (!prev || level > prev.level) lit.set(k, { level, color });
    };
    for (const s of segs) {
      const alpha =
        s.t > DRAW_MS + HOLD_MS ? 1 - (s.t - DRAW_MS - HOLD_MS) / FADE_MS : 1;
      const grow = s.t < DRAW_MS ? s.t / DRAW_MS : 1;
      const c1 = Math.round((s.ax - padX) / stepX);
      const r1 = Math.round((s.ay - padY) / stepY);
      const c2 = Math.round((s.bx - padX) / stepX);
      const r2 = Math.round((s.by - padY) / stepY);
      addLit(c1, r1, alpha, s.color); // origin: lit for the segment's life
      addLit(c2, r2, alpha * grow, s.color); // destination: lights as the line arrives
    }

    // Dots — white, pulsating with a diagonal ripple. Dimmed under the text band.
    // A lit endpoint is overdrawn in the line color, larger, as the extension.
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const x = dotX(c);
        const y = dotY(r);
        const wave = Math.sin(nowT / 600 - (c + r) * 0.9);
        const base = 0.5 + 0.35 * wave;
        ctx.fillStyle = `rgba(255,255,255,${inBand(y) ? base * 0.12 : base})`;
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fill();

        const glow = lit.get(`${c},${r}`);
        if (glow && glow.level > 0.01) {
          ctx.fillStyle = rgba(glow.color, glow.level);
          ctx.beginPath();
          ctx.arc(x, y, dotR * (1 + 0.8 * glow.level), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Lines — grow in, hold, fade out. Rounded caps like the game's segments.
    ctx.lineCap = "round";
    ctx.lineWidth = lineW;
    for (let i = segs.length - 1; i >= 0; i -= 1) {
      const s = segs[i];
      s.t += dt;
      if (s.t >= total) {
        segs.splice(i, 1);
        continue;
      }
      const grow = s.t < DRAW_MS ? s.t / DRAW_MS : 1;
      const alpha =
        s.t > DRAW_MS + HOLD_MS ? 1 - (s.t - DRAW_MS - HOLD_MS) / FADE_MS : 1;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.ax + (s.bx - s.ax) * grow, s.ay + (s.by - s.ay) * grow);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
  };
}
