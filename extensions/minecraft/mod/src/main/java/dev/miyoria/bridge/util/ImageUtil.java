package dev.miyoria.bridge.util;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Base64;

/** Pixel buffer -> downscaled PNG/JPEG -> base64. Pure Java (java.desktop only), no Minecraft types. */
public final class ImageUtil {
    private ImageUtil() {}

    /** @param argb row-major 0xAARRGGBB pixels (alpha ignored) */
    public static BufferedImage fromArgb(int[] argb, int width, int height) {
        BufferedImage img = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        img.setRGB(0, 0, width, height, argb, 0, width);
        return img;
    }

    /** Scale down to {@code maxWidth} (never up), keeping aspect ratio. Progressive halving for quality. */
    public static BufferedImage downscale(BufferedImage src, int maxWidth) {
        if (src.getWidth() <= maxWidth) return src;
        int targetW = maxWidth;
        int targetH = Math.max(1, (int) Math.round(src.getHeight() * (maxWidth / (double) src.getWidth())));
        BufferedImage cur = src;
        while (cur.getWidth() / 2 >= targetW) {
            cur = resize(cur, cur.getWidth() / 2, Math.max(1, cur.getHeight() / 2));
        }
        if (cur.getWidth() != targetW || cur.getHeight() != targetH) {
            cur = resize(cur, targetW, targetH);
        }
        return cur;
    }

    private static BufferedImage resize(BufferedImage src, int w, int h) {
        BufferedImage dst = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        var g = dst.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            g.drawImage(src, 0, 0, w, h, null);
        } finally {
            g.dispose();
        }
        return dst;
    }

    public static byte[] encodePng(BufferedImage img) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
        if (!ImageIO.write(img, "png", out)) throw new IOException("no PNG writer");
        return out.toByteArray();
    }

    public static byte[] encodeJpeg(BufferedImage img, float quality) throws IOException {
        ImageWriter writer = ImageIO.getImageWritersByFormatName("jpeg").next();
        try {
            ImageWriteParam param = writer.getDefaultWriteParam();
            param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
            param.setCompressionQuality(Math.max(0.05f, Math.min(1f, quality)));
            ByteArrayOutputStream out = new ByteArrayOutputStream(32 * 1024);
            try (MemoryCacheImageOutputStream ios = new MemoryCacheImageOutputStream(out)) {
                writer.setOutput(ios);
                writer.write(null, new IIOImage(img, null, null), param);
            }
            return out.toByteArray();
        } finally {
            writer.dispose();
        }
    }

    public static String base64(byte[] data) {
        return Base64.getEncoder().encodeToString(data);
    }
}
