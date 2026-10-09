---
name: emulator
description: Use this Cursor window's Android emulator to run, inspect, and test Android apps. Use when the user asks to start, create, or use an emulator; diagnose a panel or connection failure; install or launch an APK; verify Android UI behavior; or check dark mode, font scale, rotation, location, or battery.
---

# Android Emulators

In Cursor, a "chat" below means the Cursor window: every chat in one window shares the same pinned devices, and different windows never share a device. The window can pin multiple emulators and connected Android devices. The `emulator` MCP tools identify the window automatically and reject another window's device IDs. Re-read the screen before acting if another chat in the window may have used the device.

## Start and show the emulator

1. Call `emulator_devices` or `emulator_status`. To use a connected phone, call `emulator_pin` with its listed serial. If it belongs to another chat, let the user confirm the move in the panel; never try to bypass confirmation. If the user named an existing AVD, pass it to `emulator_start`; otherwise let `emulator_start` choose one that is not already running.
   Without a name, `emulator_start` uses the user's default device setting.
2. If no AVD exists or none matches the requested device, call `emulator_create` with a profile such as `pixel_9` or `pixel_tablet`. It uses the newest suitable installed system image and starts the device. Leave `keep` false unless the user wants the device after this chat.
3. After a successful `emulator_start` or `emulator_create`, call `emulator_panel` once to show the device, and reuse that panel during testing. If the panel does not render inline, give the user the browser URL from the result; it shows the same live panel.
4. Tell the user which AVD and serial the chat owns, and whether it is read-only (state is discarded on stop).

For comparison, start another AVD or use `newInstance: true` for a second instance of the same AVD. The panel has separate device tabs; Compare or dragging one tab onto another shows both. Use the IDs from `emulator_devices` and pass `deviceId` on every device action when multiple devices are pinned. Never infer a target from the visible tab. Disconnecting a phone leaves its pin unavailable; it never redirects actions to a different device.

## Operate the device

- Use only this plugin's device tools for this device. Do not run `adb`, `emulator`, or Gradle device tasks against another serial, and never stop an emulator this chat does not own.
- Start with `emulator_observe` for a screenshot, UI elements, and foreground app in one call. Reads run concurrently; check partial errors and remember a changing screen may differ between reads. Use `emulator_ui_tree` for lighter target lookup.
- Find targets with `emulator_ui_tree`, then `emulator_tap` by `text`, `description`, or `resourceId`. Use coordinates only when the tree has no usable element. Set `durationMs` on `emulator_tap` for a long press.
- Use `emulator_wait_for` after an action that changes the screen. Give it a `text`, `description`, or `resourceId` selector; it waits up to 10 seconds by default for the target to appear, or use `state: "disappears"` for transient UI to go away. `timeoutMs` accepts whole milliseconds from 1 through 30000.
- Use `emulator_scroll_to` for an off-screen named element, optionally with `tap: true`. It stops after five swipes by default (ten maximum), on ambiguity, or when the viewport stops changing. Directions describe the finger movement. For nested scroll containers, use explicit `emulator_swipe` coordinates.
- Use `emulator_type` for Unicode text, including emoji. Supply `target` to focus a named editable field and `replace: true` to select all first. It uses the device clipboard and reports whether the UI confirms the result. Never automatically retry an unverified entry; inspect it first. `submit: true` presses Enter only after verification; password/opaque fields need a separate explicit key action after inspection.
- Use `emulator_app` to restart or force-stop a named package, or grant/revoke one named runtime permission. It does not clear data.
- Use `emulator_screenshot` to confirm visual results, layout, and anything the accessibility tree cannot show. Ordinary screenshots are temporary. Set `save: true` when the user wants a reusable capture for clipboard or chat sharing; the result includes its capture ID and local file path.
- Install builds with `emulator_install` using absolute APK paths, then launch with `emulator_open`. For a shell-based Gradle install, target this chat's serial explicitly: `ANDROID_SERIAL=<serial> ./gradlew :app:installDebug`.
- Use `emulator_settings` for dark mode and font scale on any device. Location, battery, rotation, fold posture (`posture: "folded"`, `"half-folded"`, or `"unfolded"`), and snapshots require an emulator. `emulator_status.foldable` lists the supported postures and current reading; posture controls require a foldable AVD with hinge support. Use `emulator_adb` for logcat, package management, and other device-scoped commands.
- Use `emulator_record` to capture a flow as MP4 when the user wants a video. Stop returns a saved capture ID and local file path. Use `emulator_capture` with `action: "copy"` and that ID to copy the PNG image or MP4 file to the macOS clipboard; `action: "list"` recovers this chat’s latest 20 captures. `action: "context"` returns the screenshot or up to four timestamped video samples (requires FFmpeg). Treat those frames as samples, not evidence of every event in the video; inspect the saved MP4 when motion or intervening events matter. These tools return media to the agent; embed saved captures in replies with their local file path.
- Use `emulator_snapshot` to save or restore device state around risky steps.
- The user sees each tap, swipe, key, and text-entry action in the panel, and may interact at the same time. Re-read the UI tree before acting if the screen may have changed.
- The user can drag APKs onto the device panel to install them.

