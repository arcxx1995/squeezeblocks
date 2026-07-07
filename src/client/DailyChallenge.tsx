import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import {
  createInitialGame,
  lineId,
  submitLine,
  type GameState,
  type LineOrientation,
} from "../shared/engine";
import { botMove } from "../shared/bot";
import { BOT_LEVELS, type BotLevel, type DailyView, type MoveRequest } from "../shared/online";
// Same lazy split as OnlineGame — a static import here would drag Phaser back
// into the main bundle.
const GameBoard = lazy(() => import("./board").then((m) => ({ default: m.GameBoard })));

// Build the day's starting game: seat 0 = you (starts), seat 1 = the bot. Same
// shape the server replays, so a finished run scores identically there.
function freshDaily(): GameState {
  const base = createInitialGame(0, 2);
  return {
    ...base,
    players: [
      { ...base.players[0]!, id: "you", name: "You" },
      { ...base.players[1]!, id: "bot", name: "Breeze Bot" },
    ],
  };
}

// Human-ish pacing: the bot "thinks" before its turn, then plays each line at a
// slightly uneven pace — a flat metronome reads as a machine.
const botThinkMs = () => 700 + Math.random() * 900;
const botStepMs = () => 400 + Math.random() * 500;

const LEVEL_META: Record<BotLevel, { name: string }> = {
  1: { name: "Easy" },
  2: { name: "Medium" },
  3: { name: "Hard" },
};

