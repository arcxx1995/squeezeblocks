import { useEffect, useRef, type RefObject } from "react";
import Phaser from "phaser";
import {
  BOX_COLS,
  BOX_ROWS,
  DOT_COLS,
  DOT_ROWS,
  GameState,
  LineOrientation,
  boxId,
  lineId,
} from "../shared/engine";

export const BOARD_SIZE = 360;
export const PADDING = 28;
export const STEP = (BOARD_SIZE - PADDING * 2) / (DOT_COLS - 1);
export const DOT_HIT_RADIUS = 14;

const REVEAL_MS = 200;
const POP_MS = 340;
// Flat grey for lines + dots outlining a captured box (uniform, no color mixing).
const LINE_ON_BOX = 0xbcbcbc;

const NO_HIDDEN: ReadonlySet<string> = new Set();

type Props = {
  game: GameState;
  lastMoveId: string | null;
  onDrawLine: (orientation: LineOrientation, row: number, col: number) => void;
  interactive?: boolean;
  // Line ids to keep invisible mid-animation (bot turn revealing one at a time).
  // A box stays unowned visually until all four of its lines are revealed.
  hiddenLineIds?: ReadonlySet<string>;
};

// Latest props, refreshed every React render and polled by the scene each frame.
type Live = {
  game: GameState;
  lastMoveId: string | null;
  interactive: boolean;
  hiddenLineIds: ReadonlySet<string>;
  onDrawLine: Props["onDrawLine"];
};

type Dot = { row: number; col: number };
type Point = { x: number; y: number };

export function GameBoard(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const liveRef = useRef<Live>({
    game: props.game,
    lastMoveId: props.lastMoveId,
    interactive: props.interactive ?? true,
    hiddenLineIds: props.hiddenLineIds ?? NO_HIDDEN,
    onDrawLine: props.onDrawLine,
  });

  // Keep the scene's view of props current without recreating the game.
  liveRef.current.game = props.game;
  liveRef.current.lastMoveId = props.lastMoveId;
  liveRef.current.interactive = props.interactive ?? true;
  liveRef.current.hiddenLineIds = props.hiddenLineIds ?? NO_HIDDEN;
  liveRef.current.onDrawLine = props.onDrawLine;

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;

    const scene = new BoardScene(liveRef);
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      width: BOARD_SIZE,
      height: BOARD_SIZE,
      transparent: true,
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      scene,
    });
    gameRef.current = game;

    // touch-action on the wrapper div does NOT inherit to Phaser's canvas, so
    // without this the browser can treat a board drag as a page scroll (the
    // screen is overflow-y:auto) — that fires pointercancel, Phaser never gets
    // pointerup, and the move is silently dropped. Pin it on the canvas so the
    // gesture always stays ours.
    game.canvas.style.touchAction = "none";

    return () => {
      game.destroy(true);
      gameRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={`${DOT_ROWS} by ${DOT_COLS} squeezeblocks game board`}
      className="mx-auto aspect-square h-full max-h-full w-auto max-w-full touch-none select-none overflow-hidden"
    />
  );
}

class BoardScene extends Phaser.Scene {
  private live: RefObject<Live>;
  private gfx!: Phaser.GameObjects.Graphics;
  private initialized = false;
  private prevStatus: GameState["status"] = "active";
  // Per-line reveal progress 0..1; presence = "currently visible / animating in".
  private lines = new Map<string, { p: number }>();
  // Per-box pop progress 0..1 for captured boxes.
  private boxes = new Map<string, { p: number; color: number }>();
  private drag: { start: Dot; point: Point; target: Dot | null } | null = null;
  private pulse = 0;

  constructor(live: RefObject<Live>) {
    super("board");
    this.live = live;
  }

  create() {
    const spark = this.make.graphics({ x: 0, y: 0 }, false);
    spark.fillStyle(0xffffff, 1);
    spark.fillCircle(6, 6, 6);
    spark.generateTexture("spark", 12, 12);
    spark.destroy();

    this.gfx = this.add.graphics();
    this.gfx.setDepth(0);

    this.input.on("pointerdown", this.onDown, this);
    this.input.on("pointermove", this.onMove, this);
    this.input.on("pointerup", this.onUp, this);
    this.input.on("pointerupoutside", this.onUp, this);
  }

