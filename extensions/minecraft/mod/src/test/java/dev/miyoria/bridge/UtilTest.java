package dev.miyoria.bridge;

import dev.miyoria.bridge.config.BridgeConfig;
import dev.miyoria.bridge.util.Ids;
import dev.miyoria.bridge.util.ImageUtil;
import dev.miyoria.bridge.util.LookMath;
import dev.miyoria.bridge.util.NotableBlocks;
import dev.miyoria.bridge.util.TimeOfDay;
import dev.miyoria.bridge.util.Visibility;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class UtilTest {

    @Test
    void idsNormalizeAndQualify() {
        assertEquals("iron_ore", Ids.normalize("minecraft:iron_ore"));
        assertEquals("modid:thing", Ids.normalize("modid:thing"));
        assertEquals("minecraft:stone", Ids.qualify("stone"));
        assertEquals("modid:thing", Ids.qualify("modid:thing"));
        assertNull(Ids.normalize(null));
    }

    @Test
    void timeOfDayPhases() {
        assertEquals("day", TimeOfDay.phase(0));
        assertEquals("day", TimeOfDay.phase(11999));
        assertEquals("dusk", TimeOfDay.phase(12000));
        assertEquals("night", TimeOfDay.phase(13000));
        assertEquals("night", TimeOfDay.phase(22999));
        assertEquals("dawn", TimeOfDay.phase(23000));
        assertEquals("night", TimeOfDay.phase(24000 * 10 + 15000));
        assertEquals(500, TimeOfDay.wrap(24500));
        assertTrue(TimeOfDay.isNight(18000));
        assertFalse(TimeOfDay.isNight(6000));
    }

    @Test
    void notableBlocks() {
        assertTrue(NotableBlocks.isNotable("iron_ore"));
        assertTrue(NotableBlocks.isNotable("deepslate_diamond_ore"));
        assertTrue(NotableBlocks.isNotable("ancient_debris"));
        assertTrue(NotableBlocks.isNotable("chest"));
        assertTrue(NotableBlocks.isNotable("red_bed"));
        assertTrue(NotableBlocks.isNotable("blue_shulker_box"));
        assertTrue(NotableBlocks.isNotable("oak_log"));
        assertTrue(NotableBlocks.isNotable("stone"));
        assertFalse(NotableBlocks.isNotable("dirt"));
        assertFalse(NotableBlocks.isNotable("oak_leaves"));
        assertFalse(NotableBlocks.isNotable(null));
        assertTrue(NotableBlocks.priority("diamond_ore") < NotableBlocks.priority("iron_ore"));
        assertTrue(NotableBlocks.priority("iron_ore") < NotableBlocks.priority("crafting_table"));
        assertTrue(NotableBlocks.priority("oak_log") < NotableBlocks.priority("stone"));
    }

    /** A tiny voxel world: opaque blocks listed as "x,y,z". */
    private static Visibility.Opaque world(String... blocks) {
        Set<String> solid = new HashSet<>(List.of(blocks));
        return (x, y, z) -> solid.contains(x + "," + y + "," + z);
    }

    @Test
    void visibilityNeedsAnOpenFaceAndAClearLine() {
        // eye at (0.5, 1.6, 0.5); target block at (5, 1, 0)
        assertTrue(Visibility.visible(0.5, 1.6, 0.5, 5, 1, 0, world("5,1,0")));
        // buried: every neighbour is stone, so no face is open (an ore inside a wall)
        Visibility.Opaque buried = world("5,1,0", "4,1,0", "6,1,0", "5,0,0", "5,2,0", "5,1,1", "5,1,-1");
        assertFalse(Visibility.exposed(5, 1, 0, buried));
        assertFalse(Visibility.visible(0.5, 1.6, 0.5, 5, 1, 0, buried));
        // open only on the far side (+x): exposed, but not from here
        Visibility.Opaque farSide = world("5,1,0", "4,1,0", "5,0,0", "5,2,0", "5,1,1", "5,1,-1");
        assertTrue(Visibility.exposed(5, 1, 0, farSide));
        assertFalse(Visibility.visible(0.5, 1.6, 0.5, 5, 1, 0, farSide));
        // a wall between the eye and the block hides it ...
        Visibility.Opaque wall = world("5,1,0", "3,1,0", "3,2,0", "3,0,0", "3,1,1", "3,1,-1", "3,2,1", "3,2,-1",
                "3,0,1", "3,0,-1", "5,2,0", "5,0,0", "5,1,1", "5,1,-1");
        assertFalse(Visibility.visible(0.5, 1.6, 0.5, 5, 1, 0, wall));
        // ... unless there is a gap in it on the line of sight
        Visibility.Opaque gap = world("5,1,0", "3,2,0", "3,0,0", "3,1,1", "3,1,-1", "5,2,0", "5,0,0", "5,1,1", "5,1,-1");
        assertTrue(Visibility.visible(0.5, 1.6, 0.5, 5, 1, 0, gap));
        // the eye's own voxel never blocks (camera inside a block)
        assertTrue(Visibility.visible(0.5, 1.6, 0.5, 5, 1, 0, world("5,1,0", "0,1,0")));
    }

    @Test
    void lookMath() {
        // Minecraft: yaw 0 looks toward +Z, yaw -90 toward +X, yaw 90 toward -X, yaw 180/-180 toward -Z
        assertEquals(0f, LookMath.toward(0, 0, 5).yaw(), 1e-4);
        assertEquals(-90f, LookMath.toward(5, 0, 0).yaw(), 1e-4);
        assertEquals(90f, LookMath.toward(-5, 0, 0).yaw(), 1e-4);
        assertEquals(180f, Math.abs(LookMath.toward(0, 0, -5).yaw()), 1e-4);
        // pitch: negative = up
        assertEquals(-45f, LookMath.toward(0, 5, 5).pitch(), 1e-4);
        assertEquals(45f, LookMath.toward(0, -5, 5).pitch(), 1e-4);
        assertEquals(-90f, LookMath.toward(0, 5, 0).pitch(), 1e-4);

        assertEquals(-170f, LookMath.wrapDegrees(190f), 1e-4);
        assertEquals(170f, LookMath.wrapDegrees(-190f), 1e-4);
        assertEquals(180f, LookMath.wrapDegrees(-180f), 1e-4);
        assertEquals(-90f, LookMath.clampPitch(-123f));

        // takes the short way around the circle
        assertEquals(-170f, LookMath.wrapDegrees(LookMath.approachAngle(170f, -170f, 100f)), 1e-4); // reaches target (mod 360)
        assertEquals(180f, LookMath.approachAngle(170f, -170f, 10f), 1e-4);
        assertEquals(5f, LookMath.approachAngle(0f, 90f, 5f), 1e-4);
        assertEquals(-5f, LookMath.approachAngle(0f, -90f, 5f), 1e-4);
        assertEquals(30f, LookMath.approachAngle(30f, 30f, 5f), 1e-4);
    }

    @Test
    void configCreatedWithRandomTokenAndReloaded(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("conf").resolve(BridgeConfig.FILE_NAME);
        BridgeConfig a = BridgeConfig.load(file);
        assertTrue(Files.isRegularFile(file));
        assertEquals(7890, a.port);
        assertTrue(a.token.length() >= 16);

        BridgeConfig b = BridgeConfig.load(file);
        assertEquals(a.token, b.token, "token must be stable across loads");

        assertNotEquals(BridgeConfig.generateToken(), BridgeConfig.generateToken());
    }

    @Test
    void configRepairsBadValues(@TempDir Path dir) throws Exception {
        Path file = dir.resolve(BridgeConfig.FILE_NAME);
        Files.writeString(file, "{\"port\": 80, \"token\": \"short\", \"entityRadius\": 9999}");
        BridgeConfig c = BridgeConfig.load(file);
        assertEquals(7890, c.port);
        assertTrue(c.token.length() >= 16);
        assertEquals(64, c.entityRadius);
        // persisted
        assertEquals(c.token, BridgeConfig.load(file).token);
    }

    @Test
    void configSurvivesCorruptFile(@TempDir Path dir) throws Exception {
        Path file = dir.resolve(BridgeConfig.FILE_NAME);
        Files.writeString(file, "{ this is not json");
        BridgeConfig c = BridgeConfig.load(file);
        assertTrue(c.token.length() >= 16);
        assertTrue(Files.exists(dir.resolve(BridgeConfig.FILE_NAME + ".broken")));
    }

    @Test
    void imageDownscaleAndEncode() throws Exception {
        int w = 1920, h = 1080;
        int[] px = new int[w * h];
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) px[y * w + x] = 0xFF000000 | ((x * 255 / w) << 16) | ((y * 255 / h) << 8) | 0x40;
        BufferedImage src = ImageUtil.fromArgb(px, w, h);

        BufferedImage small = ImageUtil.downscale(src, 640);
        assertEquals(640, small.getWidth());
        assertEquals(360, small.getHeight());
        assertSame(src, ImageUtil.downscale(src, 4000), "never upscales");

        byte[] png = ImageUtil.encodePng(small);
        BufferedImage back = ImageIO.read(new ByteArrayInputStream(png));
        assertEquals(640, back.getWidth());
        assertEquals(0x89504E47, ((png[0] & 0xFF) << 24) | ((png[1] & 0xFF) << 16) | ((png[2] & 0xFF) << 8) | (png[3] & 0xFF));

        byte[] jpg = ImageUtil.encodeJpeg(small, 0.7f);
        assertEquals((byte) 0xFF, jpg[0]);
        assertEquals((byte) 0xD8, jpg[1]);
        assertNotNull(ImageIO.read(new ByteArrayInputStream(jpg)));

        assertArrayEquals(png, Base64.getDecoder().decode(ImageUtil.base64(png)));
    }
}
