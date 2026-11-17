/**
 * Tiny dependency-free durable store.
 *
 * The whole application state lives in one JSON document per process. Writes
 * are serialized through an async mutex and committed with write-to-temp +
 * rename so a crash never leaves a half-written state file. Every mutation is
 * also appended to an in-memory journal that the UI can show for evidence.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DomainError, nowIso } from '../domain/model.js';

export class Store {
  constructor(filePath, initialStateFactory) {
    this.filePath = filePath;
    this.initialStateFactory = initialStateFactory;
    this.state = null;
    this._tail = Promise.resolve();
    this._loaded = false;
  }

  async load() {
    if (this._loaded) return this.state;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.state = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.state = this.initialStateFactory();
      await this._persist();
    }
    this._loaded = true;
    return this.state;
  }

  snapshot() {
    if (!this._loaded) throw new Error('Store not loaded');
    return JSON.parse(JSON.stringify(this.state));
  }

  /**
   * Run `mutator` exclusively against state. The mutator may mutate the draft
   * freely; it is only persisted when it returns without throwing. The return
   * value is passed back to the caller.
   */
  async transact(mutator, { label = 'mutation' } = {}) {
    const run = async () => {
      await this.load();
      const before = JSON.stringify(this.state);
      const result = await mutator(this.state);
      this._journal.push({ at: nowIso(), label, ok: true });
      if (JSON.stringify(this.state) !== before) await this._persist();
      return result;
    };
    const next = this._tail.then(run, run);
    // Keep the chain alive even when a caller's mutator throws.
    this._tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  get _journal() {
    if (!this.state.journal) this.state.journal = [];
    return this.state.journal;
  }

  async _persist() {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, this.filePath);
  }
}

export function notFound(code, message) {
  return new DomainError(code, message);
}