  private onDown(pointer: Phaser.Input.Pointer) {
    const s = this.live.current;
    if (!s.interactive || s.game.status !== "active") return;
    // Grab the nearest dot within half a cell — a finger doesn't have to land on
    // the tiny dot, just in its neighborhood.
    const dot = this.dotAt(pointer.x, pointer.y, STEP * 0.5);
    if (!dot) return;
    this.drag = { start: dot, point: { x: pointer.x, y: pointer.y }, target: null };
    // Subtle bloom at the touched dot.
    const dx = PADDING + dot.col * STEP;
    const dy = PADDING + dot.row * STEP;
    this.spark(dx, dy, 0xffffff, 5, 40, 300, 0.4);
  }

  private onMove(pointer: Phaser.Input.Pointer) {
    if (!this.drag) return;
    this.drag.point = this.clamp(pointer.x, pointer.y);
    this.drag.target = this.dragTarget(this.drag.start, this.drag.point);
  }

  private onUp(pointer: Phaser.Input.Pointer) {
    if (!this.drag) return;
    const s = this.live.current;
    // Turn may have flipped mid-drag (realtime push) — don't submit a move the
    // server will reject.
    if (!s.interactive || s.game.status !== "active") {
      this.drag = null;
      return;
    }
    // Commit the line the preview showed: inferred from drag direction, not from
    // landing the finger on the far dot.
    const target = this.dragTarget(this.drag.start, this.clamp(pointer.x, pointer.y));
    const line = target ? lineFromDots(this.drag.start, target) : null;
    if (line && !s.game.lines[line.id]?.ownerPlayerId) {
      s.onDrawLine(line.orientation, line.row, line.col);
    }
    this.drag = null;
  }

  override update(_time: number, delta: number) {
    const s = this.live.current;
    const game = s.game;
    this.pulse += delta;

    // Diff visible lines -> spawn reveal tween + endpoint spark for new ones.
    for (const id of Object.keys(game.lines)) {
      const line = game.lines[id];
      const visible = !!line.ownerPlayerId && !s.hiddenLineIds.has(id);
      const tracked = this.lines.get(id);
      if (visible && !tracked) {
        // The local player already drew this line with the drag/preview, so show
        // it instantly (p=1) — replaying the grow made it look like the line was
        // drawn twice. Remote and bot lines (id !== lastMoveId) still animate in.
        const isLocal = id === s.lastMoveId;
        this.lines.set(id, { p: this.initialized && !isLocal ? 0 : 1 });
        // Spark in the drawer's color — currentPlayerIndex has already advanced
        // past a non-capturing move, so the active player is the wrong one.
        if (this.initialized) this.burstLine(id, colorNum(ownerColor(game, line.ownerPlayerId)));
      } else if (!visible && tracked) {
        this.lines.delete(id);
      }
    }

    // Diff captured boxes -> pop + particle burst for new ones.
    for (const id of Object.keys(game.boxes)) {
      const box = game.boxes[id];
      const hidden = this.boxHidden(id, s.hiddenLineIds);
      const owned = !!box.ownerPlayerId && !hidden;
      const tracked = this.boxes.get(id);
      const color = colorNum(ownerColor(game, box.ownerPlayerId));
      if (owned && !tracked) {
        this.boxes.set(id, { p: this.initialized ? 0 : 1, color });
        // No box-center burst — the completing line's endpoint spark is the only
        // spark on capture.
      } else if (owned && tracked) {
        tracked.color = color;
      } else if (!owned && tracked) {
        this.boxes.delete(id);
      }
    }

    // Win celebration on transition into completed.
    if (game.status === "completed" && this.prevStatus !== "completed") {
      if (this.initialized) this.celebrate(game);
    }
    this.prevStatus = game.status;
    this.initialized = true;

    // Advance animations.
    for (const l of this.lines.values()) l.p = Math.min(1, l.p + delta / REVEAL_MS);
    for (const b of this.boxes.values()) b.p = Math.min(1, b.p + delta / POP_MS);

    this.draw(s);
  }

