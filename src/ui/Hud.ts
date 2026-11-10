/**
 * Heads-up display.
 *
 * Kept to two elements — a crosshair and an ammo readout — because the brief
 * was photorealism and every pixel of interface is a pixel that is unambiguously
 * not photographed. What is here is drawn in DOM rather than in the scene, so it
 * stays perfectly sharp, costs no draw calls, and sits outside the grain and
 * aberration that are supposed to be artefacts of a camera looking at a room.
 *
 * The crosshair reacts to what the player is doing: it opens as they move,
 * kicks when they fire, and collapses to a dot when they aim. That is doing
 * real work — it communicates accuracy continuously, which is information the
 * player otherwise has to infer from where their shots land.
 */
export class Hud {
  private readonly crosshair: HTMLElement;
  private readonly lines: readonly HTMLElement[];
  private readonly ammoValue: HTMLElement;
  private readonly ammoTotal: HTMLElement;
  private readonly reloadNotice: HTMLElement;

  private spread = 0;

  public constructor(root: HTMLElement) {
    this.crosshair = requireElement(root, '#crosshair');
    this.lines = [
      requireElement(root, '#crosshair-top'),
      requireElement(root, '#crosshair-bottom'),
      requireElement(root, '#crosshair-left'),
      requireElement(root, '#crosshair-right'),
    ];
    this.ammoValue = requireElement(root, '#ammo-value');
    this.ammoTotal = requireElement(root, '#ammo-total');
    this.reloadNotice = requireElement(root, '#reload-notice');
  }

  /** Opens the crosshair on a shot. */
  public kick(): void {
    this.spread = Math.min(this.spread + 7, 26);
  }

  /**
   * Updates the display.
   *
   * @param delta - Frame delta, in seconds.
   * @param speed - Player speed, which widens the crosshair.
   * @param aimFraction - How far the weapon is raised, in `[0, 1]`.
   * @param ammo - Rounds remaining.
   * @param magazineSize - Magazine capacity.
   * @param reloading - Whether a reload is in progress.
   */
  public update(
    delta: number,
    speed: number,
    aimFraction: number,
    ammo: number,
    magazineSize: number,
    reloading: boolean,
  ): void {
    // Recoil spread decays; movement spread is continuous.
    this.spread += (0 - this.spread) * (1 - Math.exp(-7 * delta));
    const movement = Math.min(speed * 1.9, 11);
    const gap = (5 + movement + this.spread) * (1 - aimFraction * 0.92);

    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      const axis = i < 2 ? 'translateY' : 'translateX';
      const sign = i % 2 === 0 ? -1 : 1;
      line.style.transform = `${axis}(${String(sign * gap)}px)`;
    }

    // Aiming collapses the crosshair to near-nothing: the optic is the sight.
    this.crosshair.style.opacity = String(0.95 - aimFraction * 0.75);

    const ammoText = String(ammo);
    if (this.ammoValue.textContent !== ammoText) {
      this.ammoValue.textContent = ammoText;
      // Flag an empty magazine in red without a separate element.
      this.ammoValue.style.color = ammo === 0 ? '#e2574a' : '#e8e4da';
    }
    const totalText = `/ ${String(magazineSize)}`;
    if (this.ammoTotal.textContent !== totalText) {
      this.ammoTotal.textContent = totalText;
    }

    const noticeVisible = reloading || (ammo === 0 && !reloading);
    const notice = reloading ? 'RELOADING' : 'PRESS R';
    if (this.reloadNotice.textContent !== notice) {
      this.reloadNotice.textContent = notice;
    }
    this.reloadNotice.style.opacity = noticeVisible ? '1' : '0';
  }
}

function requireElement(root: HTMLElement, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`HUD is missing its "${selector}" element`);
  }
  return element;
}
