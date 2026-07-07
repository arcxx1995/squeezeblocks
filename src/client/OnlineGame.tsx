import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { connectRealtime, context, disconnectRealtime, navigateTo, showToast } from "@devvit/web/client";
import {
  BOX_COLS,
  BOX_ROWS,
  LineOrientation,
  lineId,
  submitLine,
} from "../shared/engine";
import type { GameChannelMessage, LeaderRow, OnlineView, UserStats } from "../shared/online";
// Phaser (~1 MB) lives in board.tsx — lazy-split it out of the main bundle so
// the UI paints fast, and prefetch immediately so the board is ready by the
// time a match starts.
const boardModule = import("./board");
const GameBoard = lazy(() => boardModule.then((m) => ({ default: m.GameBoard })));
import { DailyChallenge } from "./DailyChallenge";
import { LobbyBoardAnim } from "./LobbyBoardAnim";

const TOTAL_BOXES = BOX_ROWS * BOX_COLS;
// Realtime pushes updates; this poll is only a safety net if a push is missed.
// Kept tight (not 15s) so a dropped push during play surfaces within a few
// seconds instead of feeling like a hang.
const FALLBACK_POLL_MS = 5000;
// While waiting in a lobby, the "opponent joined → game started" signal is
// realtime-only and can be missed (cross-post matchmaking broadcast), so poll
// fast until play begins.
const LOBBY_POLL_MS = 3000;
// Human-ish pacing for replaying a bot's turn: a "thinking" pause before its
// first line, then an uneven line-to-line rhythm. A flat cadence (or an
// instant single move) reads as a machine.
const botThinkMs = () => 700 + Math.random() * 900;
const botStepMs = () => 400 + Math.random() * 500;

// Ids of every owned (drawn) line in a view — the diff baseline for the reveal
// animation.
function ownedLineIds(view: OnlineView): Set<string> {
  const ids = new Set<string>();
  const state = view.game.state;
  if (state) {
    for (const line of Object.values(state.lines)) {
      if (line.ownerPlayerId) ids.add(line.id);
    }
  }
  return ids;
}
const HELP_KEY = "squeezeblocks:how-to-seen";

function hasSeenHelp(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(HELP_KEY) === "true";
  } catch {
    return false;
  }
}

function markHelpSeen(): void {
  try {
    window.localStorage.setItem(HELP_KEY, "true");
  } catch {
    // ignore storage errors (private mode, etc.)
  }
}

function playHaptic(durationMs = 10) {
  if (typeof navigator === "undefined") return;
  navigator.vibrate?.(durationMs);
}

