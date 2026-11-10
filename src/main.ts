import { Game } from './Game.js';

/**
 * Entry point.
 *
 * Thin by design: find the canvas, build the world, and make every failure
 * legible. The one piece of real logic here is the gesture gate — browsers only
 * grant pointer lock from a user gesture, so the demo cannot capture the mouse
 * on its own and has to wait for a click.
 *
 * Failure handling is not an afterthought. A WebGL2 demo will be opened on
 * machines that cannot run it, and "a black rectangle and no explanation" is
 * the worst possible outcome both for the person looking at it and for anyone
 * trying to find out why.
 */

/** Delay before the boot overlay is removed, so the fade can play. */
const FADE_MS = 420;

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`document is missing its "${selector}" element`);
  }
  return element;
}

async function main(): Promise<void> {
  const canvas = requireElement<HTMLCanvasElement>('#viewport');
  const hudRoot = requireElement('#hud');
  const boot = requireElement('#boot');
  const bootStatus = requireElement('#boot-status');
  const bootError = requireElement('#boot-error');
  const bootBar = requireElement('#boot-bar > i');
  const startButton = requireElement<HTMLButtonElement>('#start-button');
  const pause = requireElement('#pause');
  const resumeButton = requireElement<HTMLButtonElement>('#resume-button');
  const controlsHint = requireElement('#controls-hint');

  const fail = (message: string): void => {
    bootStatus.textContent = 'failed to start';
    bootBar.style.width = '100%';
    bootError.hidden = false;
    bootError.textContent = message;
    startButton.hidden = true;
  };

  let game: Game;
  try {
    game = new Game(canvas, hudRoot);
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)}\n\n` +
        'This demo needs a browser with WebGL2 and hardware acceleration enabled.',
    );
    return;
  }

  try {
    await game.load((fraction, label) => {
      bootBar.style.width = `${String(Math.round(fraction * 100))}%`;
      bootStatus.textContent = label;
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  // Render immediately so the first thing behind the overlay is the room, not
  // a black canvas — the level is already built and there is nothing to wait for.
  game.start();

  bootStatus.textContent = 'ready';
  startButton.hidden = false;

  const enter = (): void => {
    boot.style.opacity = '0';
    window.setTimeout(() => {
      boot.hidden = true;
    }, FADE_MS);
    game.capturePointer();
  };

  startButton.addEventListener('click', enter);
  resumeButton.addEventListener('click', () => {
    pause.hidden = true;
    game.capturePointer();
  });

  // Pointer lock is released by Escape, by tabbing away, and by the browser
  // itself; the pause overlay is driven by the lock state rather than by any
  // one of those events, so it cannot get out of step.
  document.addEventListener('pointerlockchange', () => {
    const locked = game.isPointerLocked;
    if (!locked && boot.hidden) {
      pause.hidden = false;
    } else if (locked) {
      pause.hidden = true;
    }
    controlsHint.style.opacity = locked ? '0.85' : '0';
  });

  canvas.addEventListener('click', () => {
    if (boot.hidden && pause.hidden && !game.isPointerLocked) {
      game.capturePointer();
    }
  });

  // Exposed so a bug report can carry facts. The render chain measures some of
  // its own configuration at startup, so `__game.getDiagnostics()` in the
  // console is the difference between "it looks wrong" and "it looks wrong on
  // the full-float path".
  (window as unknown as { __game?: Game }).__game = game;

  window.addEventListener('beforeunload', () => {
    game.dispose();
  });
}

void main();
