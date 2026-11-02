# libs/

Baritone does not publish to a Maven repository, so its jar lives here (git-ignored, LGPL-3.0).

    ./gradlew downloadBaritone              # fetches baritone-api-fabric-<baritone_version>.jar from GitHub releases

or download it manually from
https://github.com/cabaletta/baritone/releases (tag `v1.11.3` = Minecraft 1.21 / 1.21.1) and drop it here:

    libs/baritone-api-fabric-1.11.3.jar

That one jar is the complete Baritone mod with its API left unobfuscated. It is the compile target,
the Baritone that `./gradlew runClient` loads, and the jar players put in `mods/`. Do not use the
`baritone-standalone-fabric` jar: it obfuscates the API too, so miyoria-bridge cannot drive it.

Without the jar, `./gradlew test` still works (against the compile-only stub in `src/baritoneStub/java`),
but `jar` / `build` / `runClient` fail with these instructions.