async function callApi(path: string, body?: unknown): Promise<OnlineView> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message ?? `Request failed: ${res.status}`);
  return data as OnlineView;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "now";
  // Derive each unit straight from ms — chaining ceil (s→m→h) double-rounds, so
  // 24h+1ms became 1441m → 25h. Independent ceils cap correctly.
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.ceil(ms / 3600000)}h`;
}

export function OnlineGame() {
  const [view, setView] = useState<OnlineView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastMoveId, setLastMoveId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const [showHelp, setShowHelp] = useState(() => !hasSeenHelp());
  const [confirmResign, setConfirmResign] = useState(false);
  const [screen, setScreen] = useState<"game" | "daily">("game");
  const pendingRef = useRef(false);
  // serverNow - clientNow, sampled from each API response so the turn countdown
  // and skip gate track the server clock instead of a skewed local one.
  const clockOffsetRef = useRef(0);

  // Bot-turn animation: the server resolves a bot's whole turn in one update, so
  // multiple lines appear at once. We reveal them one at a time here — hide the
  // just-added lines, then un-hide them on a timer. Boxes pop as their 4th line
  // reveals (board.tsx gates box fill on hidden lines).
  const [hiddenLineIds, setHiddenLineIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const prevOwnedLinesRef = useRef<Set<string> | null>(null);
  const revealTimersRef = useRef<number[]>([]);
  // Latest applied/optimistic view, kept in sync synchronously so a burst of
  // capture taps each validate against the previous tap's board (React state
  // lags a render). The queue holds moves not yet confirmed by the server; a
  // single sender drains them in order so the server sees them serially.
  const viewRef = useRef<OnlineView | null>(null);
  const moveQueueRef = useRef<{ orientation: LineOrientation; row: number; col: number }[]>([]);
  const sendingRef = useRef(false);

  const clearRevealTimers = useCallback(() => {
    revealTimersRef.current.forEach((t) => window.clearTimeout(t));
    revealTimersRef.current = [];
  }, []);

  // Last known identity, so a realtime push (which carries only the shared game)
  // can rebuild a full view.
  const meRef = useRef<string | null>(null);
  // Last stats seen over HTTP. Realtime pushes omit them, so we re-attach these
  // to a pushed view — otherwise the end-game panel would blank on a push.
  const statsRef = useRef<{ myStats?: UserStats; leaderboard?: LeaderRow[] }>({});

  // Apply a new view and reveal any lines a bot just drew, one at a time.
  // `explicitOrder` is the server's true play order (bot capture chain); absent
  // it (human moves, older messages) we fall back to a board-order diff.
  // `syncClock` re-samples the server-clock offset — only true for HTTP
  // responses, since realtime pushes carry no fresh serverNow.
  const present = useCallback(
    (next: OnlineView, explicitOrder: string[] | undefined, syncClock: boolean) => {
      if (syncClock) clockOffsetRef.current = next.serverNow - Date.now();
      meRef.current = next.me;
      // Carry stats forward: keep the freshest we've seen, fall back to it when a
      // push omits them.
      if (next.myStats) statsRef.current.myStats = next.myStats;
      if (next.leaderboard) statsRef.current.leaderboard = next.leaderboard;
      next = {
        ...next,
        myStats: next.myStats ?? statsRef.current.myStats,
        leaderboard: next.leaderboard ?? statsRef.current.leaderboard,
      };
      clearRevealTimers();

      const nextOwned = ownedLineIds(next);
      const prev = prevOwnedLinesRef.current;
      prevOwnedLinesRef.current = nextOwned;

      const added =
        explicitOrder && explicitOrder.length > 0
          ? explicitOrder.filter((id) => nextOwned.has(id) && !prev?.has(id))
          : prev
            ? [...nextOwned].filter((id) => !prev.has(id))
            : [];

      // explicitOrder only exists for bot turns, so stage even a single bot
      // line behind the thinking pause. A lone line WITHOUT an order is a
      // human's move (ours or a live opponent's) — show it immediately.
      const isBotTurn = !!explicitOrder && explicitOrder.length > 0;
      if (added.length > 1 || (isBotTurn && added.length === 1)) {
        setHiddenLineIds(new Set(added));
        let at = botThinkMs();
        for (const id of added) {
          const t = window.setTimeout(
            () =>
              setHiddenLineIds((cur) => {
                const nextSet = new Set(cur);
                nextSet.delete(id);
                return nextSet;
              }),
            at,
          );
          revealTimersRef.current.push(t);
          at += botStepMs();
        }
      } else {
        setHiddenLineIds(new Set());
      }

      viewRef.current = next;
      setView(next);
    },
    [clearRevealTimers],
  );

  // Set view from an API response (uses the server's reveal order, syncs clock).
  const applyView = useCallback(
    (next: OnlineView) => present(next, next.revealOrder, true),
    [present],
  );

  // Drop pending reveals on unmount.
  useEffect(() => clearRevealTimers, [clearRevealTimers]);

  const openHelp = () => setShowHelp(true);
  const dismissHelp = () => {
    markHelpSeen();
    setShowHelp(false);
  };

  const setBusy = (busy: boolean) => {
    pendingRef.current = busy;
    setPending(busy);
  };

  const refresh = useCallback(async () => {
    try {
      applyView(await callApi("/api/init"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load game");
    }
  }, [applyView]);

  // Initial load.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Realtime: apply pushed state instantly. Keep our own `me` (the message
  // only carries the shared game, not the per-client identity).
  useEffect(() => {
    const channel = context.postId;
    if (!channel) return;
    connectRealtime<GameChannelMessage>({
      channel,
      onMessage: (msg) => {
        if (!msg?.game || pendingRef.current) return;
        // Watchers (the scheduler, or the other player) animate the bot turn
        // too, using the server's reveal order. No fresh serverNow on a push, so
        // keep the last clock offset (syncClock: false).
        const next: OnlineView = {
          game: msg.game,
          me: meRef.current,
          serverNow: 0,
          ...(msg.revealOrder ? { revealOrder: msg.revealOrder } : {}),
        };
        present(next, msg.revealOrder, false);
        // Pushes carry only the game, never per-viewer stats. When one ends the
        // game, pull fresh streak/leaderboard so the end panel isn't stale.
        if (msg.game.phase === "done") void refresh();
      },
    });
    return () => disconnectRealtime(channel);
  }, [present, refresh]);

  // Fallback poll in case a realtime push is missed; never clobbers an
  // in-flight local action. The lobby "game started" signal and a broadcast
  // fired from the *opponent's* post-context (matchmaking pairs across posts)
  // are realtime-only and can be missed on this channel.
  // Poll fast while in the lobby AND through the opening of play — the first
  // opponent move fires right after start, when this just-loaded client's
  // realtime socket may not be subscribed yet, so a missed push there must be
  // caught quickly rather than sitting in the slow backstop. Once any line is
  // drawn the socket is reliably up; drop to the backstop cadence.
  const st = view?.game.state;
  const noMovesYet =
    !!st && Object.values(st.lines).every((l) => !l.ownerPlayerId);
  const fastPoll =
    !!view &&
    (view.game.phase === "lobby" ||
      (view.game.phase === "playing" && noMovesYet));
  useEffect(() => {
    const id = window.setInterval(
      () => {
        if (!pendingRef.current) void refresh();
      },
      fastPoll ? LOBBY_POLL_MS : FALLBACK_POLL_MS,
    );
    return () => window.clearInterval(id);
  }, [refresh, fastPoll]);

  // Countdown tick, corrected to the server clock.
  useEffect(() => {
    const id = window.setInterval(
      () => setNow(Date.now() + clockOffsetRef.current),
      1000,
    );
    return () => window.clearInterval(id);
  }, []);

  // Drive bot turns. Only the first human seat drives, so multiple humans in a
  // bot game don't each fire a move for the same bot.
  useEffect(() => {
    const game = view?.game;
    if (!game || game.phase !== "playing" || !game.state) return;
    const seat = game.seats[game.state.currentPlayerIndex];
    const driver = game.seats.find((s) => !s.isBot)?.id;
    if (!seat?.isBot || driver !== view.me || pendingRef.current) return;
    const timer = window.setTimeout(async () => {
      setBusy(true);
      try {
        applyView(await callApi("/api/bot", {}));
      } catch {
        void refresh();
      } finally {
        setBusy(false);
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [view, refresh, applyView]);

  const join = async (withBots = false) => {
    setBusy(true);
    setError(null);
    try {
      applyView(await callApi("/api/join", withBots ? { withBots: true } : {}));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join");
    } finally {
      setBusy(false);
    }
  };

  // Send queued moves to the server one at a time, in order — a capture keeps
  // the turn, so move N+1 is only legal after move N has committed. Input isn't
  // blocked while this runs (the board gates on the optimistic turn, not on
  // `pending`), so a capture chain paints instantly and the sends catch up.
  const drainQueue = async () => {
    if (sendingRef.current) return; // a sender is already draining the queue
    sendingRef.current = true;
    pendingRef.current = true; // gate realtime pushes (they'd clobber optimism)
    setPending(true);
    let last: OnlineView | null = null;
    try {
      while (moveQueueRef.current.length > 0) {
        last = await callApi("/api/move", moveQueueRef.current.shift()!);
      }
    } catch (err) {
      // A rejected move means our optimistic board diverged — drop the queue and
      // resync to the authoritative state.
      moveQueueRef.current = [];
      setError(err instanceof Error ? err.message : "Move rejected");
      void refresh();
      last = null;
    } finally {
      sendingRef.current = false;
      pendingRef.current = false;
      setPending(false);
    }
    // Reconcile to the confirmed view once the chain fully drains (syncs clock +
    // stats). Skip if new taps queued or a fresh sender started — that drain
    // reconciles instead, and applying here could revert an unsent move.
    if (last && moveQueueRef.current.length === 0 && !sendingRef.current) {
      applyView(last);
    }
  };

  const drawLine = async (
    orientation: LineOrientation,
    row: number,
    col: number,
  ) => {
    // Validate against the latest optimistic board (viewRef), not React state,
    // so a fast second capture tap builds on the first.
    const current = viewRef.current;
    const state = current?.game.state;
    if (!current || !state) return;
    // Only draw on your own optimistic turn — closes the one-render window where
    // a tap could land just after a turn-ending move and paint as the opponent.
    if (state.players[state.currentPlayerIndex]?.id !== current.me) return;
    // Run the pure engine locally and show the line + turn switch instantly.
    // Same reference back means the move was invalid (owned line / not active).
    const optimistic = submitLine(
      state,
      orientation,
      row,
      col,
      Date.now() + clockOffsetRef.current,
    );
    if (optimistic === state) return;
    // Engine stamps its 20s real-time deadline; async play runs on the server's
    // 24h window. Carry the prior deadline so the countdown doesn't flash
    // "expired" before the server response resets it.
    optimistic.turnStartedAt = state.turnStartedAt;
    optimistic.turnDeadlineAt = state.turnDeadlineAt;

    setError(null);
    playHaptic();
    setLastMoveId(lineId(orientation, row, col));
    const optimisticView: OnlineView = {
      ...current,
      game: { ...current.game, state: optimistic },
    };
    // Seed the reveal baseline so the authoritative server view doesn't re-animate
    // the line we just painted, and sync viewRef so the next tap sees this move.
    prevOwnedLinesRef.current = ownedLineIds(optimisticView);
    viewRef.current = optimisticView;
    setView(optimisticView);

    moveQueueRef.current.push({ orientation, row, col });
    void drainQueue();
  };

  const newGame = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/new-game", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? "Could not start a game");
      navigateTo(data.url as string);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a game");
    } finally {
      setBusy(false);
    }
  };

  // Rematch resets this same post to a fresh game — no navigation. The opponent,
  // still on this post, flips in via the realtime broadcast.
  const rematch = async () => {
    setBusy(true);
    setError(null);
    try {
      applyView(await callApi("/api/rematch", {}));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a rematch");
    } finally {
      setBusy(false);
    }
  };

  const findOpponent = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/find-open", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? "Search failed");
      // Paired into an existing lobby → jump there (it's starting). Otherwise the
      // server seated us as the waiter; show that state so an opponent can find us.
      if (data.url) {
        // Cross-post match needs a navigation (the game lives on that post) —
        // flag it so the reload reads as "found a match", not a random refresh.
        showToast("Opponent found — joining…");
        navigateTo(data.url as string);
      } else if (data.view) applyView(data.view as OnlineView);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    setBusy(true);
    setError(null);
    try {
      applyView(await callApi("/api/skip", {}));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Skip failed");
    } finally {
      setBusy(false);
    }
  };

  const resign = async () => {
    setBusy(true);
    setError(null);
    setConfirmResign(false);
    try {
      applyView(await callApi("/api/resign", {}));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resign failed");
    } finally {
      setBusy(false);
    }
  };

  // The pinned daily post has no match — it opens straight into the daily, with
  // no way back to a lobby (there isn't one).
  if (view?.dailyPost) {
    return <DailyChallenge />;
  }

  if (screen === "daily") {
    return <DailyChallenge onExit={() => setScreen("game")} />;
  }

  if (!view) {
    // No how-to overlay during load — we don't yet know if this is a daily
    // (result) post, and flashing the card over "See result" is jarring. The
    // help still shows on the resolved lobby/playing/done screens below.
    return (
      <Shell>
        <p className="font-mono text-sm text-white/60">
          {error ?? "Loading game…"}
        </p>
      </Shell>
    );
  }

  const { game, me } = view;
  const amSeated = !!me && game.seats.some((seat) => seat.id === me);

  // ---- Lobby ----
  if (game.phase === "lobby" || !game.state) {
    return (
      <Shell overlay={showHelp ? <HowToOverlay onClose={dismissHelp} /> : null}>
        <Header subtitle="Online match" onHelp={openHelp} />
        <div className="flex flex-col gap-2.5">
        <LobbyBoardAnim />
        <section className="rounded-lg border border-white/15 bg-[#C5B0F4] p-4 text-black">
          <p className="text-xl font-bold leading-snug">
            Waiting for players ({game.seats.length}/{game.playerCount})
          </p>
          <p className="font-mono text-xs uppercase tracking-[0.12em] text-black/65">
            Game starts when the table is full
          </p>
        </section>

        <section className="grid grid-cols-2 gap-2">
          {game.seats.map((seat) => (
            <SeatCard
              key={seat.id}
              name={seat.name}
              color={seat.color}
              isMe={seat.id === me}
            />
          ))}
          {Array.from({ length: game.playerCount - game.seats.length }).map((_, i) => (
            <div
              key={`open-${i}`}
              className="rounded-lg border border-dashed border-white/20 bg-[#111111] p-3 text-white/40"
            >
              <p className="font-mono text-xs uppercase tracking-[0.12em]">Open seat</p>
            </div>
          ))}
        </section>

        <button
          type="button"
          disabled={pending}
          onClick={() => setScreen("daily")}
          className="min-h-11 rounded-full py-2 border border-[#DCEEB1]/40 bg-[#DCEEB1]/10 px-5 text-sm font-medium text-[#DCEEB1] transition hover:border-[#DCEEB1] disabled:opacity-50"
        >
          Play today&apos;s daily challenge
        </button>

        {!amSeated ? (
          game.invitedId && game.invitedId !== me ? (
            // A rematch reserved for someone else — joining would be rejected.
            <p className="font-mono text-xs leading-snug text-white/60">
              This is a rematch reserved for another player.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {game.invitedId === me ? (
                <p className="font-mono text-xs leading-snug text-[#DCEEB1]/80">
                  You&apos;ve been challenged to a rematch.
                </p>
              ) : null}
              <button
                type="button"
                disabled={pending || !me}
                onClick={() => join(false)}
                className="min-h-12 rounded-full py-2 bg-white px-6 text-base font-medium text-black transition hover:bg-[#F4ECD6] disabled:opacity-50"
              >
                {me ? "Join game" : "Sign in to Reddit to play"}
              </button>
              {/* A reserved rematch seat is for the named opponent only — no
                  matchmaking or bots, which would hijack it. */}
              {me && !game.invitedId ? (
                <>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={findOpponent}
                    className="min-h-12 rounded-full py-2 border border-white/25 bg-[#111111] px-6 text-base font-medium text-white transition hover:border-white/50 disabled:opacity-50"
                  >
                    Find an opponent
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => join(true)}
                    className="min-h-12 rounded-full py-2 border border-white/25 bg-[#111111] px-6 text-base font-medium text-white transition hover:border-white/50 disabled:opacity-50"
                  >
                    Play vs bots
                  </button>
                </>
              ) : null}
            </div>
          )
        ) : (
          <div className="flex flex-col gap-2">
            <p className="font-mono text-xs leading-snug text-[#DCEEB1]/80">
              {game.invitedId
                ? "Waiting for your rematch opponent to join."
                : "You're in — share this post for the other seat, or hop into a game already waiting."}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {/* No stranger matchmaking while a rematch seat is reserved. */}
              {!game.invitedId ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={findOpponent}
                  className="min-h-11 rounded-full py-2 bg-white px-4 text-sm font-medium text-black transition hover:bg-[#F4ECD6] disabled:opacity-50"
                >
                  Find an opponent
                </button>
              ) : null}
              <button
                type="button"
                disabled={pending}
                onClick={newGame}
                className="min-h-11 rounded-full py-2 border border-white/25 bg-[#111111] px-4 text-sm font-medium text-white transition hover:border-white/50 disabled:opacity-50"
              >
                Start another
              </button>
            </div>
          </div>
        )}
        {error ? <p className="font-mono text-xs text-[#F3C9B6]">{error}</p> : null}
        </div>
      </Shell>
    );
  }

  // ---- Playing / Done ----
  const state = game.state;
  const activePlayer = state.players[state.currentPlayerIndex];
  const isMyTurn =
    game.phase === "playing" && !!me && activePlayer?.id === me;
  const capturedBoxes = Object.values(state.boxes).filter(
    (box) => box.ownerPlayerId,
  ).length;
  // Cap at the turn window (deadline − start): if our clock lags the server the
  // raw deadline−now can read above the full window and show "25h". Clamped, it
  // never exceeds the real turn length. Still goes negative once expired so skip
  // can trigger.
  const remainingMs = Math.min(
    state.turnDeadlineAt - now,
    state.turnDeadlineAt - state.turnStartedAt,
  );
  // Only seated players may trigger the skip — the server rejects spectators,
  // so don't show them a button that can only error.
  // Only offer skip on your OWN expired turn — never a "nudge the opponent"
  // button, which would reveal it isn't your turn. The scheduler sweep advances
  // an opponent's expired turn on its own.
  const canSkip = game.phase === "playing" && remainingMs <= 0 && amSeated && isMyTurn;
  const canResign = game.phase === "playing" && amSeated;
  const winners = state.players.filter((player) =>
    state.winnerPlayerIds.includes(player.id),
  );
  // Rematch only makes sense against a human — a bot game just uses "New game".
  const humanOpponent =
    game.phase === "done" && amSeated
      ? game.seats.find((seat) => seat.id !== me && !seat.isBot)
      : undefined;

  return (
    <Shell overlay={showHelp ? <HowToOverlay onClose={dismissHelp} /> : null}>
      <Header subtitle="Online match" onHelp={openHelp} />

      {/* Player scoreboard while playing. On the done screen the Final-result
          panel below shows the same names + scores, so this row is dropped to
          keep the end-game buttons on screen (no scroll). */}
      {game.phase === "playing" ? (
        <section className="grid grid-cols-2 gap-2">
          {state.players.map((player, index) => (
            <div
              key={player.id}
              className={`rounded-lg border p-3 transition ${
                index === state.currentPlayerIndex
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
                    {player.id === me ? "You" : player.name}
                  </span>
                </div>
                <span className="font-mono text-xl font-normal">{player.score}</span>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {/* Turn banner — playing only. On the done screen the Final-result panel
          below carries the outcome, so this is dropped to keep the whole end
          screen on one page (no scroll). */}
      {game.phase === "playing" ? (
        <section className="rounded-lg border border-white/15 bg-[#C5B0F4] p-4 text-black">
          {/* min-h matches the size-14 countdown circle so the banner (and the
              flex-1 board below) keeps the same height whether or not the
              circle is rendered — no board resize on turn change. */}
          <div className="flex min-h-14 items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xl font-bold leading-snug">
                {isMyTurn ? "Your turn" : "Match in progress"}
              </p>
              <p className="font-mono text-xs uppercase tracking-[0.12em] text-black/65">
                {capturedBoxes} of {TOTAL_BOXES} boxes captured
              </p>
            </div>
            {/* Countdown only on your own turn — a ticking clock on someone
                else's turn signals "not your turn". */}
            {isMyTurn ? (
              <div className="grid size-14 place-items-center rounded-full border-4 border-white bg-black font-mono text-sm font-normal text-white">
                {formatRemaining(remainingMs)}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {game.phase === "done" ? (
        <section className="rounded-lg border border-white/15 bg-[#DCEEB1] p-4 text-black">
          <p className="text-xl font-bold leading-snug">
            {winners.length > 1
              ? "Draw game"
              : winners[0]?.id === me
                ? "You win"
                : `${winners[0]?.name} wins`}
          </p>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-black/60">
            Final result
          </p>
          <div className="mt-2 flex flex-col gap-1.5">
            {[...state.players]
              .sort((a, b) => b.score - a.score)
              .map((player) => (
                <div
                  key={player.id}
                  className="flex items-center justify-between"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="size-3 shrink-0 rounded-full"
                      style={{ backgroundColor: player.color }}
                    />
                    <span className="truncate text-sm font-bold">
                      {player.id === me ? "You" : player.name}
                      {state.winnerPlayerIds.includes(player.id) ? " 👑" : ""}
                    </span>
                  </div>
                  <span className="font-mono text-lg">{player.score}</span>
                </div>
              ))}
          </div>
        </section>
      ) : null}

      {game.phase === "done" ? (
        <StreakPanel stats={view.myStats} board={view.leaderboard} me={me} />
      ) : null}

      {/* Board only while playing. On the done screen it's non-interactive dead
          weight — dropping it frees the vertical space the result/streak panels
          and end-game buttons need (the screen doesn't scroll). */}
      {game.phase === "playing" ? (
        <section className="flex min-h-0 flex-1 items-center justify-center">
          {/* interactive gates on the optimistic turn, not `pending` — a capture
              keeps the turn, and blocking on the in-flight send would drop fast
              chained taps. isMyTurn flips false optimistically after a
              turn-ending move, so off-turn input is still blocked. */}
          <Suspense fallback={<div className="mx-auto aspect-square h-full max-h-full w-auto max-w-full" />}>
            <GameBoard
              game={state}
              lastMoveId={lastMoveId}
              onDrawLine={drawLine}
              interactive={isMyTurn && hiddenLineIds.size === 0}
              hiddenLineIds={hiddenLineIds}
            />
          </Suspense>
        </section>
      ) : null}

      {/* Done screen: the StreakPanel is flex-1 and absorbs the slack (its
          leaderboard list scrolls internally), pushing the buttons to the
          bottom. No separate spacer needed. */}

      {/* Skip appears once the active turn expires. */}
      {canSkip ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={skip}
            className="min-h-11 rounded-full py-2 border border-white/25 bg-[#111111] px-5 text-sm font-medium text-white transition hover:border-white/50 disabled:opacity-50"
          >
            Turn expired — skip
          </button>
        </div>
      ) : null}
      {canResign ? (
        <button
          type="button"
          disabled={pending}
          onClick={confirmResign ? resign : () => setConfirmResign(true)}
          onBlur={() => setConfirmResign(false)}
          className={`min-h-11 rounded-full py-2 border px-5 text-sm font-medium transition disabled:opacity-50 ${
            confirmResign
              ? "border-[#F3C9B6] bg-[#F3C9B6] text-black"
              : "border-white/15 bg-[#111111] text-white/70 hover:border-white/40"
          }`}
        >
          {confirmResign ? "Tap again to resign — opponent wins" : "Resign"}
        </button>
      ) : null}
      {humanOpponent ? (
        <button
          type="button"
          disabled={pending}
          onClick={rematch}
          className="min-h-12 rounded-full py-2 bg-white px-6 text-base font-medium text-black transition hover:bg-[#F4ECD6] disabled:opacity-50"
        >
          Rematch {humanOpponent.name}
        </button>
      ) : null}
      {game.phase === "done" ? (
        <button
          type="button"
          disabled={pending}
          onClick={newGame}
          className={`min-h-12 rounded-full py-2 px-6 text-base font-medium transition disabled:opacity-50 ${
            humanOpponent
              ? "border border-white/25 bg-[#111111] text-white hover:border-white/50"
              : "bg-white text-black hover:bg-[#F4ECD6]"
          }`}
        >
          Start a new game
        </button>
      ) : null}
      {game.phase === "done" ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => setScreen("daily")}
          className="min-h-12 rounded-full py-2 border border-[#DCEEB1]/40 bg-[#DCEEB1]/10 px-6 text-base font-medium text-[#DCEEB1] transition hover:border-[#DCEEB1] disabled:opacity-50"
        >
          🔥 Today&apos;s daily challenge
        </button>
      ) : null}
      {error ? <p className="pt-2 font-mono text-xs text-[#F3C9B6]">{error}</p> : null}
    </Shell>
  );
}

