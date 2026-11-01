// Topic patterns, matching the host's `TopicFilter`.

/** `"*"` matches everything, `"a.*"` every topic under `a.`, else exact. */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // keeps the trailing dot
    return topic.startsWith(prefix);
  }
  return pattern === topic;
}

const SEGMENT = /^[a-z0-9_-]+$/;

/** Concrete topic: dotted segments of `[a-z0-9_-]`. */
export function isValidTopic(topic: string): boolean {
  return topic.length > 0 && topic.length <= 128 && topic.split(".").every((s) => SEGMENT.test(s));
}