  private draw(s: Live) {
    const g = this.gfx;
    const game = s.game;
    g.clear();

    g.fillStyle(0x000000, 1);
    g.fillRoundedRect(0, 0, BOARD_SIZE, BOARD_SIZE, 12);

    // Boxes.
    for (let row = 0; row < BOX_ROWS; row += 1) {
      for (let col = 0; col < BOX_COLS; col += 1) {
        const cx = PADDING + col * STEP + STEP / 2;
        const cy = PADDING + row * STEP + STEP / 2;
        const pop = this.boxes.get(boxId(row, col));
        if (pop) {
          // easeOutCubic never exceeds 1, so the fill can't overshoot its cell
          // and bleed over the lines. Flat solid color, no shadow.
          const s2 = easeOutCubic(pop.p);
          const w = STEP * s2;
          const x = cx - w / 2;
          const y = cy - w / 2;
          g.fillStyle(pop.color, 1);
          g.fillRoundedRect(x, y, w, w, 4);
        }
        // Empty cells stay the bare board color — no background film.
      }
    }

    // Lines (horizontal then vertical), each grown by its reveal progress.
    for (const id of this.lines.keys()) {
      const parsed = parseLineId(id);
      if (!parsed) continue;
      const anim = this.lines.get(id)!;
      let owner = colorNum(displayOwnerColor(game, parsed.orientation, parsed.row, parsed.col));
      // On a captured box the per-side colors mix and blend into the fill —
      // override to one flat light grey so the border reads as a clean outline.
      if (borderingFilledBox(game, parsed)) owner = LINE_ON_BOX;
      const width = s.lastMoveId === id ? 10 : 8;
      const a = endpoints(parsed);
      drawSegment(g, a.x1, a.y1, a.x2, a.y2, width, owner, 1, easeOutCubic(anim.p));
    }

    // Drag preview.
    if (this.drag) {
      const start = this.drag.start;
      const sx = PADDING + start.col * STEP;
      const sy = PADDING + start.row * STEP;
      const end = previewEnd(start, this.drag.point);
      const line = this.drag.target ? lineFromDots(start, this.drag.target) : null;
      const taken = line && game.lines[line.id]?.ownerPlayerId;
      const active = game.players[game.currentPlayerIndex];
      drawSegment(g, sx, sy, end.x, end.y, 8, colorNum(active?.color), taken ? 0.25 : 0.7, 1);
    }

    // Dots.
    const ring = 0.5 + 0.5 * Math.sin(this.pulse / 150);
    for (let row = 0; row < DOT_ROWS; row += 1) {
      for (let col = 0; col < DOT_COLS; col += 1) {
        const x = PADDING + col * STEP;
        const y = PADDING + row * STEP;
        const held = this.drag?.start.row === row && this.drag?.start.col === col;
        if (held) {
          // Single faint ring marks the grabbed dot — no layered bloom.
          g.fillStyle(0xffffff, 0.18 * ring);
          g.fillCircle(x, y, 16);
        }
        // Flat disc. On a captured box, use the same flat grey as the border
        // lines so the whole outline reads as one clean color.
        const onBox = filledBoxColorAtDot(game, row, col) !== null;
        g.fillStyle(onBox ? LINE_ON_BOX : 0xffffff, 1);
        g.fillCircle(x, y, held ? 9 : 7);
      }
    }
  }

  private burstLine(id: string, color: number) {
    const parsed = parseLineId(id);
    if (!parsed) return;
    // Subtle spark only at the dots the line joins.
    const p = endpoints(parsed);
    this.spark(p.x1, p.y1, color, 4, 32, 360, 0.4);
    this.spark(p.x2, p.y2, color, 4, 32, 360, 0.4);
  }

