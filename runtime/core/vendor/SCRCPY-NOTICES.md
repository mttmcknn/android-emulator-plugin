# Attribution for code inside scrcpy-server-v5.0.1

This inventory retains notices from the official scrcpy tag and the source
artifacts of components identified in its compiled server. It is informational
and does not alter any license. Full license texts and exact source links are
provided in [SCRCPY-SOURCE.md](SCRCPY-SOURCE.md).

## scrcpy

Copyright (C) 2018 Genymobile

Copyright (C) 2018-2026 Romain Vimont

Apache-2.0; see [SCRCPY-LICENSE](SCRCPY-LICENSE).

## Kotlin standard library 2.2.10

The published standard-library sources contain these copyright notices across
their files. They are retained here as written, including the individual years:

Copyright 2010-2018 JetBrains s.r.o. and Kotlin Programming Language contributors.

Copyright 2010-2019 JetBrains s.r.o. and Kotlin Programming Language contributors.

Copyright 2010-2020 JetBrains s.r.o. and Kotlin Programming Language contributors.

Copyright 2010-2021 JetBrains s.r.o. and Kotlin Programming Language contributors.

Copyright 2010-2022 JetBrains s.r.o. and Kotlin Programming Language contributors.

Copyright 2010-2023 JetBrains s.r.o. and Kotlin Programming Language contributors.

Copyright 2010-2024 JetBrains s.r.o. and Kotlin Programming Language contributors.

Copyright 2010-2025 JetBrains s.r.o. and Kotlin Programming Language contributors.

Copyright 2010-2015 JetBrains s.r.o.

Copyright 2010-2016 JetBrains s.r.o.

Copyright 2010-2017 JetBrains s.r.o.

Copyright 2010-2018 JetBrains s.r.o.

Apache-2.0 except the inherited portions described below; see
[KOTLIN-LICENSE](KOTLIN-LICENSE).

### GWT derived collections

Based on GWT AbstractList and AbstractMap.

Copyright 2007 Google Inc.

Apache-2.0; see [KOTLIN-LICENSE](KOTLIN-LICENSE). Kotlin's tagged inventory
describes the GWT origin as "(C) 2007-08 Google Inc."; the two included source
headers above use 2007.

### Guava derived unsigned arithmetic

Division and remainder are based on Guava's UnsignedLongs implementation.

Copyright 2011 The Guava Authors

Apache-2.0; see [KOTLIN-LICENSE](KOTLIN-LICENSE).

### Boost derived inverse hyperbolic functions

Inverse hyperbolic function implementations derived from boost special math functions.

Copyright Eric Ford & Hubert Holin 2001.

Boost Software License 1.0; see [KOTLIN-BOOST-LICENSE](KOTLIN-BOOST-LICENSE).

### ThreeTenBP derived time code

Based on the ThreeTenBp project.

Copyright (c) 2007-present, Stephen Colebourne & Michael Nascimento Santos

BSD-3-Clause; the copyright, conditions and disclaimer are reproduced in full in
[KOTLIN-THREETENBP-LICENSE](KOTLIN-THREETENBP-LICENSE).

## JetBrains annotations 13.0

The published annotations source files contain the following notices:

Copyright 2000-2009 JetBrains s.r.o.

Copyright 2000-2012 JetBrains s.r.o.

Copyright 2000-2013 JetBrains s.r.o.

Copyright 2006 Sascha Weinreuter

Apache-2.0; see [KOTLIN-LICENSE](KOTLIN-LICENSE).

## Android interface sources

`IOnPrimaryClipChangedListener.aidl`:

Copyright (c) 2008, The Android Open Source Project

`IDisplayWindowListener.aidl`:

Copyright (C) 2019 The Android Open Source Project

These sources and their generated classes are licensed under Apache-2.0; see
[KOTLIN-LICENSE](KOTLIN-LICENSE). `IContentProvider.java` is scrcpy's empty fake
interface used to expose a hidden Android type, with no additional notice in the
tagged file.

### Android display constants

scrcpy also reproduces display constants in its own classes. Attribution is
retained from the corresponding platform source headers:

`DisplayManager.java` (virtual-display flags in scrcpy's `NewDisplayCapture`):

Copyright (C) 2012 The Android Open Source Project

Source: https://github.com/aosp-mirror/platform_frameworks_base/blob/android-16.0.0_r1/core/java/android/hardware/display/DisplayManager.java

`SurfaceControl.java` (display power modes in scrcpy's `SurfaceControl` wrapper):

Copyright (C) 2013 The Android Open Source Project

Source cited by scrcpy: https://github.com/aosp-mirror/platform_frameworks_base/blob/pie-release-2/core/java/android/view/SurfaceControl.java

`WindowManager.java` (display IME policies in scrcpy's `WindowManager` wrapper):

Copyright (C) 2006 The Android Open Source Project

Source cited by scrcpy: https://github.com/aosp-mirror/platform_frameworks_base/blob/2103ff441c66772c80c8560e322dcd9a45be7dcd/core/java/android/view/WindowManager.java

Apache-2.0; see [KOTLIN-LICENSE](KOTLIN-LICENSE). These constants are inside
scrcpy classes; the full platform implementations are supplied by Android and
are not included in the server.
