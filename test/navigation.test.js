import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const settle = async () => {
  for (let index = 0; index < 8; index += 1) await new Promise(resolve => setImmediate(resolve));
};

test('pet links claim the pending session and tolerate synchronous updates', async () => {
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
  const listeners = new Set();
  const events = new Map();
  const opened = [];
  let ready = false, cleanup, mailbox;
  const location = { hash: '', pathname: '/', search: '' };
  const list = {
    getSnapshot: () => ({ phase: ready ? 'ready' : 'loading' }),
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
  };
  const ctx = {
    slots: { inject() {} },
    sessions: { list }, workspaces: { list },
    uiWorkspace: { openSession(id) {
      opened.push(id);
      // Retaining a session can immediately notify the same subscribers.
      for (const listener of listeners) listener();
    } },
    effect(callback) { cleanup = callback(); },
  };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    // DSH answers the index with `303 ./`, so the target arrives through this
    // mailbox instead of the URL.
    const result = body.action === 'pending-focus' ? mailbox ?? {} : {};
    return { ok: true, json: async () => result };
  };
  runInNewContext(source, {
    location, fetch, console, URLSearchParams,
    history: { replaceState(_state, _title, url) {
      const next = new URL(url, 'http://127.0.0.1:1/');
      location.search = next.search;
      location.hash = next.hash;
    } },
    window: {
      __ModuleLoader__: { load(plugin) { plugin.factory(() => ({})).apply(ctx); } },
      addEventListener(name, callback) { events.set(name, callback); },
      removeEventListener(name) { events.delete(name); },
    },
  });
  // Nothing opens while the snapshots are still loading.
  mailbox = { sessionId: 'session-test' };
  await settle();
  assert.deepEqual(opened, []);
  ready = true;
  for (const listener of listeners) listener();
  await settle();
  assert.deepEqual(opened, ['session-test']);
  // The mailbox is one-shot, so a later focus event must not reopen anything.
  mailbox = {};
  events.get('focus')();
  await settle();
  assert.deepEqual(opened, ['session-test']);
  // An already-authenticated tab can still pass the id in its own URL.
  location.search = '?dsh-companion=session-next';
  events.get('focus')();
  await settle();
  assert.deepEqual(opened, ['session-test', 'session-next']);
  assert.equal(location.search, '');
  cleanup();
  assert.equal(listeners.size, 0);
  assert.equal(events.size, 0);
});
