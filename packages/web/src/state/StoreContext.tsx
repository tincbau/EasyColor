import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { GradeState } from '@easycolor/core';
import { GradeStore } from './store.js';

const StoreContext = createContext<GradeStore | null>(null);

export function StoreProvider({ store, children }: { store: GradeStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): GradeStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used inside a StoreProvider');
  return store;
}

/** Subscribe to the whole grade. */
export function useGrade(): GradeState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getGrade, store.getGrade);
}

/**
 * Subscribe to a slice.
 *
 * The selector runs on every store change, so keep it cheap and return a
 * stable reference — a fresh object literal here re-renders the whole panel
 * on every frame of a drag.
 */
export function useGradeSlice<T>(select: (grade: GradeState) => T): T {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getGrade()),
    () => select(store.getGrade()),
  );
}

/** Re-render when history changes (for the timeline and the undo buttons). */
export function useHistoryRevision(): number {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getRevision, store.getRevision);
}
