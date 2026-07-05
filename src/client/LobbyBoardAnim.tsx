import { useEffect, useRef } from "react";
import { startLobbyAnim } from "./lobbyAnim";

// Thin React wrapper around the shared canvas animation (see lobbyAnim.ts).
export function LobbyBoardAnim() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Dense, edge-to-edge dot field filling the whole strip (small cell + pad).
    return startLobbyAnim(canvas, { cell: 34, pad: 10 });
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="h-28 w-full rounded-lg bg-[#0c0c0c]"
    />
  );
}
