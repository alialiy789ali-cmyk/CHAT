/**
 * Config plugin: set `android:usesCleartextTraffic` explicitly.
 *
 * Why this exists instead of a config key: Expo's own schema has no `android.usesCleartextTraffic`
 * (prebuild ignores it), and only the *debug* manifest that prebuild generates allows plain HTTP.
 * A release build therefore blocks `http://` no matter what the app config says — verified by
 * generating the project and reading the manifest, not by assumption.
 *
 * That matters because this platform is self-hosted: a server on a LAN address with no certificate
 * yet is a normal first deployment, and an operator testing that server on a real phone needs the
 * release APK to reach it. The alternative — telling people to build a debug APK — gives them an
 * artifact that is slower, unminified and not representative of what they will ship.
 *
 * The value is always written explicitly, either way:
 *
 *   `allow: false` (default) → `android:usesCleartextTraffic="false"`, so the built APK *says* that
 *                              plain HTTP is refused rather than relying on a platform default that
 *                              has changed between Android versions;
 *   `allow: true`            → `"true"`, which is what a LAN-only or pre-TLS deployment needs.
 *
 * Being explicit is also what makes the build verifiable: the pipeline reads the generated manifest
 * back and checks it matches the requested policy.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

/** @type {(config: import('@expo/config-types').ExpoConfig, options?: { allow?: boolean }) => import('@expo/config-types').ExpoConfig} */
module.exports = function withCleartextTraffic(config, options = {}) {
  const allow = options.allow === true;
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) throw new Error('with-cleartext-traffic: generated manifest has no <application>');
    application.$ = application.$ ?? {};
    application.$['android:usesCleartextTraffic'] = allow ? 'true' : 'false';
    // If another entry (or a future template) already declares the attribute, take precedence
    // instead of failing the build on a manifest merger conflict.
    const attrs = application.$['tools:replace'];
    const list = new Set((attrs ? String(attrs).split(',') : []).map((value) => value.trim()).filter(Boolean));
    list.add('android:usesCleartextTraffic');
    application.$['tools:replace'] = [...list].join(',');
    return mod;
  });
};
