# Bundled scrcpy server

`scrcpy-server-v5.0.1` is the unmodified Android server from the official
[scrcpy 5.0.1 release](https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1).
The scrcpy code is licensed under Apache-2.0; see
[SCRCPY-LICENSE](SCRCPY-LICENSE). The server binary also includes the components
listed below, which retain their own licenses and attribution.

- Asset: https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1
- SHA-256: `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536`
- Official checksum list: https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/SHA256SUMS.txt
- Checksum signature: https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/SHA256SUMS.txt.asc
- Tagged source: https://github.com/Genymobile/scrcpy/tree/v5.0.1
- Tag commit: `a60891aea193d92e7e5c3942700eca63f9d19a5f`
- APK embedded source revision: `dc8a55a24c27ae78ae202b5a3288da681d0f141a`

The checksum list's detached signature was verified locally using the public
key published at https://github.com/rom1v.gpg. The signing fingerprint is
`E39E2DE6A55F5AA6D8EFB79ACA01F46F18683B3D`, matching the verified release
tag's key ID `CA01F46F18683B3D`; its primary-key fingerprint is
`456958E85A185DD5C2D1E4E80C822B298461FA03`. This confirms the cryptographic
signature against that retrieved key; no Web-of-Trust certification is claimed.

The embedded source revision is one commit before the tag; the
[comparison](https://github.com/Genymobile/scrcpy/compare/dc8a55a24c27ae78ae202b5a3288da681d0f141a...v5.0.1)
changes only release download links and documentation. The server source is
identical. The v5.0 to v5.0.1 comparison changes the server's version identifiers,
without changing its control protocol or server behavior. The release's hardware
decoding and rendering fixes are in the desktop client.

The plugin uses this Android server with its own Node client and browser video
decoder. It does not include the desktop scrcpy client, FFmpeg, SDL, ADB or the
Android SDK. No native libraries occur in the server archive.

## Components inside the official server

Inspection of the official APK found one DEX containing 1,246 defined classes:
153 `com.genymobile.scrcpy` classes, 1,051 `kotlin` classes, 32 JetBrains/IntelliJ
annotation classes and 10 Android interface classes. References to platform APIs
are supplied by the user's Android installation rather than copied into this
archive. The APK also contains eight Kotlin builtins resources, Android manifest
and resource metadata, and Android Gradle plugin metadata reporting version 9.1.0.

| Component in the server | Evidence and authoritative source | License distributed here |
| --- | --- | --- |
| scrcpy 5.0.1 | [Tagged LICENSE](https://github.com/Genymobile/scrcpy/blob/v5.0.1/LICENSE); the tag has no `NOTICE` file | [SCRCPY-LICENSE](SCRCPY-LICENSE) (Apache-2.0) |
| Kotlin JVM standard library 2.2.10 | DEX `KotlinVersionCurrentValue.get()` constructs version `(2, 2, 10)`; eight builtins resources match the 2.2.10 JAR. [Published POM](https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-stdlib/2.2.10/kotlin-stdlib-2.2.10.pom), [source JAR](https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-stdlib/2.2.10/kotlin-stdlib-2.2.10-sources.jar), [tagged license inventory](https://github.com/JetBrains/kotlin/blob/v2.2.10/license/README.md) | [KOTLIN-LICENSE](KOTLIN-LICENSE) (Apache-2.0), plus the inherited portions below |
| GWT derived Kotlin collections | `kotlin.collections.AbstractList` and `AbstractMap` in DEX; corresponding Kotlin source headers and [tagged GWT license](https://github.com/JetBrains/kotlin/blob/v2.2.10/license/third_party/gwt_license.txt) | [KOTLIN-LICENSE](KOTLIN-LICENSE) (Apache-2.0; byte identical to the tagged GWT license) |
| Guava derived Kotlin unsigned arithmetic | `kotlin.UnsignedKt` in DEX; `jvmMain/kotlin/util/UnsignedJVM.kt` in source JAR and [tagged Guava license](https://github.com/JetBrains/kotlin/blob/v2.2.10/license/third_party/guava_license.txt) | [KOTLIN-LICENSE](KOTLIN-LICENSE) (Apache-2.0; byte identical to the tagged Guava license) |
| Boost derived Kotlin math functions | `kotlin.math.MathKt__MathJVMKt` in DEX; `jvmMain/kotlin/util/MathJVM.kt` in source JAR and [tagged Boost license](https://github.com/JetBrains/kotlin/blob/v2.2.10/license/third_party/boost_LICENSE.txt) | [KOTLIN-BOOST-LICENSE](KOTLIN-BOOST-LICENSE) (BSL-1.0) |
| ThreeTenBP derived Kotlin time code | `kotlin.time.Instant` in DEX; `commonMain/kotlin/time/Instant.kt` in source JAR and [tagged ThreeTenBP license](https://github.com/JetBrains/kotlin/blob/v2.2.10/license/third_party/threetenbp_license.txt) | [KOTLIN-THREETENBP-LICENSE](KOTLIN-THREETENBP-LICENSE) (BSD-3-Clause) |
| JetBrains annotations 13.0 | All 32 classes in the [published JAR](https://repo.maven.apache.org/maven2/org/jetbrains/annotations/13.0/annotations-13.0.jar) occur in DEX; Kotlin's published POM declares this version. [Annotations POM](https://repo.maven.apache.org/maven2/org/jetbrains/annotations/13.0/annotations-13.0.pom) and [source JAR](https://repo.maven.apache.org/maven2/org/jetbrains/annotations/13.0/annotations-13.0-sources.jar) | Apache-2.0; a full copy is provided in [KOTLIN-LICENSE](KOTLIN-LICENSE) |
| AOSP Android interfaces and generated AIDL classes | Tagged [IOnPrimaryClipChangedListener.aidl](https://github.com/Genymobile/scrcpy/blob/v5.0.1/server/src/main/aidl/android/content/IOnPrimaryClipChangedListener.aidl) and [IDisplayWindowListener.aidl](https://github.com/Genymobile/scrcpy/blob/v5.0.1/server/src/main/aidl/android/view/IDisplayWindowListener.aidl) headers explicitly license these files under Apache-2.0. [IContentProvider.java](https://github.com/Genymobile/scrcpy/blob/v5.0.1/server/src/main/java/android/content/IContentProvider.java) is scrcpy's empty interface exposing a hidden platform type. | Apache-2.0; a full copy is provided in [KOTLIN-LICENSE](KOTLIN-LICENSE) |
| AOSP display constants in scrcpy classes | [NewDisplayCapture.java](https://github.com/Genymobile/scrcpy/blob/v5.0.1/server/src/main/java/com/genymobile/scrcpy/video/NewDisplayCapture.java) identifies copied DisplayManager fields; [SurfaceControl.java](https://github.com/Genymobile/scrcpy/blob/v5.0.1/server/src/main/java/com/genymobile/scrcpy/wrappers/SurfaceControl.java) and [WindowManager.java](https://github.com/Genymobile/scrcpy/blob/v5.0.1/server/src/main/java/com/genymobile/scrcpy/wrappers/WindowManager.java) cite their platform constants' source. Those AOSP files' headers use Apache-2.0. | Apache-2.0; a full copy is provided in [KOTLIN-LICENSE](KOTLIN-LICENSE) |

Attribution retained from these sources is in [SCRCPY-NOTICES.md](SCRCPY-NOTICES.md).
The Kotlin compiler, Gradle, Android Gradle plugin and JUnit are build/test tools;
their executable distributions are not included. Kotlin's upstream `NOTICE.txt`
explicitly describes the compiler distribution, so it is not presented as a
standard-library notice here. The standard-library source and relevant inherited
copyright notices are retained instead.

## Reproducible license evidence

These copies were checked against the exact upstream tag on 2026-10-08:

| Local copy | SHA-256 |
| --- | --- |
| SCRCPY-LICENSE | `01c12035bf35af37241298dc7ad538eb2a07e5c940437bc6876feeaa9d1951d0` |
| KOTLIN-LICENSE | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| KOTLIN-BOOST-LICENSE | `8d8291caf1cee26d23acf3eb67c9f9a2d58f1c681b16a4fbe8cbfb9e3c0b5a9b` |
| KOTLIN-THREETENBP-LICENSE | `d1bc53b493a3ab387b42717ed5c4b1976a5048996f81154278100bff86d39331` |

Audited source JAR hashes (the JARs themselves are not distributed by this plugin):

- Kotlin stdlib 2.2.10 sources: `2983f21e626325f256bc4443c7fe45a83912bba077be119142f68210c0548173`
- JetBrains annotations 13.0 sources: `42a5e144b8e81d50d6913d1007b695e62e614705268d8cf9f13dbdc478c2c68e`

Apache-2.0 allows object redistribution with the license and relevant notices;
it does not impose a corresponding-source offer. BSD-3-Clause requires its
copyright, conditions and disclaimer in materials accompanying binary copies.
Boost permits redistribution and has an exception to its notice condition for
solely machine-executable object code; its full text is included here regardless.
These statements describe the audited terms and are not a legal guarantee.