  private celebrate(game: GameState) {
    const colors = game.players.map((p) => colorNum(p.color));
    for (let i = 0; i < 5; i += 1) {
      const x = PADDING + Math.abs(Math.sin(i * 12.9898) * (BOARD_SIZE - PADDING * 2));
      this.spark(x, PADDING, colors[i % colors.length], 22, 260, 1100);
    }
    this.cameras.main.flash(220, 255, 255, 255);
  }

  private spark(
    x: number,
    y: number,
    color: number,
    count: number,
    speed: number,
    life = 620,
    scaleStart = 0.9,
  ) {
    // Emitter at origin; explode() supplies the world point. Creating it at (x,y)
    // AND emitting at (x,y) double-offsets particles to (2x,2y) — Phaser 4 gotcha.
    const emitter = this.add.particles(0, 0, "spark", {
      speed: { min: speed * 0.3, max: speed },
      angle: { min: 0, max: 360 },
      scale: { start: scaleStart, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: life,
      tint: color,
      blendMode: "ADD",
      emitting: false,
    });
    emitter.setDepth(10);
    emitter.explode(count, x, y);
    this.time.delayedCall(life + 100, () => emitter.destroy());
  }

  private boxHidden(id: string, hidden: ReadonlySet<string>): boolean {
    const m = id.match(/(\d+).*?(\d+)/);
    if (!m) return false;
    const row = Number(m[1]);
    const col = Number(m[2]);
    return [
      lineId("horizontal", row, col),
      lineId("horizontal", row + 1, col),
      lineId("vertical", row, col),
      lineId("vertical", row, col + 1),
    ].some((lid) => hidden.has(lid));
  }

  private dotAt(x: number, y: number, radius = DOT_HIT_RADIUS): Dot | null {
    const col = Math.round((x - PADDING) / STEP);
    const row = Math.round((y - PADDING) / STEP);
    if (row < 0 || row >= DOT_ROWS || col < 0 || col >= DOT_COLS) return null;
    const dx = x - (PADDING + col * STEP);
    const dy = y - (PADDING + row * STEP);
    return Math.hypot(dx, dy) <= radius ? { row, col } : null;
  }

  // The adjacent dot the drag points at — dominant axis, min a third of a cell so
  // a stray touch doesn't commit. Matches the on-screen preview's direction logic.
  private dragTarget(start: Dot, point: Point): Dot | null {
    const sx = PADDING + start.col * STEP;
    const sy = PADDING + start.row * STEP;
    const dx = point.x - sx;
    const dy = point.y - sy;
    if (Math.hypot(dx, dy) < STEP * 0.33) return null;
    const end =
      Math.abs(dx) >= Math.abs(dy)
        ? { row: start.row, col: start.col + (dx > 0 ? 1 : -1) }
        : { row: start.row + (dy > 0 ? 1 : -1), col: start.col };
    if (end.row < 0 || end.row >= DOT_ROWS || end.col < 0 || end.col >= DOT_COLS) return null;
    return end;
  }

  private clamp(x: number, y: number): Point {
    return {
      x: Math.min(BOARD_SIZE - PADDING, Math.max(PADDING, x)),
      y: Math.min(BOARD_SIZE - PADDING, Math.max(PADDING, y)),
    };
  }
}

function drawSegment(
  g: Phaser.GameObjects.Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  color: number,
  alpha: number,
  t: number,
) {
  const ex = x1 + (x2 - x1) * t;
  const ey = y1 + (y2 - y1) * t;
  // Flat solid bar with rounded caps (Graphics has no lineCap, so cap with
  // circles). No shadow, no sheen.
  g.lineStyle(width, color, alpha);
  g.lineBetween(x1, y1, ex, ey);
  g.fillStyle(color, alpha);
  g.fillCircle(x1, y1, width / 2);
  g.fillCircle(ex, ey, width / 2);
}

function endpoints(p: { orientation: LineOrientation; row: number; col: number }) {
  const x1 = PADDING + p.col * STEP;
  const y1 = PADDING + p.row * STEP;
  return p.orientation === "horizontal"
    ? { x1, y1, x2: PADDING + (p.col + 1) * STEP, y2: y1 }
    : { x1, y1, x2: x1, y2: PADDING + (p.row + 1) * STEP };
}

function parseLineId(id: string): { orientation: LineOrientation; row: number; col: number } | null {
  const [tag, rawRow, rawCol] = id.split("-");
  const row = Number(rawRow);
  const col = Number(rawCol);
  if (Number.isNaN(row) || Number.isNaN(col)) return null;
  return { orientation: tag === "h" ? "horizontal" : "vertical", row, col };
}

function previewEnd(start: Dot, point: Point): Point {
  const sx = PADDING + start.col * STEP;
  const sy = PADDING + start.row * STEP;
  const dx = point.x - sx;
  const dy = point.y - sy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { x: Math.min(sx + STEP, Math.max(sx - STEP, point.x)), y: sy };
  }
  return { x: sx, y: Math.min(sy + STEP, Math.max(sy - STEP, point.y)) };
}

