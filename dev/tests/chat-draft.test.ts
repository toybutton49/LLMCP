import test from 'node:test';
import assert from 'node:assert/strict';
import { submitChatDraft, type DraftSender } from '../../src/components/chat/submitChatDraft';

test('draft clears on preparation, not on failure or before preparation', async () => {
  let cleared = false;
  const fail: DraftSender = async () => { throw new Error('preparation failed'); };
  await assert.rejects(submitChatDraft('draft', fail, () => { cleared = true; }));
  assert.equal(cleared, false);
  await submitChatDraft('draft', async () => {}, () => { cleared = true; });
  assert.equal(cleared, false);
  let prepare: (() => void) | undefined;
  let finish: (() => void) | undefined;
  const send: DraftSender = async (_prompt, _truncate, options) => {
    prepare = options?.onPrepared;
    await new Promise<void>((resolve) => { finish = resolve; });
  };
  const pending = submitChatDraft('draft', send, () => { cleared = true; });
  assert.equal(cleared, false);
  prepare!();
  assert.equal(cleared, true);
  finish!();
  await pending;
});