export function DailyChallenge({ onExit }: { onExit?: () => void }) {
  const [info, setInfo] = useState<DailyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<BotLevel | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [lastMoveId, setLastMoveId] = useState<string | null>(null);
  const [botThinking, setBotThinking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const movesRef = useRef<MoveRequest[]>([]);
  const timersRef = useRef<number[]>([]);
  // The date the current run was loaded/played on — submitted with the run so a
  // game that crosses midnight is still scored against the day it was played.
  const dateRef = useRef<string>("");

  // Load today's challenge (all three levels' status + boards).
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/daily");
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message ?? "Could not load the daily");
        setInfo(data as DailyView);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load the daily");
      }
    })();
    return () => timersRef.current.forEach((t) => window.clearTimeout(t));
  }, []);

  const submitRun = useCallback(async (moves: MoveRequest[], lvl: BotLevel) => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/daily", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moves, level: lvl, date: dateRef.current }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? "Could not submit your run");
      setInfo(data as DailyView);
      // Back to the daily lobby: the level picker, now showing this run's margin
      // on its card and the other levels still open to play.
      setState(null);
      setLevel(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit your run");
    } finally {
      setSubmitting(false);
    }
  }, []);

  // Run the bot's whole turn locally, one line at a time, then hand back to you.
  const runBot = useCallback(
    (start: GameState, seed: number, lvl: BotLevel) => {
      setBotThinking(true);
      let s = start;
      const tick = () => {
        if (s.status !== "active" || s.players[s.currentPlayerIndex]!.id !== "bot") {
          setBotThinking(false);
          if (s.status === "completed") void submitRun(movesRef.current, lvl);
          return;
        }
        const mv = botMove(s, seed, lvl);
        if (!mv) {
          setBotThinking(false);
          return;
        }
        s = submitLine(s, mv.orientation, mv.row, mv.col, 0);
        setState(s);
        setLastMoveId(lineId(mv.orientation, mv.row, mv.col));
        timersRef.current.push(window.setTimeout(tick, botStepMs()));
      };
      timersRef.current.push(window.setTimeout(tick, botThinkMs()));
    },
    [submitRun],
  );

  // Pick a level: start a fresh game if unplayed, else just view its board.
  const selectLevel = (lvl: BotLevel) => {
    if (botThinking || submitting) return;
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current = [];
    setError(null);
    setLevel(lvl);
    setLastMoveId(null);
    setBotThinking(false);
    const played = info?.levels.find((l) => l.level === lvl)?.played;
    if (played) {
      setState(null);
    } else {
      movesRef.current = [];
      dateRef.current = info?.date ?? ""; // pin the run to the day it was loaded
      setState(freshDaily());
    }
  };

  const onDrawLine = (orientation: LineOrientation, row: number, col: number) => {
    if (!state || !info || level == null || botThinking) return;
    if (state.status !== "active" || state.players[state.currentPlayerIndex]!.id !== "you") return;
    const next = submitLine(state, orientation, row, col, 0);
    if (next === state) return; // illegal / owned
    movesRef.current = [...movesRef.current, { orientation, row, col }];
    setLastMoveId(lineId(orientation, row, col));
    setState(next);
    if (next.status === "completed") {
      void submitRun(movesRef.current, level);
    } else if (next.players[next.currentPlayerIndex]!.id === "bot") {
      runBot(next, info.seed, level);
    }
  };

  const activeLevel = level != null ? info?.levels.find((l) => l.level === level) ?? null : null;
  const played = activeLevel?.played ?? null;

  return (
    <main className="app-phone-viewport text-white">
      <section className="app-phone-screen flex flex-col px-4 py-4">
        <header className="flex items-start justify-between gap-3 py-2">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-[#DCEEB1]">
              squeezeblocks
            </p>
            <h1 className="text-3xl font-[340] leading-none text-white">
              Take the daily challenge{info?.me ? `, ${info.me}` : ""}
            </h1>
          </div>
          {onExit ? (
            <button
              type="button"
              onClick={onExit}
              aria-label="Back"
              className="grid size-9 shrink-0 place-items-center rounded-full border border-white/25 font-mono text-white/80 transition hover:border-white/50"
            >
              ✕
            </button>
          ) : null}
        </header>

        {info ? (
          <p className="font-mono text-xs uppercase tracking-[0.12em] text-white/50">
            {info.date} · same board for everyone · one try per level
          </p>
        ) : null}

        {/* Level picker: pick your bot. Played levels show your margin. Hidden
            once a match is live so the board gets the full screen. */}
        {info && !(state && !played) ? (
          <section className="mt-3 grid grid-cols-3 gap-2">
            {BOT_LEVELS.map((lvl) => {
              const lv = info.levels.find((l) => l.level === lvl);
              const res = lv?.played ?? null;
              const selected = lvl === level;
              return (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => selectLevel(lvl)}
                  disabled={botThinking || submitting}
                  className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition disabled:opacity-60 ${
                    selected
                      ? "border-[#DCEEB1] bg-[#111111]"
                      : "border-white/15 bg-[#111111] hover:border-white/40"
                  }`}
                >
                  <span className="text-sm font-extrabold text-white">{LEVEL_META[lvl].name}</span>
                  <span
                    className={`font-mono text-xs ${res ? "text-[#DCEEB1]" : "text-white/60"}`}
                  >
                    {res ? (res.margin > 0 ? `+${res.margin}` : res.margin) : "Play →"}
                  </span>
                </button>
              );
            })}
          </section>
        ) : null}

        {played ? (
          <section className="mt-3 rounded-lg border border-white/15 bg-[#DCEEB1] p-4 text-black">
            <p className="text-xl font-bold">
              {played.margin > 0
                ? `You beat ${LEVEL_META[played.level].name} by ${played.margin}`
                : played.margin < 0
                  ? `${LEVEL_META[played.level].name} bot won by ${-played.margin}`
                  : "Dead heat"}
            </p>
            <p className="font-mono text-xs uppercase tracking-[0.12em] text-black/65">
              You {played.you} · Bot {played.bot} · one try per level
            </p>
          </section>
        ) : null}

        {activeLevel && activeLevel.board.length > 0 ? (
          <section className="mt-3 rounded-lg border border-white/15 bg-[#111111] p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/50">
              {LEVEL_META[activeLevel.level].name} · top margins
            </p>
            <ol className="mt-2 flex flex-col gap-1">
              {activeLevel.board.map((row, i) => (
                <li
                  key={row.name}
                  className={`flex items-center justify-between text-sm ${
                    row.name === info?.me ? "font-bold text-[#DCEEB1]" : "text-white/80"
                  }`}
                >
                  <span className="truncate">
                    {i + 1}. {row.name === info?.me ? "You" : row.name}
                  </span>
                  <span className="font-mono">{row.margin > 0 ? `+${row.margin}` : row.margin}</span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {state && !played ? (
          <>
            <section className="mt-3 grid grid-cols-2 gap-2">
              {state.players.map((player, index) => (
                <div
                  key={player.id}
                  className={`rounded-lg border p-3 transition ${
                    index === state.currentPlayerIndex && state.status === "active"
                      ? "border-[#DCEEB1] bg-[#111111] text-white"
                      : "border-white/15 bg-[#111111] text-white"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-extrabold">{player.name}</span>
                    <span className="font-mono text-xl">{player.score}</span>
                  </div>
                </div>
              ))}
            </section>
            <section className="flex min-h-0 flex-1 items-center justify-center py-4">
              <Suspense fallback={<div className="mx-auto aspect-square h-full max-h-full w-auto max-w-full" />}>
                <GameBoard
                  game={state}
                  lastMoveId={lastMoveId}
                  onDrawLine={onDrawLine}
                  interactive={
                    state.status === "active" &&
                    state.players[state.currentPlayerIndex]!.id === "you" &&
                    !botThinking &&
                    !submitting
                  }
                  hiddenLineIds={new Set()}
                />
              </Suspense>
            </section>
          </>
        ) : level == null ? (
          <p className="mt-4 font-mono text-xs text-white/50">
            Pick a bot above to start. Beat all three for the full daily.
          </p>
        ) : null}

        {error ? <p className="pt-2 font-mono text-xs text-[#F3C9B6]">{error}</p> : null}
      </section>
    </main>
  );
}