function lineFromDots(
  start: Dot,
  end: Dot,
): { id: string; orientation: LineOrientation; row: number; col: number } | null {
  const rowDelta = end.row - start.row;
  const colDelta = end.col - start.col;
  if (rowDelta === 0 && Math.abs(colDelta) === 1) {
    const col = Math.min(start.col, end.col);
    return { id: lineId("horizontal", start.row, col), orientation: "horizontal", row: start.row, col };
  }
  if (colDelta === 0 && Math.abs(rowDelta) === 1) {
    const row = Math.min(start.row, end.row);
    return { id: lineId("vertical", row, start.col), orientation: "vertical", row, col: start.col };
  }
  return null;
}

function ownerColor(game: GameState, ownerId: string | null | undefined): string | undefined {
  return game.players.find((player) => player.id === ownerId)?.color;
}

function displayOwnerColor(
  game: GameState,
  orientation: LineOrientation,
  row: number,
  col: number,
): string | undefined {
  const line = game.lines[lineId(orientation, row, col)];
  const adjacent =
    orientation === "horizontal"
      ? [row > 0 ? boxId(row - 1, col) : null, row < BOX_ROWS ? boxId(row, col) : null]
      : [col > 0 ? boxId(row, col - 1) : null, col < BOX_COLS ? boxId(row, col) : null];
  const filledBox = adjacent
    .map((id) => (id ? game.boxes[id] : null))
    .find((box) => box?.ownerPlayerId);
  const ownerId = filledBox?.ownerPlayerId ?? line?.ownerPlayerId;
  return ownerColor(game, ownerId);
}

function colorNum(color: string | null | undefined): number {
  if (!color) return 0xffffff;
  return parseInt(color.replace("#", ""), 16);
}

// True if either box touching this line is captured.
function borderingFilledBox(
  game: GameState,
  p: { orientation: LineOrientation; row: number; col: number },
): boolean {
  const adjacent =
    p.orientation === "horizontal"
      ? [p.row > 0 ? boxId(p.row - 1, p.col) : null, p.row < BOX_ROWS ? boxId(p.row, p.col) : null]
      : [p.col > 0 ? boxId(p.row, p.col - 1) : null, p.col < BOX_COLS ? boxId(p.row, p.col) : null];
  return adjacent.some((id) => id !== null && game.boxes[id]?.ownerPlayerId);
}

// Color of a captured box touching this dot, or null if none is captured.
function filledBoxColorAtDot(game: GameState, row: number, col: number): number | null {
  const around: [number, number][] = [
    [row - 1, col - 1],
    [row - 1, col],
    [row, col - 1],
    [row, col],
  ];
  for (const [r, c] of around) {
    if (r < 0 || c < 0 || r >= BOX_ROWS || c >= BOX_COLS) continue;
    const box = game.boxes[boxId(r, c)];
    if (box?.ownerPlayerId) return colorNum(ownerColor(game, box.ownerPlayerId));
  }
  return null;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
