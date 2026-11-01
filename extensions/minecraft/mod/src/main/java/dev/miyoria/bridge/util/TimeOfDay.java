package dev.miyoria.bridge.util;

/** Day-cycle helpers. A Minecraft day is 24000 ticks; 0 = sunrise-ish, 13000 = night starts. */
public final class TimeOfDay {
    private TimeOfDay() {}

    public static final long DAY_LENGTH = 24000L;
    public static final long NIGHT_START = 13000L;
    public static final long NIGHT_END = 23000L;

    public static long wrap(long ticks) {
        return Math.floorMod(ticks, DAY_LENGTH);
    }

    public static boolean isNight(long ticks) {
        long t = wrap(ticks);
        return t >= NIGHT_START && t < NIGHT_END;
    }

    /** "day" [0,12000), "dusk" [12000,13000), "night" [13000,23000), "dawn" [23000,24000). */
    public static String phase(long ticks) {
        long t = wrap(ticks);
        if (t < 12000) return "day";
        if (t < NIGHT_START) return "dusk";
        if (t < NIGHT_END) return "night";
        return "dawn";
    }
}
