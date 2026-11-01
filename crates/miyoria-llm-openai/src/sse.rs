//! Minimal Server-Sent Events parser that only cares about `data:` fields.

/// Incremental SSE parser. Bytes may be split anywhere (including inside
/// UTF-8 sequences); complete event payloads are returned as they finish.
#[derive(Debug, Default)]
pub(crate) struct SseParser {
    buf: Vec<u8>,
    data: String,
    has_data: bool,
}

impl SseParser {
    /// Feeds bytes and returns the data payloads of all completed events.
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        self.buf.extend_from_slice(bytes);
        let buf = std::mem::take(&mut self.buf);
        let mut start = 0;
        while let Some(pos) = buf[start..].iter().position(|&b| b == b'\n') {
            self.line(&buf[start..start + pos], &mut out);
            start += pos + 1;
        }
        self.buf = buf;
        self.buf.drain(..start);
        out
    }

    /// Flushes a trailing unterminated line / event at end of stream.
    pub(crate) fn finish(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        let rest = std::mem::take(&mut self.buf);
        if !rest.is_empty() {
            self.line(&rest, &mut out);
        }
        self.line(b"", &mut out);
        out
    }

    fn line(&mut self, line: &[u8], out: &mut Vec<String>) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            if self.has_data {
                out.push(std::mem::take(&mut self.data));
                self.has_data = false;
            }
            return;
        }
        // Lines are split on `\n`, which never occurs inside a UTF-8 sequence.
        let line = String::from_utf8_lossy(line);
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line.as_ref(), ""),
        };
        if field == "data" {
            if self.has_data {
                self.data.push('\n');
            }
            self.data.push_str(value);
            self.has_data = true;
        }
        // Comments (`: keep-alive`), `event:`, `id:` and `retry:` are ignored.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_arbitrary_splits() {
        let input = ": keep-alive\r\n\r\ndata: {\"a\":\"你好\"}\r\n\r\nevent: x\ndata: l1\ndata: l2\n\ndata: [DONE]";
        for step in 1..=input.len() {
            let mut p = SseParser::default();
            let mut got = Vec::new();
            for chunk in input.as_bytes().chunks(step) {
                got.extend(p.push(chunk));
            }
            got.extend(p.finish());
            assert_eq!(got, ["{\"a\":\"你好\"}", "l1\nl2", "[DONE]"], "step {step}");
        }
    }
}
