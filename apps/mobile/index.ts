import { registerRootComponent } from 'expo';

// Before `./App`, and therefore before the E2EE stack that imports an emscripten module expecting a
// UTF-16 decoder. Expo's runtime only decodes UTF-8, and the mismatch used to abort the process before
// anything rendered. Keeping it first is what makes the order a fact rather than an assumption.
import './src/lib/text-encoding';

import App from './App';
import { installGlobalHandler } from './src/lib/crash-report';

/**
 * Installed before anything renders: an error raised while the app is starting (a missing native
 * module, a bad import) is precisely the case that used to close the process with no explanation.
 * Errors now reach the device log under one tag and the in-app boundary.
 */
installGlobalHandler();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
