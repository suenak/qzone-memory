import { readFileSync } from 'node:fs';
import { createPinia, defineStore, setActivePinia } from 'pinia';
import { computed, onScopeDispose, ref } from 'vue';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const source = readFileSync(new URL('../../src/stores/archive.ts', import.meta.url), 'utf8');
const script = transpileModule(source, {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
}).outputText.replace(/^import[\s\S]*?;\r?\n/gm, '')
  .replace('export const useArchiveStore =', 'return');

export const idleProgress = () => ({
  status: 'idle', pages: 0, fetched: 0, saved: 0, skipped: 0,
  message: '尚未开始备份', librarySyncing: false,
});

/** Actual Pinia store with controlled IPC and timers; no native data is accessed. */
export function createArchiveHarness(overrides = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const timers = new Map();
  let timerId = 0;
  const calls = { progress: 0, syncs: [], retries: [] };
  const dependencies = {
    defineStore, computed, onScopeDispose, ref,
    IDLE_ARCHIVE_PROGRESS: idleProgress(),
    getArchiveProgress: () => {
      calls.progress++;
      return overrides.progress?.() ?? Promise.resolve(idleProgress());
    },
    syncQzoneLibrary: (...args) => {
      calls.syncs.push(args);
      return overrides.sync?.(...args) ?? Promise.resolve({ saved: 0, complete: true });
    },
    retryArchiveSkip: (id) => {
      calls.retries.push(id);
      return overrides.retry?.(id) ?? Promise.resolve({ success: true, message: 'Recovered', recoveredRecords: 1 });
    },
    window: {
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
  };
  const useArchiveStore = new Function(...Object.keys(dependencies), script)(...Object.values(dependencies));
  const store = useArchiveStore(pinia);
  return { store, calls, timers, dispose: () => store.$dispose() };
}
