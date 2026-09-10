import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLoginForm } from '../src/auth.js';

test('parseLoginForm extracts dynamic Next.js action fields', () => {
  const html = `
    <html><body>
      <form method="POST">
        <input type="hidden" name="$ACTION_REF_1" />
        <input type="hidden" name="$ACTION_1:0" value="{&quot;id&quot;:&quot;dynamic-action-id&quot;,&quot;bound&quot;:&quot;$@1&quot;}" />
        <input type="hidden" name="$ACTION_1:1" value="[{&quot;ok&quot;:true}]" />
        <input type="hidden" name="$ACTION_KEY" value="dynamic-action-key" />
        <input type="hidden" name="from" value="" />
        <input name="username" />
        <input name="password" />
      </form>
    </body></html>
  `;

  assert.deepEqual(parseLoginForm(html), {
    actionRef: '',
    action0: '{"id":"dynamic-action-id","bound":"$@1"}',
    action1: '[{"ok":true}]',
    actionKey: 'dynamic-action-key',
    from: '',
    actionId: 'dynamic-action-id',
  });
});

test('parseLoginForm rejects a page without the expected form', () => {
  assert.throws(
    () => parseLoginForm('<form><input name="username" /></form>'),
    /expected Next\.js Server Action fields/,
  );
});
