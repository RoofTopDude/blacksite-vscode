/* Pan and zoom for the diagram viewer.
 *
 * The geometry is plain functions over a {x, y, scale} transform — content point p appears at
 * viewport point (x + p·scale, y + p·scale) — so it can be tested without a DOM. The
 * controller below binds those to pointer, wheel, and touch input and applies the result as a
 * CSS transform on the content element.
 *
 * Input model, chosen to feel native on both a mouse and a trackpad:
 * - mouse wheel zooms around the cursor, the way a map or an image viewer does;
 * - a trackpad's two-finger scroll pans, and its pinch (which arrives as ctrl+wheel) zooms;
 * - drag pans with the left or middle button, and two fingers pinch-zoom on a touch screen;
 * - double-click zooms in around the point, shift+double-click zooms out.
 * Discrete actions (buttons, keys, double-click, fit) animate; direct manipulation never does,
 * because a transform that lags the hand reads as sluggish rather than smooth.
 */

export interface Transform { x: number; y: number; scale: number }
export interface Size { width: number; height: number }
export interface Point { x: number; y: number }

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;
/** Fit never enlarges a small diagram past this — a three-node flowchart at 600% is not
 *  "fitted", it is shouting. */
export const MAX_FIT_SCALE = 1.5;
/** Minimum on-screen sliver of the diagram panning is allowed to leave, in pixels. */
const PAN_MARGIN = 48;

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(max, Math.max(min, scale));
}

/** Transform that centres the whole diagram in the viewport with `padding` to spare. */
export function fitTransform(content: Size, viewport: Size, padding = 40): Transform {
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { x: 0, y: 0, scale: 1 };
  }
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const scale = clampScale(Math.min(availableWidth / content.width, availableHeight / content.height, MAX_FIT_SCALE));
  return centeredAt(content, viewport, scale);
}

/** Transform at `scale` with the diagram's centre at the viewport's centre. */
export function centeredAt(content: Size, viewport: Size, scale: number): Transform {
  return {
    x: (viewport.width - content.width * scale) / 2,
    y: (viewport.height - content.height * scale) / 2,
    scale,
  };
}

/** Rescale while keeping the content point under viewport point `anchor` fixed under it. */
export function zoomAround(transform: Transform, nextScale: number, anchor: Point): Transform {
  const scale = clampScale(nextScale);
  const ratio = scale / transform.scale;
  return {
    x: anchor.x - (anchor.x - transform.x) * ratio,
    y: anchor.y - (anchor.y - transform.y) * ratio,
    scale,
  };
}

/** Keep at least a sliver of the diagram on screen, so it can never be panned out of reach. */
export function clampPan(transform: Transform, content: Size, viewport: Size): Transform {
  const width = content.width * transform.scale;
  const height = content.height * transform.scale;
  const marginX = Math.min(PAN_MARGIN, width / 2, viewport.width / 2);
  const marginY = Math.min(PAN_MARGIN, height / 2, viewport.height / 2);
  return {
    scale: transform.scale,
    x: Math.min(viewport.width - marginX, Math.max(marginX - width, transform.x)),
    y: Math.min(viewport.height - marginY, Math.max(marginY - height, transform.y)),
  };
}

/** The part of the diagram currently visible, in content coordinates. */
export function visibleRegion(transform: Transform, viewport: Size): { x: number; y: number; width: number; height: number } {
  return {
    x: -transform.x / transform.scale,
    y: -transform.y / transform.scale,
    width: viewport.width / transform.scale,
    height: viewport.height / transform.scale,
  };
}

/** Transform that puts content point `point` at the centre of the viewport, at the current scale. */
export function centerOn(transform: Transform, point: Point, viewport: Size): Transform {
  return {
    scale: transform.scale,
    x: viewport.width / 2 - point.x * transform.scale,
    y: viewport.height / 2 - point.y * transform.scale,
  };
}

/** Wheel delta in pixels, whatever unit the device reported it in. */
export function wheelPixels(event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">, pageHeight: number): Point {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1;
  return { x: event.deltaX * unit, y: event.deltaY * unit };
}

/**
 * Whether a plain (no ctrl) wheel event came from a notched mouse wheel rather than a
 * trackpad scroll. Browsers do not say, so this reads the shape: a mouse notch is a large,
 * whole, purely vertical step (or arrives in lines/pages); a trackpad reports small,
 * frequently fractional deltas and moves on both axes.
 */