## Remember app navigation

- Use the ordinary emulator tools. Opening or observing an app and performing supported taps, directional swipes, and Back actions prepares its screen map and learns verified transitions automatically. Do not ask the user to initialize Minimap, type a package, install its CLI, or name screens. The plugin prepares missing navigation tools locally on first use.
- Use `emulator_navigate` with `action: "status"` for saved screens/routes and learning diagnostics without reading the device, or `whereami` for a fresh location. Use `go` with a saved place ID/slug and `expect` selectors to verify a specific destination.
- Name screens as part of your normal inspection. When a navigation result has `currentPlace.needsLabel: true`, use the fresh screenshot and UI elements to call `emulator_navigate` with `action: "whereami"` and a short descriptive `label` before navigating away. For example, use `Settings`, `Sign in`, or `Search results`. If you have not inspected the current screen, call `emulator_observe` first. If the screen changed or the evidence is unclear, inspect again instead of guessing from the tap target. Never ask the user to name screens.
- Existing `Screen N` names are provisional; replace them when revisiting the screen. Relabeling preserves its ID and learned routes. Keep useful existing names, and omit personal data, account or record names, and entered text. If the result is `label_mismatch`, inspect the screen and choose a distinct descriptive name; do not merge it with another screen. Check the returned `currentPlace` and status to confirm the name was applied.
- New maps live in the plugin's local state, separated by project and app. Existing matching project maps are reused. The host binds the project and chat-owned device; tool arguments cannot override paths or serials. No graph changes are committed automatically.
- Read `structuredContent.navigation` on ordinary actions when present. A successful tool call does not establish successful navigation. Unknown, blocked, mismatched, or failed results require fresh inspection; never repeat an action just because its reply or verification failed. A dependency setup failure can leave basic device controls available and is reported by navigation status.
- Long presses, text entry, custom swipes, raw ADB, and manual panel input remain direct controls; they are not recorded as replayable routes. Back transitions require verified history and are marked Manual Back. Known layouts do not establish which account or record is displayed; verify expected selectors and fresh UI evidence.
- The Screen map drawer shows saved screens/routes and the last located screen. Use `cancel` before overriding navigation. Cancellation does not undo completed actions. Use `doctor` for saved-map diagnostics.

## Diagnose failures

- Call `emulator_diagnostics` when the panel, stream, or emulator tools fail, before restarting anything. It returns a readable report and structured fields with stable codes. It works without a running helper and does not start, restart, or stop the helper, emulator, or stream.
- Check `findings` and their `nextStep`, plugin/helper version differences, and this chat's `device` and `display`. A device from `saved_state` may be stale; process liveness does not establish ADB connectivity or completed Android boot. Zero viewers can be normal for a hidden panel. A video session does not prove the user received a frame.
- Cursor host events are not collected (`host.status` is `unsupported`). The inline panel can fail to render while Android and the agent tools still work; restarting Android does not repair it. Offer the browser URL from `emulator_panel` instead.
- Share the diagnostic report and error codes when needed. Do not copy raw logs, panel URLs, access keys, screenshots, or device content into a support report. Never replay an action whose result was lost without first inspecting the device.

## Finish

- Leave the emulator running while the user may still need it. When they are done, call `emulator_stop`; add `deleteDevice: true` to also delete an AVD this chat created.
- `emulator_stop` on a physical device only releases the pin and plugin connections; it does not shut down or erase the phone. Physical pins persist while disconnected or idle until explicitly released or the window is closed.
- Closing the Cursor window stops its emulators about 10 minutes later, releases connected-device pins, and deletes AVDs it created unless they were kept. An emulator nobody is watching or using is also stopped after an idle period.
