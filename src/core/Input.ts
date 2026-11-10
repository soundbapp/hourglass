/**
 * Raw input, and the pointer lock that makes mouse look possible.
 *
 * Deliberately a thin layer over the browser: it accumulates state and nothing
 * else. Every decision about what input *means* — how fast the player turns,
 * whether a key is movement or a weapon action — belongs to the systems that
 * consume it, not here.
 *
 * Pointer motion is accumulated rather than sampled. Browsers deliver several
 * `pointermove` events between animation frames, and reading only the most
 * recent one silently discards the rest, which feels like the mouse skipping.
 */
export class Input {
  private readonly pressed = new Set<string>();
  private readonly buttons = new Set<number>();
  private readonly pressedThisFrame = new Set<string>();
  private readonly buttonsThisFrame = new Set<number>();

  private accumulatedX = 0;
  private accumulatedY = 0;
  private locked = false;
  private disposed = false;

  public constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    element.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    element.addEventListener('contextmenu', this.onContextMenu);
  }

  /** Whether the pointer is captured, meaning look input is live. */
  public get isLocked(): boolean {
    return this.locked;
  }

  /** Horizontal pointer movement since the last frame, in pixels. */
  public get lookX(): number {
    return this.accumulatedX;
  }

  /** Vertical pointer movement since the last frame, in pixels. */
  public get lookY(): number {
    return this.accumulatedY;
  }

  public isDown(code: string): boolean {
    return this.pressed.has(code);
  }

  /** Whether a key went down during this frame. */
  public wasPressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  public isButtonDown(button: number): boolean {
    return this.buttons.has(button);
  }

  /** Whether a mouse button went down during this frame. */
  public wasButtonPressed(button: number): boolean {
    return this.buttonsThisFrame.has(button);
  }

  /** Requests pointer capture. Must be called from a user gesture. */
  public requestLock(): void {
    if (!this.locked) {
      void this.element.requestPointerLock();
    }
  }

  /**
   * Clears per-frame deltas and edges.
   *
   * Called at the very end of the frame: anything that reads input must do so
   * before this, or it will miss a press that lasted exactly one frame.
   */
  public endFrame(): void {
    this.accumulatedX = 0;
    this.accumulatedY = 0;
    this.pressedThisFrame.clear();
    this.buttonsThisFrame.clear();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.pressed.has(event.code)) {
      this.pressedThisFrame.add(event.code);
    }
    this.pressed.add(event.code);
    // The browser scrolls on space and quick-finds on slash; neither is wanted
    // while the pointer is captured.
    if (this.locked && (event.code === 'Space' || event.code.startsWith('Arrow'))) {
      event.preventDefault();
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };

  /** A key held while the window loses focus never sends a keyup. */
  private readonly onBlur = (): void => {
    this.pressed.clear();
    this.buttons.clear();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.buttons.has(event.button)) {
      this.buttonsThisFrame.add(event.button);
    }
    this.buttons.add(event.button);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.buttons.delete(event.button);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.locked) {
      return;
    }
    // `movementX/Y` is the only source that keeps reporting once the pointer is
    // locked and therefore has no position.
    this.accumulatedX += event.movementX;
    this.accumulatedY += event.movementY;
  };

  private readonly onPointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.element;
    if (!this.locked) {
      this.pressed.clear();
      this.buttons.clear();
    }
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };
}
