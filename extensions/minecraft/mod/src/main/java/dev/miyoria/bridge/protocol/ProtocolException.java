package dev.miyoria.bridge.protocol;

/** A request could not be understood; carries the protocol error code to send back. */
public final class ProtocolException extends Exception {
    private final String code;

    public ProtocolException(String code, String message) {
        super(message);
        this.code = code;
    }

    public String code() {
        return code;
    }
}
