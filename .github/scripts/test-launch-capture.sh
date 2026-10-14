#!/bin/sh
# Test the launch-capture harness without an emulator.
#
# The capture script decides whether an APK launched successfully, and it is the only witness this
# project has for "the app opens on a device". Two failed attempts proved it was not yet trustworthy:
# it reported a bare exit code and produced no files, and the failure was in the harness itself. So the
# harness gets tested like any other code — with a fake `adb` that replays the situations a phone
# produces: a healthy launch, a crash on launch, a refused install, a missing APK, and no adb at all.
#
# Run: sh .github/scripts/test-launch-capture.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CAPTURE="$SCRIPT_DIR/android-launch-capture.sh"
WORK="$(mktemp -d)"
PASSED=0
FAILED=0

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

ok() {
  PASSED=$((PASSED + 1))
  printf 'ok   %s\n' "$1"
}

bad() {
  FAILED=$((FAILED + 1))
  printf 'FAIL %s\n' "$1"
}

assert_contains() { # <file> <text> <description>
  if grep -qF -- "$2" "$1" 2>/dev/null; then
    ok "$3"
  else
    bad "$3 — '$2' is missing from $1"
    printf '--- %s ---\n' "$1"
    cat "$1" 2>/dev/null | head -n 40
    printf -- '---\n'
  fi
}

assert_file() { # <file> <description>
  if [ -f "$1" ]; then
    ok "$2"
  else
    bad "$2 — $1 does not exist"
  fi
}

assert_status() { # <expected> <actual> <description>
  if [ "$1" = "$2" ]; then
    ok "$3"
  else
    bad "$3 — expected exit $1, got $2"
  fi
}

# A stand-in for adb: answers each subcommand the way a device would, guided by FAKE_ADB_MODE.
write_fake_adb() {
  cat > "$1/adb" <<'FAKE'
#!/bin/sh
mode="${FAKE_ADB_MODE:-healthy}"
case "$1" in
  devices)
    echo "List of devices attached"
    echo "emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64x transport_id:1"
    ;;
  install)
    if [ "$mode" = "install-failure" ]; then
      echo "Performing Streamed Install"
      echo "Failure [INSTALL_FAILED_INVALID_APK: Package couldn't be installed in /data/app/app.sovereign.client]"
      exit 1
    fi
    echo "Performing Streamed Install"
    echo "Success"
    ;;
  exec-out)
    printf '\211PNG\r\n\032\n fake screenshot'
    ;;
  shell)
    shift
    case "$1" in
      getprop) echo "1" ;;
      dumpsys)
        case "$2" in
          package) echo "Package [app.sovereign.client] (abc123):"; echo "  versionName=0.1.0" ;;
          activity) echo "  mResumedActivity: ActivityRecord{1a2b3c u0 app.sovereign.client/.MainActivity t42}" ;;
          dropbox)
            if [ "$mode" = "crash" ]; then
              echo "2026-10-15 09:00:00 data_app_crash (text, 900 bytes)"
              echo "Process: app.sovereign.client, PID: 4242"
              echo "java.lang.RuntimeException: Unable to start activity"
            fi
            ;;
        esac
        ;;
      am) echo "Starting: Intent { cmp=app.sovereign.client/.MainActivity }"; echo "Status: ok" ;;
      pidof)
        if [ "$mode" = "crash" ]; then
          exit 0
        fi
        echo "4242"
        ;;
    esac
    ;;
  logcat)
    case "$*" in
      *-c*) exit 0 ;;
    esac
    if [ "$mode" = "crash" ]; then
      echo "10-15 09:00:00.123  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main"
      echo "10-15 09:00:00.123  4242  4242 E AndroidRuntime: Process: app.sovereign.client, PID: 4242"
      echo "10-15 09:00:00.123  4242  4242 E AndroidRuntime: java.lang.NoSuchMethodError: No static method kotlin"
    else
      echo "10-15 09:00:00.123  4242  4242 I ReactNativeJS: Running \"main\""
    fi
    ;;
esac
exit 0
FAKE
  chmod +x "$1/adb"
}

# A workspace shaped like the real one, so the capture script's paths resolve the same way.
new_workspace() { # <name>
  dir="$WORK/$1"
  rm -rf "$dir"
  mkdir -p "$dir/apps/mobile/android/app/build/outputs/apk/release" "$dir/bin"
  : > "$dir/apps/mobile/android/app/build/outputs/apk/release/app-release.apk"
  write_fake_adb "$dir/bin"
  printf '%s' "$dir"
}

