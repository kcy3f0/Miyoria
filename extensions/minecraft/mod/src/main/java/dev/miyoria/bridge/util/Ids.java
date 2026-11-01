package dev.miyoria.bridge.util;

/** Identifier helpers. The protocol drops the "minecraft:" namespace to keep payloads short. */
public final class Ids {
    private Ids() {}

    /** "minecraft:iron_ore" -> "iron_ore"; other namespaces are kept ("modid:thing"). */
    public static String normalize(String id) {
        if (id == null) return null;
        return id.startsWith("minecraft:") ? id.substring("minecraft:".length()) : id;
    }

    /** "iron_ore" -> "minecraft:iron_ore" (ids that already have a namespace are untouched). */
    public static String qualify(String id) {
        return id.indexOf(':') >= 0 ? id : "minecraft:" + id;
    }
}
