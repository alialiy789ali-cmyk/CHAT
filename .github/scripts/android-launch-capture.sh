#!/bin/sh
# Capture what the freshly built APK does when it is launched on an emulator.
#
# Why this is a file and not a few lines inside the workflow: the emulator action splits its `script`
# input into single lines and runs *each line in its own shell*, so shell variables do not survive from
# one line to the next. A script written inline therefore lost `$APK` between two lines and died on
# `adb install -r ""` with a bare exit code, which is exactly what the first two smoke runs reported —
# no logs at all, and a failure that looked like an emulator problem while it was a shell problem.
#
# So: one line in the workflow (`sh .github/scripts/android-launch-capture.sh`), all the logic here,
# where it can be reviewed, syntax-checked, and exercised against a fake `adb`
# (`.github/scripts/test-launch-capture.sh`).
#
# Behaviour, in order:
#   1. resolve `adb` and the release APK, and say so instead of failing silently;
#   2. confirm the device finished booting;
#   3. install the APK and record the installer's own words;
#   4. clear the log, launch the main activity, then wait for the JavaScript bundle to come up;
#   5. capture the process id, the foreground activity, logcat, the crash buffer and Android's own
#      record of the last application crash;
#   6. decide, in `verdict.txt`, whether the app survived, and exit non-zero when it did not.
#
# Every capture is written to a file even when the command fails, each file begins with the command it
# ran, and the key evidence is printed to stdout at the end: it has to exist in three places (job log,
# uploaded artifact, report issue) because any one of them may be unreachable to the person reading it.
set -u

PACKAGE="app.sovereign.client"
ACTIVITY="$PACKAGE/.MainActivity"
OUT="launch-logs"
# A cold emulator resolves the JS bundle on the first launch; too short and a healthy app looks dead.
SETTLE_SECONDS="${LAUNCH_SETTLE_SECONDS:-45}"

mkdir -p "$OUT"

say() {
  printf '%s\n' "$*"
}

# Records "<command>" then its combined output, so an empty file is never mistaken for "silent".
capture() {
  _file="$OUT/$1"
  shift
  {
    printf '$ %s\n' "$*"
    "$@" 2>&1
    printf '(exit status %s)\n' "$?"
  } > "$_file"
}

# First line that starts with a number (after stripping CR) — pidof/boot/completion answers.
first_number() {
  grep -E '^[0-9]' "$1" 2>/dev/null | head -n 1 | tr -d '\r'
}

resolve_adb() {
  if command -v adb > /dev/null 2>&1; then
    command -v adb
    return 0
  fi
  for _candidate in "${ANDROID_SDK_ROOT:-}" "${ANDROID_HOME:-}" "$HOME/Android/Sdk"; do
    [ -n "$_candidate" ] || continue
    if [ -x "$_candidate/platform-tools/adb" ]; then
      printf '%s\n' "$_candidate/platform-tools/adb"
      return 0
    fi
  done
  return 1
}

say "=== launch capture on ${ANDROID_SERIAL:-the default device} ==="

ADB="$(resolve_adb || true)"
if [ -z "$ADB" ]; then
  say "adb was not found on PATH or under ANDROID_SDK_ROOT."
  {
    printf 'adb not found\n\n'
    printf 'PATH=%s\n' "$PATH"
    printf 'ANDROID_SDK_ROOT=%s\n' "${ANDROID_SDK_ROOT:-unset}"
  } > "$OUT/verdict.txt"
  exit 1
fi
say "adb: $ADB"

APK="$(find apps/mobile/android/app/build/outputs/apk/release -name '*.apk' 2>/dev/null | head -n 1)"
if [ -z "$APK" ]; then
  say "no release APK was found — there is nothing to launch."
  {
    printf 'no release APK under apps/mobile/android/app/build/outputs/apk/release\n\n'
    find apps/mobile/android/app/build/outputs 2>/dev/null || true
  } > "$OUT/verdict.txt"
  exit 1
fi
say "apk: $APK"
ls -l "$APK" > "$OUT/apk.txt" 2>&1