function Shell({ children, overlay }: { children: ReactNode; overlay?: ReactNode }) {
  return (
    <main className="app-phone-viewport text-white">
      {/* Uniform gap between sections/buttons on every screen (no justified
          spreading — that made gaps vary with viewport height). Content flows
          from the top; while playing the flex-1 board absorbs the slack so the
          buttons sit at the bottom, and any overflow scrolls (see game.css). */}
      <section className="app-phone-screen flex flex-col gap-3 px-4 py-4">{children}</section>
      {overlay}
    </main>
  );
}

function Header({ subtitle, onHelp }: { subtitle: string; onHelp: () => void }) {
  return (
    <header className="flex items-start justify-between gap-3 py-2">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-[#DCEEB1]">
          squeezeblocks
        </p>
        <h1 className="text-3xl font-[340] leading-none text-white">{subtitle}</h1>
      </div>
      <button
        type="button"
        onClick={onHelp}
        aria-label="How to play"
        className="grid size-9 shrink-0 place-items-center rounded-full border border-white/25 font-mono text-white/80 transition hover:border-white/50"
      >
        ?
      </button>
    </header>
  );
}

function HowToOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-6">
      <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-[#111111] p-6 text-white">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-[#DCEEB1]">
          How to play
        </p>
        <h2 className="mt-1 text-2xl font-[340]">Dots &amp; boxes</h2>
        <ul className="mt-4 flex flex-col gap-3 text-sm text-white/80">
          <li>Drag between two neighbouring dots to draw a line.</li>
          <li>Close the 4th side of a box to claim it — and take another turn.</li>
          <li>When every box is claimed, most boxes wins.</li>
          <li>Turns can span hours. You&apos;ll get a nudge when it&apos;s your move.</li>
        </ul>
        <button
          type="button"
          onClick={onClose}
          className="mt-6 h-12 w-full rounded-full bg-white text-base font-medium text-black transition hover:bg-[#F4ECD6]"
        >
          Got it
        </button>
      </div>
    </div>
  );
}