run_case() { # <name> <mode> [<extra-env>]
  dir="$(new_workspace "$1")"
  mode="$2"
  (
    cd "$dir" || exit 99
    PATH="$dir/bin:/usr/bin:/bin"
    export PATH
    FAKE_ADB_MODE="$mode"
    export FAKE_ADB_MODE
    LAUNCH_SETTLE_SECONDS=0
    export LAUNCH_SETTLE_SECONDS
    sh "$CAPTURE" > "$dir/stdout.txt" 2>&1
  )
  return $?
}

# --- a launch that works --------------------------------------------------------------------------
run_case healthy healthy
status=$?
assert_status 0 "$status" "a healthy launch exits 0"
assert_file "$WORK/healthy/launch-logs/verdict.txt" "the verdict is written on success"
assert_contains "$WORK/healthy/launch-logs/verdict.txt" "pid after 0s: 4242" "the running process id is recorded"
assert_contains "$WORK/healthy/launch-logs/verdict.txt" "fatal exception: no" "a clean launch reports no fatal exception"
assert_contains "$WORK/healthy/launch-logs/verdict.txt" "boot completed: 1" "the boot state is recorded"
assert_contains "$WORK/healthy/launch-logs/verdict.txt" "app.sovereign.client/.MainActivity" "the foreground activity is recorded"
assert_contains "$WORK/healthy/stdout.txt" "the app is running (pid 4242)" "the job log says the app is running"
assert_file "$WORK/healthy/launch-logs/logcat.txt" "logcat is kept"
assert_file "$WORK/healthy/launch-logs/screen.png" "a screenshot is kept when the device allows it"
# The command under test writes the file's own contents; an empty file must never be ambiguous.
assert_contains "$WORK/healthy/launch-logs/install.txt" "Success" "the installer's own words are kept"
assert_contains "$WORK/healthy/launch-logs/install.txt" "exit status 0" "each capture records its exit status"

# --- a crash on launch ----------------------------------------------------------------------------
run_case crash crash
status=$?
assert_status 1 "$status" "a crash exits non-zero"
assert_file "$WORK/crash/launch-logs/verdict.txt" "the verdict is written on failure"
assert_contains "$WORK/crash/launch-logs/verdict.txt" "pid after 0s: none" "a dead process is reported as no pid"
assert_contains "$WORK/crash/launch-logs/verdict.txt" "fatal exception: yes" "the fatal exception is flagged"
assert_contains "$WORK/crash/stdout.txt" "FATAL EXCEPTION: main" "the job log prints the exception"
assert_contains "$WORK/crash/stdout.txt" "NoSuchMethodError" "the job log prints the stack"
assert_contains "$WORK/crash/launch-logs/dropbox.txt" "Unable to start activity" "Android's own crash record is kept"

# --- the APK will not install ---------------------------------------------------------------------
run_case install-failure install-failure
status=$?
assert_status 1 "$status" "a refused install exits non-zero"
assert_contains "$WORK/install-failure/launch-logs/verdict.txt" "the APK did not install" "the verdict names the install failure"
assert_contains "$WORK/install-failure/launch-logs/verdict.txt" "INSTALL_FAILED_INVALID_APK" "the installer's reason is kept"

# --- the build produced no APK --------------------------------------------------------------------
dir="$WORK/no-apk"
mkdir -p "$dir/bin"
write_fake_adb "$dir/bin"
rm -rf "$WORK/no-apk/apps/mobile/android/app/build/outputs"
(
  cd "$dir" || exit 99
  PATH="$dir/bin:/usr/bin:/bin"
  export PATH
  LAUNCH_SETTLE_SECONDS=0
  export LAUNCH_SETTLE_SECONDS
  sh "$CAPTURE" > "$dir/stdout.txt" 2>&1
)
status=$?
assert_status 1 "$status" "a missing APK exits non-zero"
assert_contains "$dir/launch-logs/verdict.txt" "no release APK" "a missing APK says so instead of failing silently"

# --- no adb anywhere ------------------------------------------------------------------------------
dir="$WORK/no-adb"
mkdir -p "$dir/bin" "$dir/apps/mobile/android/app/build/outputs/apk/release"
: > "$dir/apps/mobile/android/app/build/outputs/apk/release/app-release.apk"
(
  cd "$dir" || exit 99
  PATH="$dir/bin:/usr/bin:/bin"
  export PATH
  unset ANDROID_SDK_ROOT
  unset ANDROID_HOME
  HOME="$dir"
  export HOME
  LAUNCH_SETTLE_SECONDS=0
  export LAUNCH_SETTLE_SECONDS
  sh "$CAPTURE" > "$dir/stdout.txt" 2>&1
)
status=$?
assert_status 1 "$status" "a missing adb exits non-zero"
assert_contains "$dir/launch-logs/verdict.txt" "adb not found" "a missing adb is named, not implied"

printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
