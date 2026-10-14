/**
 * Dynamic Expo config: a thin overlay over `app.json`.
 *
 * Why an overlay at all — the APK has to be buildable for *different* servers without editing a
 * checked-in file, and one setting has a security-relevant default:
 *
 *   EXPO_PUBLIC_API_URL      the address compiled into this build (the user can still change it at
 *                            runtime from the login screen; see src/lib/server-address.ts)
 *   MOBILE_ALLOW_CLEARTEXT   allow plain http:// to the API. **Off by default**, because a build that
 *                            permits cleartext silently downgrades every request for anyone who
 *                            points it at an http address. The preview APK profile turns it on
 *                            explicitly so a self-hosted server without a certificate can be tested
 *                            on a real phone.
 *   ANDROID_VERSION_CODE     the Play-Store-visible build number.
 *
 * Everything else comes from `app.json` untouched, so there is one place that describes the app and
 * one place that adapts it to how it is being built.
 */
module.exports = ({ config }) => {
  const apiUrl = (process.env.EXPO_PUBLIC_API_URL ?? config.extra?.apiUrl ?? 'http://10.0.2.2:8787').replace(
    /\/+$/,
    '',
  );
  const allowCleartext = process.env.MOBILE_ALLOW_CLEARTEXT === 'true';
  const versionCode = Number.parseInt(process.env.ANDROID_VERSION_CODE ?? '1', 10);

  return {
    ...config,
    plugins: [
      ...(config.plugins ?? []),
      /**
       * The cleartext policy is applied by a local plugin because Expo's own schema has no such key
       * (see plugins/with-cleartext-traffic.js — it documents the verification that showed this).
       * It is part of the plugin list unconditionally, with the value as its option, so the built
       * manifest always states the policy explicitly.
       */
      ['./plugins/with-cleartext-traffic.js', { allow: allowCleartext }],
    ],
    extra: {
      ...(config.extra ?? {}),
      apiUrl,
      /** Recorded so a built APK can explain how it was produced (shown in Settings). */
      allowCleartext,
    },
    android: {
      ...(config.android ?? {}),
      versionCode: Number.isFinite(versionCode) ? versionCode : 1,
      usesCleartextTraffic: allowCleartext,
    },
  };
};
