---
name: setup
description: Set up Android Emulators after installation by checking the Android SDK, making sure a virtual device exists, and showing the device panel. Use when the user asks to set up the plugin.
---

# Set Up Android Emulators

1. Call `emulator_status`.
   - If Platform Tools are missing, tell the user to install them with Android Studio or sdkmanager and set `ANDROID_HOME` if the SDK is in a custom location. Stop there. Physical devices do not need the emulator package.
2. If the status lists no AVDs, call `emulator_create` with `profile: "pixel_9"`. If it reports that no system images are installed, tell the user to install one from Android Studio's SDK Manager, then stop.
3. Otherwise call `emulator_start` with no arguments.
4. Call `emulator_panel` to show the device. If the panel does not render inline, give the user the browser URL from the result.
5. Tell the user, briefly, where things are:
   - The **Android Emulator** panel shows devices pinned to this Cursor window; every chat in the window shares them. Use the dropdown to pin a connected phone or add another emulator. Compare or drag one device tab onto another for side-by-side testing.
   - Drag an APK onto the device to install it; the device controls list keyboard shortcuts.