// End-of-game retention panel: your streak (come back or lose it) + the
// subreddit board (climb it). Both feed the reason to start another game.
function StreakPanel({
  stats,
  board,
  me,
}: {
  stats?: UserStats;
  board?: LeaderRow[];
  me: string | null;
}) {
  if (!stats && (!board || board.length === 0)) return null;
  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-white/15 bg-[#F4ECD6] p-4 text-black">
      {stats ? (
        <div className="flex shrink-0 items-baseline justify-between gap-3">
          <span className="text-lg font-bold">
            {stats.streak > 0 ? `🔥 ${stats.streak}-win streak` : "Streak reset"}
          </span>
          <span className="font-mono text-xs uppercase tracking-[0.12em] text-black/60">
            {stats.wins}W · {stats.losses}L · best {stats.best}
          </span>
        </div>
      ) : null}
      {board && board.length > 0 ? (
        <div className="mt-3 flex min-h-0 flex-1 flex-col">
          <p className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-black/60">
            Top players
          </p>
          <ol className="mt-1.5 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {board.slice(0, 50).map((row, i) => (
              <li
                key={row.name}
                className={`flex items-center justify-between text-sm ${
                  row.name === me ? "font-bold" : ""
                }`}
              >
                <span className="truncate">
                  {i + 1}. {row.name === me ? "You" : row.name}
                </span>
                <span className="font-mono">{row.wins}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

function SeatCard({
  name,
  color,
  isMe,
}: {
  name: string;
  color: string;
  isMe: boolean;
}) {
  return (
    <div className="rounded-lg border border-white/15 bg-[#111111] p-3 text-white">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="size-3 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="truncate text-sm font-extrabold">
          {isMe ? "You" : name}
        </span>
      </div>
    </div>
  );
}
