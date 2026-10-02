// Security and session rules for web access: password hashing, login rate
// limiting, the LAN-only address filter, and the one-controller model.
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const MIN_PASSWORD = 8;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new Error(`Use a password of at least ${MIN_PASSWORD} characters.`);
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString("hex");
  return { salt, hash };
}

// The PIN for browsers and for pairing the Odin Sync app: 6 to 12 digits,
// stored like a password (a guessed PIN is slowed down by the rate limiter).
function hashPin(pin) {
  if (typeof pin !== "string" || !/^\d{6,12}$/.test(pin)) throw new Error("Use a PIN of 6 to 12 digits.");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pin, salt, SCRYPT.keylen, SCRYPT).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, stored) {
  if (typeof password !== "string" || !stored?.hash || !stored?.salt) return false;
  const expected = Buffer.from(stored.hash, "hex");
  const actual = crypto.scryptSync(password, stored.salt, expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

// Only loopback, private (RFC 1918) and link-local addresses may connect.
function isLanAddress(address) {
  if (!address) return false;
  const ip = address.replace(/^::ffff:/i, "");
  if (ip === "::1" || ip === "127.0.0.1" || ip.startsWith("127.")) return true;
  if (/^fe80:/i.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

// At most `limit` failed logins per IP in `windowMs`.
class RateLimiter {
  constructor(limit = 5, windowMs = 60 * 1000, now = () => Date.now()) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.failures = new Map();
  }
  recent(ip) {
    const since = this.now() - this.windowMs;
    const list = (this.failures.get(ip) || []).filter((time) => time > since);
    this.failures.set(ip, list);
    return list;
  }
  blocked(ip) {
    return this.recent(ip).length >= this.limit;
  }
  fail(ip) {
    this.recent(ip).push(this.now());
  }
  reset(ip) {
    this.failures.delete(ip);
  }
}

// One controller at a time: the PC app, or a single web session. A newer web
// login replaces the older one; the PC can take control back (kick).
class Sessions extends EventEmitter {
  constructor(now = () => Date.now()) {
    super();
    this.now = now;
    this.web = null;
  }
  login(ip) {
    const previous = this.web;
    this.web = { token: crypto.randomBytes(32).toString("hex"), ip, since: this.now() };
    if (previous) this.emit("ended", { token: previous.token, reason: "replaced" });
    this.emit("changed", this.status());
    return this.web.token;
  }
  valid(token) {
    if (typeof token !== "string" || !this.web || token.length !== this.web.token.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.web.token));
  }
  end(reason) {
    const previous = this.web;
    this.web = null;
    if (previous) {
      this.emit("ended", { token: previous.token, reason });
      this.emit("changed", this.status());
    }
    return !!previous;
  }
  controller() {
    return this.web ? "web" : "app";
  }
  // May `source` (app, or web with this token) change things right now?
  allowed(source, token) {
    if (source === "app") return !this.web;
    return this.valid(token);
  }
  status() {
    return {
      controller: this.controller(),
      web: this.web ? { ip: this.web.ip, since: this.web.since } : null,
    };
  }
}

// One destructive or long operation at a time, across the PC and the web.
class OperationLock {
  constructor() {
    this.current = null;
  }
  async run(name, source, fn) {
    if (this.current) {
      const who = this.current.source === "web" ? "web" : "PC";
      throw new Error(
        `Busy: ${this.current.name} started from the ${who}. Try again when it finishes.`,
      );
    }
    this.current = { name, source, since: Date.now() };
    try {
      return await fn();
    } finally {
      this.current = null;
    }
  }
}

module.exports = {
  hashPin,
  MIN_PASSWORD,
  hashPassword,
  verifyPassword,
  isLanAddress,
  RateLimiter,
  Sessions,
  OperationLock,
};