capture devices.txt "$ADB" devices -l
capture boot.txt "$ADB" shell getprop sys.boot_completed
say "device: $(grep -E 'emulator|device' "$OUT/devices.txt" 2>/dev/null | head -n 2 | tr '\n' ' ')"

# --- install ---------------------------------------------------------------------------------------
capture install.txt "$ADB" install -r -t "$APK"
if ! grep -q "Success" "$OUT/install.txt" 2>/dev/null; then
  # An install failure ends this test; the installer's own message says which failure it was.
  {
    printf 'the APK did not install\n\n'
    cat "$OUT/install.txt"
  } > "$OUT/verdict.txt"
  say "$(cat "$OUT/verdict.txt")"
  exit 1
fi

capture package.txt "$ADB" shell dumpsys package "$PACKAGE"

# --- launch ----------------------------------------------------------------------------------------
capture clear.txt "$ADB" logcat -c
# `am start -W` waits for the activity to become visible; the timeout keeps a hung start from hanging CI.
capture start.txt timeout 90 "$ADB" shell am start -W -n "$ACTIVITY"

say "waiting ${SETTLE_SECONDS}s for the app to settle…"
sleep "$SETTLE_SECONDS"

capture pid.txt "$ADB" shell pidof "$PACKAGE"
PID="$(first_number "$OUT/pid.txt")"

# A picture is what settles an argument about "it opened but showed nothing", so take one when we can.
if "$ADB" exec-out screencap -p > "$OUT/screen.png" 2> "$OUT/screen.txt"; then
  say "screenshot: $(wc -c < "$OUT/screen.png") bytes"
else
  say "screenshot: unavailable ($(head -n 2 "$OUT/screen.txt" | tr '\n' ' '))"
fi

capture activities.txt "$ADB" shell dumpsys activity activities
capture logcat.txt "$ADB" logcat -d -v threadtime
capture crash.txt "$ADB" logcat -d -b crash -v threadtime
# The framework's own record of the last application crash, stack trace included.
capture dropbox.txt "$ADB" shell dumpsys dropbox --print data_app_crash

# --- verdict ---------------------------------------------------------------------------------------
FATAL="$(grep -E "FATAL EXCEPTION" "$OUT/logcat.txt" "$OUT/crash.txt" "$OUT/dropbox.txt" 2>/dev/null | head -n 5)"
{
  printf 'device: %s\n' "${ANDROID_SERIAL:-default}"
  printf 'apk: %s\n' "$APK"
  printf 'pid after %ss: %s\n' "$SETTLE_SECONDS" "${PID:-none}"
  printf 'boot completed: %s\n' "$(first_number "$OUT/boot.txt")"
  printf 'foreground: %s\n' "$(grep -E "topResumedActivity|mResumedActivity" "$OUT/activities.txt" 2>/dev/null | head -n 1)"
  printf 'fatal exception: %s\n' "$(if [ -n "$FATAL" ]; then echo yes; else echo no; fi)"
} > "$OUT/verdict.txt"

say ""
say "=== verdict ==="
cat "$OUT/verdict.txt"

if [ -z "$PID" ]; then
  say ""
  say "=== why the process is gone: the fatal exception, if any ==="
  # The exception block is the whole point of this job; print it rather than a summary of it.
  awk '/FATAL EXCEPTION/,/^[[:space:]]*$/' "$OUT/crash.txt" "$OUT/logcat.txt" "$OUT/dropbox.txt" 2>/dev/null | head -n 120
  say ""
  say "=== app-tagged lines ==="
  grep -E "$PACKAGE|ReactNative|Hermes|expo|Sovereign" "$OUT/logcat.txt" 2>/dev/null | tail -n 80
  exit 1
fi

if [ -n "$FATAL" ]; then
  say ""
  say "=== the process is alive but a fatal exception was recorded ==="
  printf '%s\n' "$FATAL"
  exit 1
fi

say ""
say "=== the app is running (pid $PID) ==="
grep -E "mResumedActivity|topResumedActivity" "$OUT/activities.txt" | head -n 3
exit 0
