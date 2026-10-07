---
name: emulator
description: Use this chat's Android emulator to run, inspect, and test Android apps. Use when the user asks to start, create, or use an emulator; diagnose a panel or connection failure; install or launch an APK; verify Android UI behavior; or check dark mode, font scale, rotation, location, or battery.
---

# Android Emulators

Each Codex chat owns at most one emulator. The `emulator` MCP tools identify the calling chat automatically and only act on that chat's emulator, so parallel chats never share a device.

## Start and show the emulator

1. Call `emulator_status`. If the user named an existing AVD, pass it to `emulator_start`; otherwise let `emulator_start` choose one that is not already running.
   Without a name, `emulator_start` uses the user's default device setting.
2. If no AVD exists or none matches the requested device, call `emulator_create` with a profile such as `pixel_9` or `pixel_tablet`. It uses the newest suitable installed system image and starts the device. Leave `keep` false unless the user wants the device after this chat.
3. Call `emulator_panel` if the device panel is not already open or the user asks to show it. Reuse that panel throughout testing; starting, installing, and inspecting do not require opening it again.
4. Tell the user which AVD and serial the chat owns, and whether it is read-only (state is discarded on stop).

## Operate the device

- Use only the `emulator_*` tools for this device. Do not run `adb`, `emulator`, or Gradle device tasks against another serial, and never stop an emulator this chat does not own.
- Start with `emulator_observe` for a screenshot, UI elements, and foreground app in one call. Reads run concurrently; check partial errors and remember a changing screen may differ between reads. Use `emulator_ui_tree` for lighter target lookup.
- Find targets with `emulator_ui_tree`, then `emulator_tap` by `text`, `description`, or `resourceId`. Use coordinates only when the tree has no usable element. Set `durationMs` on `emulator_tap` for a long press.
- Use `emulator_wait_for` after an action that changes the screen. Give it a `text`, `description`, or `resourceId` selector; it waits up to 10 seconds by default for the target to appear, or use `state: "disappears"` for transient UI to go away. `timeoutMs` accepts whole milliseconds from 1 through 30000.
- Use `emulator_scroll_to` for an off-screen named element, optionally with `tap: true`. It stops after five swipes by default (ten maximum), on ambiguity, or when the viewport stops changing. Directions describe the finger movement. For nested scroll containers, use explicit `emulator_swipe` coordinates.
- Use `emulator_type` for Unicode text, including emoji. Supply `target` to focus a named editable field and `replace: true` to select all first. It uses the device clipboard and reports whether the UI confirms the result. Never automatically retry an unverified entry; inspect it first. `submit: true` presses Enter only after verification; password/opaque fields need a separate explicit key action after inspection.
- Use `emulator_app` to restart or force-stop a named package, or grant/revoke one named runtime permission. It does not clear data.
- Use `emulator_screenshot` to confirm visual results, layout, and anything the accessibility tree cannot show. Ordinary screenshots are temporary. Set `save: true` when the user wants a reusable capture for clipboard or chat sharing; the result includes its capture ID and local file path.
- Install builds with `emulator_install` using absolute APK paths, then launch with `emulator_open`. For a shell-based Gradle install, target this chat's serial explicitly: `ANDROID_SERIAL=<serial> ./gradlew :app:installDebug`.
- Use `emulator_settings` for dark mode, font scale, location, battery, rotation, and fold posture (`posture: "folded"`, `"half-folded"`, or `"unfolded"`). `emulator_status.foldable` lists the supported postures and the current reading; posture controls require a foldable AVD with hinge support. Use `emulator_adb` for logcat, package management, and other device-scoped commands.
- Use `emulator_record` to capture a flow as MP4 when the user wants a video. Stop returns a saved capture ID and local file path. Use `emulator_capture` with `action: "copy"` and that ID to copy the PNG image or MP4 file to the macOS clipboard; `action: "list"` recovers this chat’s latest 20 captures. `action: "context"` returns the screenshot or up to four timestamped video samples (requires FFmpeg). Treat those frames as samples, not evidence of every event in the video; inspect the saved MP4 when motion or intervening events matter. These tools return media to the agent; the panel’s **Add to chat** action adds media to the user’s next message.
- Use `emulator_snapshot` to save or restore device state around risky steps.
- The user sees each tap, swipe, key, and text-entry action in the panel, and may interact at the same time. Re-read the UI tree before acting if the screen may have changed.
- The user can attach the current screen to their message, @-mention devices or installed apps, drag APKs onto the device, and open `.apk` files in a viewer that installs them. Check the capture timestamp before treating an attached screen as current.

## Remember app navigation

- Use the ordinary emulator tools. Opening or observing an app and performing supported taps, directional swipes, and Back actions prepares its screen map and learns verified transitions automatically. Do not ask the user to initialize Minimap, type a package, install its CLI, or name screens. The plugin prepares missing navigation tools locally on first use.
- Use `emulator_navigate` with `action: "status"` for saved screens/routes and learning diagnostics without reading the device, or `whereami` for a fresh location. Use `go` with a saved place ID/slug and `expect` selectors to verify a specific destination. Optional labels can give an already inspected screen a meaningful name; users never need to manage them.
- New maps live in the plugin's local state, separated by project and app. Existing matching project maps are reused. The host binds the project and chat-owned device; tool arguments cannot override paths or serials. No graph changes are committed automatically.
- Read `structuredContent.navigation` on ordinary actions when present. A successful tool call does not establish successful navigation. Unknown, blocked, mismatched, or failed results require fresh inspection; never repeat an action just because its reply or verification failed. A dependency setup failure can leave basic device controls available and is reported by navigation status.
- Long presses, text entry, custom swipes, raw ADB, and manual panel input remain direct controls; they are not recorded as replayable routes. Back transitions require verified history and are marked Manual Back. Known layouts do not establish which account or record is displayed; verify expected selectors and fresh UI evidence.
- The Screen map drawer shows saved screens/routes and the last located screen. Use `cancel` before overriding navigation. Cancellation does not undo completed actions. Use `doctor` for saved-map diagnostics.

## Diagnose failures

- Call `emulator_diagnostics` when the panel, stream, or emulator tools fail, before restarting anything. It returns a readable report and structured fields with stable codes. It works without a running helper and does not start, restart, or stop the helper, emulator, or stream.
- Check `findings` and their `nextStep`, plugin/helper version differences, and this chat's `device` and `display`. A device from `saved_state` may be stale; process liveness does not establish ADB connectivity or completed Android boot. Zero viewers can be normal for a hidden panel. A video session does not prove the user received a frame.
- Treat `host.events` as history. Only `scope: "this_chat"` is attributed to this chat; `host_unattributed` may concern another chat. No matching event in the bounded log tails does not prove the panel works. The native Codex error screen can fail while Android and agent tools still work; restarting Android does not repair Codex's renderer.
- Share the diagnostic report and error codes when needed. Do not copy raw logs, panel URLs, access keys, screenshots, or device content into a support report. Never replay an action whose result was lost without first inspecting the device.

## Finish

- Leave the emulator running while the user may still need it. When they are done, call `emulator_stop`; add `deleteDevice: true` to also delete an AVD this chat created.
- Archiving the chat stops its emulator and deletes AVDs it created unless they were kept. An emulator nobody is watching or using is also stopped after an idle period.