export function isMouseWheel(event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">): boolean {
  if (event.deltaMode !== 0) return true;
  return event.deltaX === 0 && Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 40;
}

/** Zoom factor for a wheel step: exponential, so zooming in then out by the same travel
 *  lands exactly where it started. Clamped so one violent flick cannot jump 10×. */
export function wheelZoomFactor(deltaPixels: number, sensitivity: number): number {
  const clamped = Math.max(-240, Math.min(240, deltaPixels));
  return Math.exp(-clamped * sensitivity);
}

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

export interface PanZoomOptions {
  onChange?: (transform: Transform) => void;
  /** Called once per user gesture that moved the view, so the app can stop auto-fitting. */
  onUserMove?: () => void;
  /** Elements under the pointer that should not start a pan (toolbars, the minimap). */
  ignore?: (target: EventTarget | null) => boolean;
}

interface Animation {
  from: Transform;
  to: Transform;
  anchor?: Point;
  start: number;
  duration: number;
  frame: number;
}

export class PanZoomController {
  private _transform: Transform = { x: 0, y: 0, scale: 1 };
  private _content: Size = { width: 0, height: 0 };
  private readonly _pointers = new Map<number, Point>();
  private _pinch?: { distance: number; midpoint: Point };
  private _animation?: Animation;
  private readonly _cleanup: Array<() => void> = [];
  private readonly _reducedMotion: boolean;

  constructor(
    private readonly _viewport: HTMLElement,
    private readonly _target: HTMLElement,
    private readonly _options: PanZoomOptions = {},
  ) {
    this._reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    _target.style.transformOrigin = "0 0";
    this._listen(_viewport, "wheel", (event) => this._onWheel(event as WheelEvent), { passive: false });
    this._listen(_viewport, "pointerdown", (event) => this._onPointerDown(event as PointerEvent));
    this._listen(_viewport, "pointermove", (event) => this._onPointerMove(event as PointerEvent));
    this._listen(_viewport, "pointerup", (event) => this._onPointerUp(event as PointerEvent));
    this._listen(_viewport, "pointercancel", (event) => this._onPointerUp(event as PointerEvent));
    this._listen(_viewport, "dblclick", (event) => this._onDoubleClick(event as MouseEvent));
  }

  get transform(): Transform { return { ...this._transform }; }
  get contentSize(): Size { return { ...this._content }; }
  get viewportSize(): Size { return { width: this._viewport.clientWidth, height: this._viewport.clientHeight }; }

  setContentSize(size: Size): void { this._content = { ...size }; }

  destroy(): void {
    this._stopAnimation();
    for (const undo of this._cleanup.splice(0)) undo();
  }

  set(next: Transform, animate = false, anchor?: Point): void {
    const target = clampPan({ ...next, scale: clampScale(next.scale) }, this._content, this.viewportSize);
    this._stopAnimation();
    if (!animate || this._reducedMotion) { this._apply(target); return; }
    const animation: Animation = { from: this.transform, to: target, anchor, start: performance.now(), duration: 220, frame: 0 };
    const step = (now: number): void => {
      const progress = Math.min(1, (now - animation.start) / animation.duration);
      const eased = easeOutCubic(progress);
      // Interpolate scale geometrically: halfway between 1× and 4× should look like 2×.
      const scale = animation.from.scale * (animation.to.scale / animation.from.scale) ** eased;
      if (animation.anchor) {
        // Zooming around a point: keep that point pinned for the whole animation, not just
        // at its ends, or the diagram visibly swings sideways on the way.
        this._apply(zoomAround(animation.from, scale, animation.anchor));
      } else {
        this._apply({
          scale,
          x: animation.from.x + (animation.to.x - animation.from.x) * eased,
          y: animation.from.y + (animation.to.y - animation.from.y) * eased,
        });
      }
      if (progress < 1) animation.frame = requestAnimationFrame(step);
      else { this._apply(animation.to); this._animation = undefined; }
    };
    this._animation = animation;
    animation.frame = requestAnimationFrame(step);
  }

  fit(animate = false): void {
    this.set(fitTransform(this._content, this.viewportSize), animate);
  }

  /** Scale to `scale`, around `anchor` (viewport coordinates; defaults to the centre). */
  zoomTo(scale: number, anchor?: Point, animate = true): void {
    const point = anchor ?? { x: this._viewport.clientWidth / 2, y: this._viewport.clientHeight / 2 };
    this.set(zoomAround(this._transform, scale, point), animate, point);
  }

