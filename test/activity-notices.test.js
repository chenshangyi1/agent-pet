import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityNoticeTracker } from '../runtime/activity-notices.js';

const row = (sessionId, status, lastSeq, updatedAt = lastSeq) => ({ sessionId, status, lastSeq, updatedAt });

test('每个会话的待确认、受阻和完成状态都会独立提醒', () => {
  const track = createActivityNoticeTracker();
  const waiting = row('session-a', 'waiting', 5);
  const running = row('session-b', 'running', 6);
  assert.deepEqual(track([waiting, running]), [waiting]);

  const ready = row('session-b', 'ready', 8);
  assert.deepEqual(track([waiting, ready]), [ready]);
  assert.deepEqual(track([waiting, ready]), []);

  const blocked = row('session-c', 'blocked', 9);
  assert.deepEqual(track([waiting, ready, blocked]), [blocked]);
});

test('会话有新事件时会再次提醒，并在会话离开活动列表后清理记录', () => {
  const track = createActivityNoticeTracker();
  assert.equal(track([row('session-a', 'ready', 4)]).length, 1);
  assert.equal(track([row('session-a', 'ready', 4)]).length, 0);
  assert.equal(track([row('session-a', 'ready', 7)]).length, 1);
  track([]);
  assert.equal(track([row('session-a', 'ready', 7)]).length, 1);
});
