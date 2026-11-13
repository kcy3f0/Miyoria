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

    /** Horizontal yaw pointing toward offset (dx, dz). */
    public static float yawToward(double dx, double dz) {
        return wrapDegrees((float) Math.toDegrees(Math.atan2(-dx, dz)));
    }

    /** Horizontal yaw pointing directly away from threat offset (dxToThreat, dzToThreat). */
    public static float awayYaw(double dxToThreat, double dzToThreat) {
        return yawToward(-dxToThreat, -dzToThreat);
    }

    /** Signed shortest angular difference from {@code fromDeg} to {@code toDeg} in (-180, 180]. */
    public static float angleDiff(float fromDeg, float toDeg) {
        return wrapDegrees(toDeg - fromDeg);
    }

    /** Yaw perpendicular to {@code facingYaw} for combat strafing ({@code right=true} strafes right). */
    public static float strafeYaw(float facingYaw, boolean right) {
        return wrapDegrees(facingYaw + (right ? 90f : -90f));
    }

    /**
     * Low-arc ballistic pitch in Minecraft conventions (-90 up, +90 down) for a projectile launched
     * with initial {@code speed} (blocks/tick) under downward {@code gravity} (blocks/tick^2).
     */
    public static float ballisticPitch(double dx, double dy, double dz, double speed, double gravity) {
        double horiz = Math.hypot(dx, dz);
        if (horiz < 1e-6 || speed <= 0.0 || !Double.isFinite(speed) || !Double.isFinite(gravity) || gravity <= 1e-9) {
            return toward(dx, dy, dz).pitch();
        }
        double v2 = speed * speed;
        double v4 = v2 * v2;
        double disc = v4 - gravity * (gravity * horiz * horiz + 2.0 * dy * v2);
        double tanTheta = disc >= 0.0
                ? (v2 - Math.sqrt(disc)) / (gravity * horiz)
                : v2 / (gravity * horiz);
        return clampPitch((float) -Math.toDegrees(Math.atan(tanTheta)));
    }

    /** Full yaw/pitch ballistic solution toward a stationary offset (dx, dy, dz). */
    public static Rotation ballisticAim(double dx, double dy, double dz, double speed, double gravity) {
        return new Rotation(yawToward(dx, dz), ballisticPitch(dx, dy, dz, speed, gravity));
    }

    /** Ballistic yaw/pitch leading a moving target with velocity (vx, vy, vz) in blocks/tick. */
    public static Rotation ballisticAimWithLead(double dx, double dy, double dz,
                                                double vx, double vy, double vz,
                                                double speed, double gravity) {
        if (speed <= 0.0 || !Double.isFinite(speed)) {
            return toward(dx, dy, dz);
        }
        double t = 0.0;
        for (int i = 0; i < 3; i++) {
            double px = dx + vx * t;
            double py = dy + vy * t;
            double pz = dz + vz * t;
            t = Math.sqrt(px * px + py * py + pz * pz) / speed;
        }
        return ballisticAim(dx + vx * t, dy + vy * t, dz + vz * t, speed, gravity);
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

    /** Smoothly step both yaw and pitch toward {@code target}. */
    public static Rotation approachRotation(Rotation current, Rotation target, float maxStep) {
        float yaw = wrapDegrees(approachAngle(current.yaw(), target.yaw(), maxStep));
        float pitch = clampPitch(approachAngle(current.pitch(), target.pitch(), maxStep));
        return new Rotation(yaw, pitch);
    }
}
