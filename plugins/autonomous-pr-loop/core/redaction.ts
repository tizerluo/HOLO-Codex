/** Redact common secret shapes before persisting user-visible summaries. */
export function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9._%+-]+:[^@\s]+@/g, "[redacted]@")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/((?:token|api_key|authorization|password|secret)\s*[:=]\s*)(["'])(?:(?!\2).)*\2/gi, "$1$2[redacted]$2")
    .replace(/((?:token|api_key|authorization|password|secret)\s*[:=]\s*)[^\n\r,;}]+/gi, "$1[redacted]");
}

/** Return true when an object key names a likely secret field. */
export function isSecretKey(key: string): boolean {
  return /token|api_key|authorization|password|secret/i.test(key);
}
