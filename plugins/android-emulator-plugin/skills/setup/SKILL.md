---
name: setup
description: Set up Android Emulators after installation by checking the Android SDK, making sure a virtual device exists, and showing the device panel. Use when the user asks to set up the plugin.
---

# Set Up Android Emulators

1. Call `check_device_status`.
   - If Platform Tools are missing, tell the user to install them with Android Studio or sdkmanager and set `ANDROID_HOME` if the SDK is in a custom location. Stop there. Physical devices do not need the emulator package.
2. If the status lists no AVDs, call `create_emulator` with `profile: "pixel_9"`. If it reports that no system images are installed, tell the user to install one from Android Studio's SDK Manager, then stop.
3. Otherwise call `start_emulator` with no arguments.
4. Successful startup opens the device panel automatically. Do not follow it with `show_device_panel`; use that tool only to reopen a closed panel or when the user asks to show it.
5. Tell the user, briefly, where things are:
   - The **Android Emulator** panel shows devices pinned to this chat. Use the dropdown to pin a connected phone or add another emulator. Compare or drag one device tab onto another for side-by-side testing.
   - **Android Emulators** in the sidebar lists every running emulator and the devices on disk.
   - Settings for the default device, idle shutdown, and video quality are on the plugin's page.
   - Drag an APK onto the device to install it; the device controls list keyboard shortcuts.
