// Board size tuned for Reddit: a 5x5 = 25-box game finishes in one or two
// async sessions. Revert to 10/10/9/9 for the original 81-box board.
export const DOT_ROWS = 6;
export const DOT_COLS = 6;
export const BOX_ROWS = 5;
export const BOX_COLS = 5;
export const TURN_DURATION_SECONDS = 20;

export type LineOrientation = "horizontal" | "vertical";

export type Player = {
  id: string;
  name: string;
  color: string;
  score: number;
  consecutiveSkips: number;
  status: "active" | "inactive";
};

export type Line = {
  id: string;
  orientation: LineOrientation;
  row: number;
  col: number;
  ownerPlayerId: string | null;
};

export type Box = {
  id: string;
  row: number;
  col: number;
  ownerPlayerId: string | null;
};

export type MoveLogEntry = {
  id: string;
  message: string;
};

export type GameState = {
  players: Player[];
  lines: Record<string, Line>;
  boxes: Record<string, Box>;
  currentPlayerIndex: number;
  turnStartedAt: number;
  turnDeadlineAt: number;
  moveNumber: number;
  status: "active" | "completed";
  winnerPlayerIds: string[];
  log: MoveLogEntry[];
};

export function lineId(
  orientation: LineOrientation,
  row: number,
  col: number,
) {
  return `${orientation[0]}-${row}-${col}`;
}

export function boxId(row: number, col: number) {
  return `b-${row}-${col}`;
}

const LOCAL_PLAYER_SEEDS = [
  { name: "Lilac", color: "#C5B0F4" },
  { name: "Lime", color: "#DCEEB1" },
  { name: "Cream", color: "#F4ECD6" },
  { name: "Blush", color: "#EFD4D4" },
] as const;

export function createInitialGame(now = Date.now(), playerCount = 2): GameState {
  const count = Math.min(Math.max(playerCount, 2), LOCAL_PLAYER_SEEDS.length);
  const players: Player[] = LOCAL_PLAYER_SEEDS.slice(0, count).map((seed, index) => ({
    id: `player-${index + 1}`,
    name: seed.name,
    color: seed.color,
    score: 0,
    consecutiveSkips: 0,
    status: "active",
  }));

  const lines: Record<string, Line> = {};
  for (let row = 0; row < DOT_ROWS; row += 1) {
    for (let col = 0; col < DOT_COLS - 1; col += 1) {
      const id = lineId("horizontal", row, col);
      lines[id] = { id, orientation: "horizontal", row, col, ownerPlayerId: null };
    }
  }
  for (let row = 0; row < DOT_ROWS - 1; row += 1) {
    for (let col = 0; col < DOT_COLS; col += 1) {
      const id = lineId("vertical", row, col);
      lines[id] = { id, orientation: "vertical", row, col, ownerPlayerId: null };
    }
  }

  const boxes: Record<string, Box> = {};
  for (let row = 0; row < BOX_ROWS; row += 1) {
    for (let col = 0; col < BOX_COLS; col += 1) {
      const id = boxId(row, col);
      boxes[id] = { id, row, col, ownerPlayerId: null };
    }
  }

  return {
    players,
    lines,
    boxes,
    currentPlayerIndex: 0,
    turnStartedAt: now,
    turnDeadlineAt: now + TURN_DURATION_SECONDS * 1000,
    moveNumber: 0,
    status: "active",
    winnerPlayerIds: [],
    log: [{ id: "start", message: "Lilac starts the game." }],
  };
}

export function submitLine(
  state: GameState,
  orientation: LineOrientation,
  row: number,
  col: number,
  now = Date.now(),
): GameState {
  if (state.status !== "active") return state;

  const id = lineId(orientation, row, col);
  const existingLine = state.lines[id];
  if (!existingLine || existingLine.ownerPlayerId) return state;

  const player = state.players[state.currentPlayerIndex];
  const lines = {
    ...state.lines,
    [id]: { ...existingLine, ownerPlayerId: player.id },
  };
  const boxes = { ...state.boxes };

  const capturedBoxIds = getAdjacentBoxIds(orientation, row, col).filter(
    (candidateBoxId) =>
      boxes[candidateBoxId] &&
      !boxes[candidateBoxId].ownerPlayerId &&
      isBoxComplete(candidateBoxId, lines),
  );

  for (const capturedBoxId of capturedBoxIds) {
    boxes[capturedBoxId] = {
      ...boxes[capturedBoxId],
      ownerPlayerId: player.id,
    };
  }

  const players = state.players.map((candidate) =>
    candidate.id === player.id
      ? {
          ...candidate,
          score: candidate.score + capturedBoxIds.length,
          consecutiveSkips: 0,
          status: "active" as const,
        }
      : candidate,
  );

  const nextPlayerIndex =
    capturedBoxIds.length > 0
      ? state.currentPlayerIndex
      : getNextActivePlayerIndex(players, state.currentPlayerIndex);

  if (nextPlayerIndex === null) {
    return finishGame(
      { ...state, players, lines, boxes, moveNumber: state.moveNumber + 1 },
      "All players are inactive. Game over.",
    );
  }

  const nextState: GameState = {
    ...state,
    players,
    lines,
    boxes,
    currentPlayerIndex: nextPlayerIndex,
    turnStartedAt: now,
    turnDeadlineAt: now + TURN_DURATION_SECONDS * 1000,
    moveNumber: state.moveNumber + 1,
    log: [
      {
        id: `move-${state.moveNumber + 1}`,
        message:
          capturedBoxIds.length > 0
            ? `${player.name} captured ${capturedBoxIds.length} box${
                capturedBoxIds.length === 1 ? "" : "es"
              }.`
            : `${player.name} drew a line.`,
      },
      ...state.log,
    ].slice(0, 5),
  };

  return maybeCompleteGame(nextState);
}

