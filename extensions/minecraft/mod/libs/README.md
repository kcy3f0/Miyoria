# libs/

Baritone does not publish to a Maven repository, so the compile-time API jar lives here (git-ignored, LGPL-3.0).

    ./gradlew downloadBaritone              # fetches baritone-api-fabric-<baritone_version>.jar from GitHub releases

or download it manually from
https://github.com/cabaletta/baritone/releases (tag `v1.11.3` = Minecraft 1.21 / 1.21.1) and drop it here:

    libs/baritone-api-fabric-1.11.3.jar

Optional, only for `./gradlew runClient` (dev game with Baritone installed):

    ./gradlew downloadBaritoneStandalone    # baritone-standalone-fabric-<baritone_version>.jar

Without the API jar, `./gradlew test` still works (against the compile-only stub in `src/baritoneStub/java`),
but `jar` / `build` / `runClient` fail with these instructions.
