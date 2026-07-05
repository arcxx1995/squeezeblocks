import { useCallback, useEffect, useRef, useState } from "react";
import {
  createInitialGame,
  lineId,
  submitLine,
  type GameState,
  type LineOrientation,
} from "../shared/engine";
import { botMove } from "../shared/bot";
import type { DailyView, MoveRequest } from "../shared/online";
import { GameBoard } from "./board";

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

const BOT_STEP_MS = 350;

export function DailyChallenge({ onExit }: { onExit?: () => void }) {
  const [info, setInfo] = useState<DailyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [lastMoveId, setLastMoveId] = useState<string | null>(null);
  const [botThinking, setBotThinking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const movesRef = useRef<MoveRequest[]>([]);
  const timersRef = useRef<number[]>([]);

  // Load today's challenge. If already played, we only show the result + board.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/daily");
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message ?? "Could not load the daily");
        setInfo(data as DailyView);
        if (!(data as DailyView).played) setState(freshDaily());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load the daily");
      }
    })();
    return () => timersRef.current.forEach((t) => window.clearTimeout(t));
  }, []);

  const submitRun = useCallback(async (moves: MoveRequest[]) => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/daily", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moves }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? "Could not submit your run");
      setInfo(data as DailyView);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit your run");
    } finally {
      setSubmitting(false);
    }
  }, []);

  // Run the bot's whole turn locally, one line at a time, then hand back to you.
  const runBot = useCallback(
    (start: GameState, seed: number) => {
      setBotThinking(true);
      let s = start;
      const tick = () => {
        if (s.status !== "active" || s.players[s.currentPlayerIndex]!.id !== "bot") {
          setBotThinking(false);
          if (s.status === "completed") void submitRun(movesRef.current);
          return;
        }
        const mv = botMove(s, seed);
        if (!mv) {
          setBotThinking(false);
          return;
        }
        s = submitLine(s, mv.orientation, mv.row, mv.col, 0);
        setState(s);
        setLastMoveId(lineId(mv.orientation, mv.row, mv.col));
        timersRef.current.push(window.setTimeout(tick, BOT_STEP_MS));
      };
      timersRef.current.push(window.setTimeout(tick, 250));
    },
    [submitRun],
  );

  const onDrawLine = (orientation: LineOrientation, row: number, col: number) => {
    if (!state || !info || botThinking) return;
    if (state.status !== "active" || state.players[state.currentPlayerIndex]!.id !== "you") return;
    const next = submitLine(state, orientation, row, col, 0);
    if (next === state) return; // illegal / owned
    movesRef.current = [...movesRef.current, { orientation, row, col }];
    setLastMoveId(lineId(orientation, row, col));
    setState(next);
    if (next.status === "completed") {
      void submitRun(movesRef.current);
    } else if (next.players[next.currentPlayerIndex]!.id === "bot") {
      runBot(next, info.seed);
    }
  };

  const played = info?.played ?? null;

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
            {info.date} · same board for everyone · one try
          </p>
        ) : null}

        {played ? (
          <section className="mt-3 rounded-lg border border-white/15 bg-[#DCEEB1] p-4 text-black">
            <p className="text-xl font-bold">
              {played.margin > 0
                ? `You beat the bot by ${played.margin}`
                : played.margin < 0
                  ? `Bot won by ${-played.margin}`
                  : "Dead heat"}
            </p>
            <p className="font-mono text-xs uppercase tracking-[0.12em] text-black/65">
              You {played.you} · Bot {played.bot} · come back tomorrow
            </p>
          </section>
        ) : null}

        {info && info.board.length > 0 ? (
          <section className="mt-3 rounded-lg border border-white/15 bg-[#111111] p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/50">
              Today&apos;s top margins
            </p>
            <ol className="mt-2 flex flex-col gap-1">
              {info.board.map((row, i) => (
                <li
                  key={row.name}
                  className={`flex items-center justify-between text-sm ${
                    row.name === info.me ? "font-bold text-[#DCEEB1]" : "text-white/80"
                  }`}
                >
                  <span className="truncate">
                    {i + 1}. {row.name === info.me ? "You" : row.name}
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
            </section>
          </>
        ) : null}

        {error ? <p className="pt-2 font-mono text-xs text-[#F3C9B6]">{error}</p> : null}
      </section>
    </main>
  );
}
