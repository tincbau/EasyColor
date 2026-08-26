/**
 * The application store.
 *
 * A hand-rolled store over `History` rather than a state library, for one
 * reason: in a grading app almost every interaction is a *drag*, and drags
 * need to distinguish "this is a new undo step" from "this is the same step,
 * moved". That distinction is the store's whole job here, and expressing it
 * through a generic library's middleware would be more code than this is.
 *
 * `useSyncExternalStore` handles the React binding, so the store stays a
 * plain object that the Electron main process and the Premiere bridge can
 * also drive without pulling React in.
 */

import { History, defaultGrade, cloneGrade } from '@easycolor/core';
import type { GradeState, HistoryEntry } from '@easycolor/core';

export type GradeUpdater = GradeState | ((current: GradeState) => GradeState);

export class GradeStore {
  private history: History;
  private listeners = new Set<() => void>();
  /** Bumped on every change so `useSyncExternalStore` sees a new snapshot. */
  private revision = 0;
  private cached: { revision: number; grade: GradeState } | null = null;

  constructor(initial: GradeState = defaultGrade()) {
    this.history = new History(initial);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    this.revision++;
    for (const l of this.listeners) l();
  }

  getGrade = (): GradeState => {
    if (!this.cached || this.cached.revision !== this.revision) {
      this.cached = { revision: this.revision, grade: this.history.current };
    }
    return this.cached.grade;
  };

  getRevision = (): number => this.revision;

  /**
   * Apply an edit.
   *
   * `mergeKey` should be stable for the duration of a gesture — for example
   * `wheel:gain:luma` while a wheel is being dragged — so the whole drag
   * collapses to one undo step. Call `commit()` when the pointer is released.
   */
  update(updater: GradeUpdater, label: string, mergeKey: string | null = null): void {
    const current = this.history.current;
    const next = typeof updater === 'function' ? updater(current) : updater;
    if (next === current) return;
    this.history.push(next, label, mergeKey);
    this.emit();
  }

  /**
   * Change something that is not part of the look — a wipe position, an
   * overlay toggle, the bypass key. These deliberately do not create history
   * entries: undoing back through half a dozen viewer toggles to reach an
   * actual colour change is nobody's idea of an undo stack.
   */
  updateViewer(mutate: (viewer: GradeState['viewer']) => GradeState['viewer']): void {
    const current = this.history.current;
    const viewer = mutate(current.viewer);
    if (viewer === current.viewer) return;
    // Assigning in place is deliberate: viewer state is workspace, not
    // document, so it must not fork the history entry it belongs to.
    current.viewer = viewer;
    this.emit();
  }

  /**
   * Throw away the most recent entry, when a gesture turned out to change
   * nothing. Pass the gesture's merge key so a stale call cannot discard an
   * unrelated edit.
   */
  discardLast(mergeKey: string | null = null): boolean {
    const discarded = this.history.discardLast(mergeKey);
    if (discarded) this.emit();
    return discarded;
  }

  /** End a coalescing gesture. */
  commit(): void {
    this.history.breakMerge();
  }

  undo(): void {
    if (this.history.undo()) this.emit();
  }

  redo(): void {
    if (this.history.redo()) this.emit();
  }

  jumpTo(index: number): void {
    if (this.history.jumpTo(index)) this.emit();
  }

  reset(grade: GradeState, label = 'Open'): void {
    this.history.reset(cloneGrade(grade), label);
    this.emit();
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  get entries(): readonly HistoryEntry[] {
    return this.history.list;
  }

  get historyIndex(): number {
    return this.history.index;
  }
}