export function skipTurn(state: GameState, now = Date.now()): GameState {
  if (state.status !== "active") return state;

  const player = state.players[state.currentPlayerIndex];
  const players = state.players.map((candidate) => {
    if (candidate.id !== player.id) return candidate;
    const consecutiveSkips = candidate.consecutiveSkips + 1;
    return {
      ...candidate,
      consecutiveSkips,
      status: consecutiveSkips >= 3 ? "inactive" : candidate.status,
    };
  });

  const nextPlayerIndex = getNextActivePlayerIndex(players, state.currentPlayerIndex);

  const skippedState: GameState = {
    ...state,
    players,
    currentPlayerIndex: state.currentPlayerIndex,
    log: [
      {
        id: `skip-${state.moveNumber}-${now}`,
        message: `${player.name} skipped their turn.`,
      },
      ...state.log,
    ].slice(0, 5),
  };

  if (nextPlayerIndex === null) {
    return finishGame(skippedState, "All players are inactive. Game over.");
  }

  return {
    ...skippedState,
    currentPlayerIndex: nextPlayerIndex,
    turnStartedAt: now,
    turnDeadlineAt: now + TURN_DURATION_SECONDS * 1000,
  };
}

// A player quits: mark them inactive and end the game, awarding the win to
// whoever is still active (the opponent in a 2-player match) — regardless of
// score. Returns the same reference if `playerId` isn't a player or the game is
// already over, matching the engine's no-op convention.
// ponytail: ends the whole game on one resign — correct while online is 2-player.
// For a 3–4 seat game you'd instead drop just that seat and keep playing.
export function resign(
  state: GameState,
  playerId: string,
  now = Date.now(),
): GameState {
  if (state.status !== "active") return state;
  const quitter = state.players.find((p) => p.id === playerId);
  if (!quitter) return state;

  const players = state.players.map((p) =>
    p.id === playerId ? { ...p, status: "inactive" as const } : p,
  );
  const winnerPlayerIds = players
    .filter((p) => p.status === "active")
    .map((p) => p.id);

  return {
    ...state,
    players,
    status: "completed",
    winnerPlayerIds,
    log: [
      { id: `resign-${now}`, message: `${quitter.name} resigned.` },
      ...state.log,
    ].slice(0, 5),
  };
}

function getAdjacentBoxIds(
  orientation: LineOrientation,
  row: number,
  col: number,
) {
  if (orientation === "horizontal") {
    return [
      row > 0 ? boxId(row - 1, col) : null,
      row < BOX_ROWS ? boxId(row, col) : null,
    ].filter((id): id is string => Boolean(id));
  }

  return [
    col > 0 ? boxId(row, col - 1) : null,
    col < BOX_COLS ? boxId(row, col) : null,
  ].filter((id): id is string => Boolean(id));
}

function isBoxComplete(id: string, lines: Record<string, Line>) {
  const box = parseBoxId(id);
  return (
    Boolean(lines[lineId("horizontal", box.row, box.col)]?.ownerPlayerId) &&
    Boolean(lines[lineId("horizontal", box.row + 1, box.col)]?.ownerPlayerId) &&
    Boolean(lines[lineId("vertical", box.row, box.col)]?.ownerPlayerId) &&
    Boolean(lines[lineId("vertical", box.row, box.col + 1)]?.ownerPlayerId)
  );
}

function parseBoxId(id: string) {
  const [, row, col] = id.split("-");
  return { row: Number(row), col: Number(col) };
}

function getNextActivePlayerIndex(players: Player[], currentPlayerIndex: number) {
  for (let offset = 1; offset <= players.length; offset += 1) {
    const candidateIndex = (currentPlayerIndex + offset) % players.length;
    if (players[candidateIndex].status === "active") return candidateIndex;
  }
  return null;
}

function maybeCompleteGame(state: GameState): GameState {
  const capturedBoxes = Object.values(state.boxes).filter(
    (box) => box.ownerPlayerId,
  ).length;

  if (capturedBoxes < BOX_ROWS * BOX_COLS) return state;

  return finishGame(state, "Game over.");
}

function finishGame(state: GameState, message: string): GameState {
  const highScore = Math.max(...state.players.map((player) => player.score));
  const winnerPlayerIds = state.players
    .filter((player) => player.score === highScore)
    .map((player) => player.id);

  return {
    ...state,
    status: "completed",
    winnerPlayerIds,
    log: [{ id: "completed", message }, ...state.log].slice(0, 5),
  };
}
