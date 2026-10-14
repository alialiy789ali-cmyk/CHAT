/**
 * The states an encrypted message body can be in — checked without a browser.
 *
 * A thread bubble has to distinguish five situations that all look like "no text": still decrypting,
 * this device holds no key, the ciphertext did not authenticate, the message is only a file, and the
 * message is genuinely empty. The first three are waits or failures; the fourth is a finished message
 * whose content is an attachment; the fifth should be impossible but must not render as a blank
 * bubble if a client ever produces it.
 *
 * This is the check that would have caught the real bug: an attachment-only message sat in the thread
 * saying "decrypting…" forever, because `text === ''` was read as "not here yet".
 *
 * Run: node --import tsx apps/web/scripts/ui-state-check.mts   (or `npm run check:ui -w @sovereign/web`)
 */
import { bodyPresentation } from '../src/lib/e2ee/presentation';
import { parseContent, sealFileForUpload, descriptorFor, encodeContent, type EncryptedFileDescriptor } from '../src/lib/e2ee/content';
import type { MessageLockState } from '../src/lib/e2ee/types';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function equal<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const descriptor: EncryptedFileDescriptor = {
  id: 'attachment-1',
  key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  iv: 'AAAAAAAAAAAAAAAA',
  name: 'تقرير.pdf',
  type: 'application/pdf',
  size: 1024,
};

// --- the waiting states --------------------------------------------------------------------------
for (const state of ['pending', 'plaintext'] as MessageLockState[]) {
  equal(`nothing decrypted yet + state ${state} → pending`, bodyPresentation(null, state), { kind: 'pending' });
}
equal('a locked row → locked', bodyPresentation(null, 'locked'), { kind: 'locked' });
equal('a failed row → failed', bodyPresentation(null, 'failed'), { kind: 'failed' });

// --- text ----------------------------------------------------------------------------------------
equal('decrypted text → text', bodyPresentation({ v: 1, text: 'مرحباً', files: [] }, 'decrypted'), {
  kind: 'text',
  text: 'مرحباً',
});
equal(
  'decrypted text with files → text (and the files render below it)',
  bodyPresentation({ v: 1, text: 'see attached', files: [descriptor] }, 'decrypted'),
  { kind: 'text', text: 'see attached' },
);

// --- the bug -------------------------------------------------------------------------------------
equal(
  'an attachment-only payload → attachments, never "decrypting"',
  bodyPresentation({ v: 1, text: '', files: [descriptor] }, 'decrypted'),
  { kind: 'attachments' },
);
equal('an empty payload → empty, not a blank bubble', bodyPresentation({ v: 1, text: '', files: [] }, 'decrypted'), {
  kind: 'empty',
});
check(
  'the attachment-only case is not reported as pending',
  bodyPresentation({ v: 1, text: '', files: [descriptor] }, 'decrypted').kind !== 'pending',
);

// --- through the real encoder and parser, not hand-written objects -------------------------------
const encoded = encodeContent('', [descriptor]);
const parsed = parseContent(encoded);
equal('the real encoder keeps the empty text and the file', parsed, { v: 1, text: '', files: [descriptor] });
equal('…and its body presentation is attachments', bodyPresentation(parsed, 'decrypted'), { kind: 'attachments' });
check(
  'the descriptor is reachable for the attachment it describes',
  descriptorFor(parsed.files, 'attachment-1')?.name === 'تقرير.pdf',
);
check('an unknown attachment id has no descriptor', descriptorFor(parsed.files, 'attachment-2') === null);

// Plain-text messages that happen to start with `{` must still render as text, not as a payload.
const notJson = parseContent('{ this is not json');
equal('a non-JSON body survives parsing as text', bodyPresentation(notJson, 'decrypted'), {
  kind: 'text',
  text: '{ this is not json',
});

// A bare string is how messages written before the envelope version existed look.
equal('an older bare-string payload still renders as text', bodyPresentation(parseContent('قديمة'), 'decrypted'), {
  kind: 'text',
  text: 'قديمة',
});

// --- sealing a file is the same format the parser and the UI agree on -----------------------------
const plaintextBytes = new Uint8Array([1, 2, 3, 4, 5]);
const file = new File([plaintextBytes], 'صورة.png', { type: 'image/png' });
const sealed = await sealFileForUpload(file, 'صورة.png', 'image/png');
const sealedContent = parseContent(encodeContent('', [sealed.describe('attachment-9')]));

equal('a sealed file-only message is presented as attachments', bodyPresentation(sealedContent, 'decrypted'), {
  kind: 'attachments',
});
check('the sealed descriptor keeps the original name', sealedContent.files[0]?.name === 'صورة.png');
check('the sealed descriptor keeps the original type', sealedContent.files[0]?.type === 'image/png');
check('the sealed descriptor records the plaintext size', sealedContent.files[0]?.size === plaintextBytes.byteLength);

const uploaded = sealed.form.get('file');
check('the upload carries a blob', uploaded instanceof Blob);
const ciphertext = new Uint8Array(await (uploaded as Blob).arrayBuffer());
check('the upload is declared as opaque bytes', sealed.form.get('encrypted') === 'true');
// The server's stored row must not carry the real name: that is the whole point of the envelope.
check('the uploaded file name is a neutral placeholder, not the real one',
  (uploaded as File).name === 'encrypted.bin' && (uploaded as File).name !== 'صورة.png');
check('the ciphertext is longer than the plaintext (GCM tag)', ciphertext.byteLength > plaintextBytes.byteLength);
check(
  'the plaintext bytes are nowhere in the ciphertext',
  !ciphertext.some((byte, index) => byte === plaintextBytes[0] && ciphertext.slice(index, index + plaintextBytes.length).every((value, offset) => value === plaintextBytes[offset])),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
