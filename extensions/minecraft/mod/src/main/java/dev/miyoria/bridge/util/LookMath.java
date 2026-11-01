package dev.miyoria.bridge.util;

/** Rotation math in Minecraft conventions (yaw 0 = +Z/south, 90 = -X/west; pitch -90 up, +90 down). */
public final class LookMath {
    private LookMath() {}

    public record Rotation(float yaw, float pitch) {}

    /** Yaw/pitch that point from an eye position toward a target offset (dx, dy, dz). */
    public static Rotation toward(double dx, double dy, double dz) {
        double horiz = Math.sqrt(dx * dx + dz * dz);
        float yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
        float pitch = (float) -Math.toDegrees(Math.atan2(dy, horiz));
        return new Rotation(wrapDegrees(yaw), clampPitch(pitch));
    }

    /** Wrap to (-180, 180]. */
    public static float wrapDegrees(float deg) {
        float d = deg % 360f;
        if (d > 180f) d -= 360f;
        if (d <= -180f) d += 360f;
        return d;
    }

    public static float clampPitch(float pitch) {
        return Math.max(-90f, Math.min(90f, pitch));
    }

    /** Move {@code current} toward {@code target} by at most {@code maxStep} degrees along the short arc. */
    public static float approachAngle(float current, float target, float maxStep) {
        float diff = wrapDegrees(target - current);
        if (Math.abs(diff) <= maxStep) return current + diff;
        return current + Math.signum(diff) * maxStep;
    }
}
