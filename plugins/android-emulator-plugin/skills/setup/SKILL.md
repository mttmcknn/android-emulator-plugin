---
name: setup
description: Set up Android Emulators after installation by checking the Android SDK, making sure a virtual device exists, and showing the device panel. Use when the user asks to set up the plugin.
---

# Set Up Android Emulators

1. Call `emulator_status`.
   - If it reports that the Android SDK emulator was not found, tell the user to install Android Studio (or the Android SDK Emulator and platform tools) and set `ANDROID_HOME` if the SDK is in a custom location. Stop there.
2. If the status lists no AVDs, call `emulator_create` with `profile: "pixel_9"`. If it reports that no system images are installed, tell the user to install one from Android Studio's SDK Manager, then stop.
3. Otherwise call `emulator_start` with no arguments.
4. Call `emulator_panel` to show the device.
5. Tell the user, briefly, where things are:
   - The **Android Emulator** tab in the chat's side panel shows this chat's device. Each chat gets its own emulator.
   - **Android Emulators** in the sidebar lists every running emulator and the devices on disk.
   - Settings for the default device, idle shutdown, and video quality are on the plugin's page.
   - Drag an APK onto the device to install it; the device controls list keyboard shortcuts.
