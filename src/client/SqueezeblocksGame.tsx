import { useEffect, useMemo, useState } from "react";
import {
  BOX_COLS,
  BOX_ROWS,
  GameState,
  LineOrientation,
  TURN_DURATION_SECONDS,
  createInitialGame,
  lineId,
  skipTurn,
  submitLine,
} from "../shared/engine";
import { GameBoard } from "./board";

// Haptic feedback, ported from the source app's settings helper. Devvit's
// webview has no settings store, so this is the bare vibrate call.
function playHaptic(durationMs = 10) {
  if (typeof navigator === "undefined") return;
  navigator.vibrate?.(durationMs);
}

const TOTAL_BOXES = BOX_ROWS * BOX_COLS;

// Local hotseat prototype (the original single-device game). Kept for dev/demo;
// the Reddit post default is the online game (see game.tsx / OnlineGame).
export function SqueezeblocksGame({ gameId = "local" }: { gameId?: string }) {
  const [game, setGame] = useState<GameState>(() => createInitialGame());
  const [now, setNow] = useState(() => Date.now());
  const [lastMoveId, setLastMoveId] = useState<string | null>(null);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (game.status !== "active") return;
    const delay = Math.max(0, game.turnDeadlineAt - Date.now());
    const timeout = window.setTimeout(() => {
      const currentTime = Date.now();
      setGame((current) =>
        current.status === "active" && current.turnDeadlineAt <= currentTime
          ? skipTurn(current, currentTime)
          : current,
      );
      setNow(currentTime);
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [game.status, game.turnDeadlineAt]);

  const activePlayer = game.players[game.currentPlayerIndex];
  const remainingSeconds = Math.max(
    0,
    Math.ceil((game.turnDeadlineAt - now) / 1000),
  );
  const capturedBoxes = useMemo(
    () => Object.values(game.boxes).filter((box) => box.ownerPlayerId).length,
    [game.boxes],
  );

  function drawLine(orientation: LineOrientation, row: number, col: number) {
    const id = lineId(orientation, row, col);
    if (game.lines[id]?.ownerPlayerId || game.status !== "active") return;
    playHaptic();
    setGame((current) => submitLine(current, orientation, row, col));
    setLastMoveId(id);
    setNow(Date.now());
  }

  function resetGame(startedAt: number) {
    setGame(createInitialGame(startedAt, 2));
    setLastMoveId(null);
    setNow(startedAt);
  }

  const winners = game.players.filter((player) =>
    game.winnerPlayerIds.includes(player.id),
  );

  return (
    <main className="app-phone-viewport text-white">
      <section className="app-phone-screen flex flex-col px-4 py-4">
        <header className="flex items-center justify-between gap-3 py-2">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-[#DCEEB1]">
              squeezeblocks
            </p>
            <h1 className="text-3xl font-[340] leading-none text-white">
              Local match
            </h1>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">
              Room {gameId}
            </p>
          </div>
          <button
            type="button"
            onClick={() => resetGame(Date.now())}
            className="h-10 rounded-full bg-white px-5 text-sm font-medium text-black transition hover:bg-[#F4ECD6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#C5B0F4]"
          >
            Reset
          </button>
        </header>

        <section className="grid grid-cols-2 gap-2 py-3">
          {game.players.map((player, index) => (
            <div
              key={player.id}
              className={`rounded-lg border p-3 transition ${
                index === game.currentPlayerIndex && game.status === "active"
                  ? "border-[#DCEEB1] bg-[#111111] text-white"
                  : "border-white/15 bg-[#111111] text-white"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="size-3 shrink-0 rounded-full"
                    style={{ backgroundColor: player.color }}
                  />
                  <span className="truncate text-sm font-extrabold">
                    {player.name}
                  </span>
                </div>
                <span className="font-mono text-xl font-normal">
                  {player.score}
                </span>
              </div>
              <p
                className={`mt-1 font-mono text-xs uppercase tracking-[0.12em] ${
                  index === game.currentPlayerIndex && game.status === "active"
                    ? "text-black/60"
                    : "text-white/55"
                }`}
              >
                {player.status === "inactive"
                  ? "Inactive"
                  : `${player.consecutiveSkips} skips`}
              </p>
            </div>
          ))}
        </section>

        <section className="rounded-lg border border-white/15 bg-[#C5B0F4] p-4 text-black">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xl font-bold leading-snug">
                {game.status === "completed"
                  ? winners.length > 1
                    ? "Draw game"
                    : `${winners[0]?.name} wins`
                  : `${activePlayer.name}'s turn`}
              </p>
              <p className="font-mono text-xs uppercase tracking-[0.12em] text-black/65">
                {capturedBoxes} of {TOTAL_BOXES} boxes captured
              </p>
            </div>
            <div
              className={`grid size-14 place-items-center rounded-full border-4 bg-black font-mono text-lg font-normal ${
                remainingSeconds <= 5 && game.status === "active"
                  ? "border-[#F3C9B6] text-[#F3C9B6]"
                  : "border-white text-white"
              }`}
            >
              {game.status === "completed" ? "OK" : remainingSeconds}
            </div>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-black/20">
            <div
              className="h-full rounded-full transition-all duration-200"
              style={{
                width: `${
                  game.status === "completed"
                    ? 100
                    : (remainingSeconds / TURN_DURATION_SECONDS) * 100
                }%`,
                backgroundColor:
                  remainingSeconds <= 5 ? "#F3C9B6" : "#000000",
              }}
            />
          </div>
        </section>

        <section className="flex min-h-0 flex-1 items-center justify-center py-4">
          <GameBoard
            game={game}
            lastMoveId={lastMoveId}
            onDrawLine={drawLine}
          />
        </section>
      </section>
    </main>
  );
}
