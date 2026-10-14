# Why the first APK closed on launch — and what fixed it

This is the record of the only failure in this project that a real person hit: the APK was built,
verified, installed, opened — and closed itself four seconds later. It is written down because the
diagnosis took three CI runs and a third-party source dive, and because the two things that finally made
it visible (a real emulator run, and a capture script that cannot silently produce nothing) matter more
than the one-line fix.

## Symptom

On a real Samsung phone, in Arabic: «تم إغلاق سيادي بسبب وجود خطأ في هذا التطبيق». No in-app message, no
error screen — the system's generic "app closed" dialog, plus a device-care prompt about clearing the
cache. The APK was 67.4 MB, installed cleanly, and had passed `apksigner verify` and `aapt2 dump badging`
in CI.

## First two attempts produced nothing (and why)

`.github/workflows/android-smoke.yml` boots an Android system image, installs the APK and launches it.
Its first two runs failed with a bare `/usr/bin/sh` exit code 2 and wrote **no files at all**, which read
like "the emulator never started". Two separate causes:

1. **No KVM step.** On Linux runners the emulator needs the `kvm` group to be usable; without the udev
   rule it cannot start. The `reactivecircus/android-emulator-runner` README states this requirement.
2. **The action runs its `script` input one line per shell.** `parseScript` in the action's source splits
   the input on newlines and runs each line with `sh -c` in a separate process, so shell variables do not
   survive. A multi-line script therefore lost `APK=$(find …)` between two lines and died on
   `adb install -r ""` with — exactly — exit code 2, before writing a single diagnostic.

The fix for both: the KVM step, and moving the capture into `.github/scripts/android-launch-capture.sh`,
invoked as **one line**. That script is now tested without an emulator
(`sh .github/scripts/test-launch-capture.sh`, 25 assertions against a fake `adb`) and that test runs in
CI's hermetic job, so a harness that captures nothing fails the build instead of producing an empty
report.

## The evidence

Run [38653165925](https://github.com/alialiy789ali-cmyk/CHAT/actions/runs/38653165925) reported to issue
#2 ("Android launch report"), from `launch-logs/`:

```
verdict.txt   device: emulator-5554
              apk: apps/mobile/android/app/build/outputs/apk/release/app-release.apk
              pid after 45s: none
              boot completed: 1
              foreground: topResumedActivity=ActivityRecord{… com.google.android.apps.nexuslauncher/.NexusLauncherActivity …}
              fatal exception: yes

install.txt   Performing Streamed Install / Success
start.txt     Status: ok / LaunchState: COLD / TotalTime: 1969 / Complete
crash.txt     F libc : Fatal signal 6 (SIGABRT), code -1 (SI_QUEUE) in tid 3465 (mqt_v_js), pid 3411 (overeign.client)
DEBUG         Abort message: 'terminating due to uncaught exception of type facebook::jni::JniException:
              com.facebook.react.common.JavascriptException: [runtime not ready]:
              RangeError: Unknown encoding: utf-16le (normalized: utf-16le), stack: …
              at com.facebook.react.runtime.ReactInstance$ReactJsExceptionHandlerImpl.reportJsException'
```

The app launched (`am start -W` reported the activity visible) and died ~4 s later, during bundle
evaluation, before anything rendered. That is why the phone showed "app closed" with no UI.

## Root cause

- **Expo SDK 57** installs a **UTF-8-only** `TextDecoder` over the global one
  (`expo/src/winter/TextDecoder.ts`, `install('TextDecoder', …)` in `runtime.native.ts`). Hermes ships no
  `TextDecoder` of its own, so on a phone the global decoder accepts `utf-8` and nothing else — it throws
  `RangeError: Unknown encoding: …`, word for word the message in the crash log.
- **`@privacyresearch/curve25519-typescript`** — the curve25519 inside
  `@privacyresearch/libsignal-protocol-typescript`, which the mobile client uses for the Signal protocol —
  is Emscripten output, and its glue runs `new TextDecoder('utf-16le')` **at module scope**
  (`lib/built/curveasm.js`, `var UTF16Decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-16le') : undefined;`).
- Importing the crypto library therefore throws while the module is being evaluated. There is no function
  to wrap and no promise to catch; React Native reports it as "runtime not ready" and aborts the process.
  Nothing in this app's own code asked for UTF-16.

## Fix

`apps/mobile/src/lib/text-encoding.ts` installs a `TextDecoder` that keeps the platform's decoder for
every encoding it already handles and adds the WHATWG rules for UTF-16 (little- and big-endian: BOM
stripping, surrogate pairs, `fatal`, streaming). It installs **at module evaluation time**, and only when
the platform's decoder cannot decode UTF-16, so Node and browsers are untouched. It is imported before
anything that reaches the crypto stack — first in `index.ts`, and first in `lib/e2ee/runtime.ts`, whose
import order is what makes the guarantee a fact.

The change does not touch key material and is not cryptography: it restores the encoding support the
WHATWG standard requires and Expo's runtime omits.

## Proof, and its limits

- `tests/libsignal-crash-repro.test.ts` reproduces the device failure: with Expo's decoder in place and no
  shim, importing the dependency rejects with `RangeError: Unknown encoding: utf-16le (normalized: utf-16le)`.
- `tests/libsignal-loading.test.ts` lays the same conditions, installs the shim the way the app does,
  imports the same module, and performs a real X25519 key agreement — the operation the protocol depends on.
- `tests/text-encoding.test.ts` compares the decoder against the platform's own implementation, including
  **every** streaming split point of a multi-script string, which is how a real bug in the first version
  (dropping a held-back byte on the final call) was found rather than shipped.
- The emulator run in `.github/workflows/android-smoke.yml` is the acceptance test: the app must stay up
  and the report must show a live pid. A green build is not this claim; a running process is.
- What an emulator still does not cover: a specific phone model, the camera, the microphone, a real
  cellular network, and the notification behaviour of a given OEM build — those remain untested in
  `docs/feature-log.md` rather than implied.

## If it happens again

```sh
adb logcat -s SovereignCrash          # fatal errors this app logs, with a stack
adb logcat -d -b crash                # Android's own crash buffer: look for "Abort message"
adb shell dumpsys dropbox --print data_app_crash
```

The app also installs a global error handler and a React error boundary
(`apps/mobile/src/lib/crash-report.ts`, `src/components/error-boundary.tsx`), so a JavaScript error that
does not abort the process now shows a readable screen with the error and a retry instead of a blank
window — and it says explicitly that nothing was sent to any server.