  zoomBy(factor: number, anchor?: Point, animate = true): void {
    this.zoomTo(this._transform.scale * factor, anchor, animate);
  }

  panBy(dx: number, dy: number, animate = false): void {
    this.set({ ...this._transform, x: this._transform.x + dx, y: this._transform.y + dy }, animate);
  }

  /** Centre the view on a content point, keeping the scale. */
  centerOn(point: Point, animate = false): void {
    this.set(centerOn(this._transform, point, this.viewportSize), animate);
  }

  private _apply(next: Transform): void {
    this._transform = next;
    this._target.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.scale})`;
    this._options.onChange?.(this.transform);
  }

  private _stopAnimation(): void {
    if (this._animation) cancelAnimationFrame(this._animation.frame);
    this._animation = undefined;
  }

  private _local(event: { clientX: number; clientY: number }): Point {
    const rect = this._viewport.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private _onWheel(event: WheelEvent): void {
    if (this._options.ignore?.(event.target)) return;
    event.preventDefault();
    const delta = wheelPixels(event, this._viewport.clientHeight);
    const anchor = this._local(event);
    if (event.ctrlKey || event.metaKey) {
      // Trackpad pinch (reported as ctrl+wheel) and ctrl+wheel: small deltas, fine steps.
      this._stopAnimation();
      this._userMoved();
      this.set(zoomAround(this._transform, this._transform.scale * wheelZoomFactor(delta.y, 0.01), anchor));
    } else if (isMouseWheel(event)) {
      this._stopAnimation();
      this._userMoved();
      this.set(zoomAround(this._transform, this._transform.scale * wheelZoomFactor(delta.y, 0.0022), anchor));
    } else {
      this._userMoved();
      const dx = event.shiftKey && delta.x === 0 ? delta.y : delta.x;
      const dy = event.shiftKey && delta.x === 0 ? 0 : delta.y;
      this.panBy(-dx, -dy);
    }
  }

  private _onPointerDown(event: PointerEvent): void {
    if (this._options.ignore?.(event.target)) return;
    if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 1) return;
    if (event.button === 1) event.preventDefault();
    this._stopAnimation();
    this._viewport.setPointerCapture?.(event.pointerId);
    this._pointers.set(event.pointerId, this._local(event));
    this._pinch = this._pointers.size === 2 ? this._pinchState() : undefined;
    this._viewport.classList.add("is-panning");
  }

  private _onPointerMove(event: PointerEvent): void {
    const previous = this._pointers.get(event.pointerId);
    if (!previous) return;
    const point = this._local(event);
    this._pointers.set(event.pointerId, point);

    if (this._pointers.size >= 2 && this._pinch) {
      const next = this._pinchState();
      const scaled = zoomAround(this._transform, this._transform.scale * (next.distance / this._pinch.distance), next.midpoint);
      this.set({ ...scaled, x: scaled.x + next.midpoint.x - this._pinch.midpoint.x, y: scaled.y + next.midpoint.y - this._pinch.midpoint.y });
      this._pinch = next;
      this._userMoved();
      return;
    }
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    if (dx === 0 && dy === 0) return;
    this._userMoved();
    this.panBy(dx, dy);
  }

  private _onPointerUp(event: PointerEvent): void {
    if (!this._pointers.delete(event.pointerId)) return;
    this._viewport.releasePointerCapture?.(event.pointerId);
    this._pinch = this._pointers.size === 2 ? this._pinchState() : undefined;
    if (this._pointers.size === 0) this._viewport.classList.remove("is-panning");
  }

  private _onDoubleClick(event: MouseEvent): void {
    if (this._options.ignore?.(event.target)) return;
    this._userMoved();
    this.zoomBy(event.shiftKey ? 0.5 : 2, this._local(event));
  }

  private _pinchState(): { distance: number; midpoint: Point } {
    const [a, b] = [...this._pointers.values()];
    if (!a || !b) return { distance: 1, midpoint: { x: 0, y: 0 } };
    return {
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }

  private _userMoved(): void {
    this._options.onUserMove?.();
  }

  private _listen(target: HTMLElement, type: string, handler: (event: Event) => void, options?: AddEventListenerOptions): void {
    target.addEventListener(type, handler, options);
    this._cleanup.push(() => target.removeEventListener(type, handler, options));
  }
}
