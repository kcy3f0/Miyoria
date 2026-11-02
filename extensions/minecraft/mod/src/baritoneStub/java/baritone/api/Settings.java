// COMPILE-ONLY STUB -- NOT THE REAL BARITONE.
// Only used when libs/baritone-api-fabric-*.jar is missing, so that the unit tests can still compile and run.
// Never packaged into the mod. Signatures mirror Baritone 1.11.3 (Minecraft 1.21.1) for the members miyoria-bridge uses.
// Fix: ./gradlew downloadBaritone
package baritone.api;

public final class Settings {
    public final Setting<Boolean> legitMine = new Setting<>(false);
    public final Setting<Boolean> freeLook = new Setting<>(true);
    public final Setting<Boolean> smoothLook = new Setting<>(false);
    public final Setting<Integer> smoothLookTicks = new Setting<>(5);
    public final Setting<Boolean> renderPath = new Setting<>(true);
    public final Setting<Boolean> renderGoal = new Setting<>(true);
    public final Setting<Boolean> renderSelectionBoxes = new Setting<>(true);

    public final class Setting<T> {
        public T value;
        public final T defaultValue;

        Setting(T value) {
            this.value = value;
            this.defaultValue = value;
        }
    }
}
