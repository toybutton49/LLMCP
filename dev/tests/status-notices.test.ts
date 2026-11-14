import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { scheduleStatusDismissal, StatusNoticeBanner } from '../../src/components/layout/StatusNoticeBanner';
import type { StatusNotice } from '../../src/hooks/useStatusNotices';

test('notification states are labeled and errors are announced as alerts', () => {
  for (const kind of ['info', 'success', 'warning', 'error'] as const) {
    const markup = renderToStaticMarkup(React.createElement(StatusNoticeBanner, {
      notice: { id: 1, kind, message: 'Example message' },
      onDismiss: () => {}
    }));
    assert.ok(markup.includes(`role="${kind === 'error' ? 'alert' : 'status'}"`));
    assert.ok(markup.includes(`Dismiss ${kind} notification`));
    assert.ok(markup.includes('Example message'));
  }
});

test('notices expire independently and cancelled timers cannot dismiss a replacement', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dismissed: number[] = [];
  const notify = (id: number) => dismissed.push(id);
  const info: StatusNotice = { id: 1, kind: 'info', message: 'one' };
  const error: StatusNotice = { id: 2, kind: 'error', message: 'two' };
  scheduleStatusDismissal(info, notify);
  const cancelError = scheduleStatusDismissal(error, notify);
  t.mock.timers.tick(4999);
  assert.deepEqual(dismissed, []);
  t.mock.timers.tick(1);
  assert.deepEqual(dismissed, [1]);
  cancelError();
  scheduleStatusDismissal({ ...error, id: 3 }, notify);
  t.mock.timers.tick(7000);
  assert.deepEqual(dismissed, [1]);
  t.mock.timers.tick(5000);
  assert.deepEqual(dismissed, [1, 3]);
});
