/**
 * Non-destructive action history.
 *
 * Every edit pushes a labelled snapshot. Snapshots are cheap because a grade
 * is a few kilobytes of plain numbers — the only large payload, a loaded 3D
 * LUT, is shared by reference rather than copied.
 *
 * Continuous edits (dragging a wheel, scrubbing a slider) coalesce: pushing
 * the same `mergeKey` inside `mergeWindowMs` replaces the previous entry
 * instead of adding one, so a drag becomes a single undo step.
 */

import type { GradeState } from './grade.js';
import { cloneGrade } from './grade.js';

export interface HistoryEntry {
  id: number;
  label: string;
  /** State *after* the action. */
  state: GradeState;
  at: number;
  mergeKey: string | null;
}

export interface HistoryOptions {
  limit?: number;
  mergeWindowMs?: number;
  now?: () => number;
}

export class History {
  private entries: HistoryEntry[] = [];
  private cursor = -1;
  private nextId = 1;
  private readonly limit: number;
  private readonly mergeWindowMs: number;
  private readonly now: () => number;
  private listeners = new Set<() => void>();

  constructor(initial: GradeState, opts: HistoryOptions = {}) {
    this.limit = opts.limit ?? 200;
    this.mergeWindowMs = opts.mergeWindowMs ?? 700;
    this.now = opts.now ?? (() => Date.now());
    this.entries.push({
      id: this.nextId++,
      label: 'Open',
      state: cloneGrade(initial),
      at: this.now(),
      mergeKey: null,
    });
    this.cursor = 0;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  get current(): GradeState {
    return this.entries[this.cursor].state;
  }

  get list(): readonly HistoryEntry[] {
    return this.entries;
  }

  get index(): number {
    return this.cursor;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.entries.length - 1;
  }

  /**
   * Record a new state.
   *
   * `mergeKey` groups a continuous gesture. Pass something stable for the
   * duration of the drag — e.g. `wheel:gain` or `zone:${id}:hue` — and call
   * `breakMerge()` when the pointer is released.
   */
  push(state: GradeState, label: string, mergeKey: string | null = null): void {
    const t = this.now();
    const top = this.entries[this.cursor];

    const canMerge =
      mergeKey !== null &&
      top.mergeKey === mergeKey &&
      this.cursor === this.entries.length - 1 &&
      t - top.at <= this.mergeWindowMs;

    if (canMerge) {
      top.state = cloneGrade(state);
      top.label = label;
      top.at = t;
      this.emit();
      return;
    }

    // Anything after the cursor is a redo branch the user has now abandoned.
    this.entries.length = this.cursor + 1;
    this.entries.push({
      id: this.nextId++,
      label,
      state: cloneGrade(state),
      at: t,
      mergeKey,
    });

    if (this.entries.length > this.limit) {
      // Drop the oldest, but never the very first "Open" entry's role as the
      // baseline — the new head simply becomes the baseline instead.
      this.entries.shift();
    }
    this.cursor = this.entries.length - 1;
    this.emit();
  }

  /**
   * Drop the newest entry entirely.
   *
   * For a gesture that turned out to be a no-op — clicking a colour to
   * inspect it and releasing without dragging. Pushing a compensating
   * "undo" entry would work, but it leaves two dead steps on the timeline
   * that the user then has to undo *through* to reach real work.
   *
   * Refuses when the cursor is not at the head (there is a redo branch to
   * protect), when only the baseline entry remains, or when `mergeKey` does
   * not match the head — so a stale call cannot eat someone else's edit.
   */
  discardLast(mergeKey: string | null = null): boolean {
    if (this.entries.length < 2) return false;
    if (this.cursor !== this.entries.length - 1) return false;
    if (mergeKey !== null && this.entries[this.cursor].mergeKey !== mergeKey) return false;

    this.entries.pop();
    this.cursor = this.entries.length - 1;
    this.emit();
    return true;
  }

  /** End a coalescing gesture so the next edit starts a fresh undo step. */
  breakMerge(): void {
    this.entries[this.cursor].mergeKey = null;
  }

  undo(): GradeState | null {
    if (!this.canUndo) return null;
    this.cursor--;
    this.emit();
    return this.current;
  }

  redo(): GradeState | null {
    if (!this.canRedo) return null;
    this.cursor++;
    this.emit();
    return this.current;
  }

  /** Jump to any point on the timeline. Out-of-range indices are ignored. */
  jumpTo(index: number): GradeState | null {
    if (index < 0 || index >= this.entries.length || index === this.cursor) return null;
    this.cursor = index;
    this.emit();
    return this.current;
  }

  /** Discard everything and restart from `state`. Used when loading a project. */
  reset(state: GradeState, label = 'Open'): void {
    this.entries = [
      { id: this.nextId++, label, state: cloneGrade(state), at: this.now(), mergeKey: null },
    ];
    this.cursor = 0;
    this.emit();
  }
}
