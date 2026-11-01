package dev.miyoria.bridge.game;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;
import dev.miyoria.bridge.server.ActionHandler.Responder;
import dev.miyoria.bridge.util.ImageUtil;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.texture.NativeImage;
import net.minecraft.client.util.ScreenshotRecorder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.image.BufferedImage;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Framebuffer -> downscaled PNG/JPEG (base64). The framebuffer read happens on the render thread
 * (the caller is already on the client thread); scaling and encoding run on a worker thread.
 */
public final class ScreenshotService {
    private static final Logger LOG = LoggerFactory.getLogger("miyoria-bridge");

    private final int defaultMaxWidth;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "miyoria-bridge-screenshot");
        t.setDaemon(true);
        return t;
    });

    public ScreenshotService(int defaultMaxWidth) {
        this.defaultMaxWidth = defaultMaxWidth;
    }

    /** Must be called on the client (render) thread. Replies asynchronously. */
    public void capture(MinecraftClient mc, Request req, Responder responder) throws ProtocolException {
        int maxWidth = Math.max(64, Math.min(3840, req.optInt("max_width", defaultMaxWidth)));
        String format = req.optStr("format", "png").toLowerCase();
        if (!format.equals("png") && !format.equals("jpeg") && !format.equals("jpg")) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "format must be png or jpeg");
        }
        boolean jpeg = !format.equals("png");
        float quality = (float) (req.optNum("quality") == null ? 0.8 : req.optNum("quality"));

        int w;
        int h;
        int[] argb;
        try (NativeImage img = ScreenshotRecorder.takeScreenshot(mc.getFramebuffer())) {
            w = img.getWidth();
            h = img.getHeight();
            argb = new int[w * h];
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    int c = img.getColor(x, y); // ABGR
                    argb[y * w + x] = 0xFF000000 | (c & 0x0000FF00) | ((c >> 16) & 0xFF) | ((c & 0xFF) << 16);
                }
            }
        } catch (RuntimeException e) {
            throw new ProtocolException(Protocol.E_SCREENSHOT_FAILED, String.valueOf(e));
        }

        final int sw = w;
        final int sh = h;
        worker.execute(() -> {
            try {
                BufferedImage scaled = ImageUtil.downscale(ImageUtil.fromArgb(argb, sw, sh), maxWidth);
                byte[] bytes = jpeg ? ImageUtil.encodeJpeg(scaled, quality) : ImageUtil.encodePng(scaled);
                JsonObject out = new JsonObject();
                out.addProperty("mime", jpeg ? "image/jpeg" : "image/png");
                out.addProperty("width", scaled.getWidth());
                out.addProperty("height", scaled.getHeight());
                out.addProperty("source_width", sw);
                out.addProperty("source_height", sh);
                out.addProperty("data_base64", ImageUtil.base64(bytes));
                responder.ok(out);
            } catch (Throwable t) {
                LOG.warn("screenshot encode failed", t);
                responder.fail(Protocol.E_SCREENSHOT_FAILED, String.valueOf(t));
            }
        });
    }

    public void shutdown() {
        worker.shutdownNow();
    }
}
