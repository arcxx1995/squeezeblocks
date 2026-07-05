import { context, requestExpandedMode } from '@devvit/web/client';
import { startLobbyAnim } from './lobbyAnim';

// Full-screen ambient board: pulsating white dots + game-style lime/lilac lines
// filling the blank space, kept clear of the centered text. Runs for the life of
// the page — no cleanup.
const boardAnim = document.getElementById('board-anim') as HTMLCanvasElement | null;
if (boardAnim) startLobbyAnim(boardAnim, { cell: 52, pad: 26, avoidY: [0.34, 0.66] });

const startButton = document.getElementById('start-button') as HTMLButtonElement;

startButton.addEventListener('click', (e) => {
  requestExpandedMode(e, 'game');
});

// Personalize the headline when we know who's viewing. Daily-challenge posts
// get their own copy — resolved async so the splash still paints instantly.
const titleElement = document.getElementById('title');
if (titleElement && context.username) {
  const name = context.username;
  titleElement.textContent = `Your move, ${name}`;
  void fetch('/api/splash')
    .then((r) => (r.ok ? r.json() : null))
    .then((data: { daily?: boolean } | null) => {
      if (data?.daily) titleElement.textContent = `Play today's daily challenge, ${name}`;
    })
    .catch(() => {});
}
