const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { dataPath } = require("./storagePaths");

const DEFAULT_USERS_FILE = dataPath("users.json");
const PASSWORD_ITERATIONS = 120000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = "sha256";

class UserStore {
  constructor(filePath = process.env.USERS_FILE || DEFAULT_USERS_FILE) {
    this.filePath = filePath;
    this.users = [];
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.users = [];
        return;
      }

      const raw = fs.readFileSync(this.filePath, "utf8");
      const payload = JSON.parse(raw || "{}");
      this.users = Array.isArray(payload.users)
        ? payload.users.map((user) => this.sanitizeUser(user)).filter(Boolean)
        : [];
    } catch {
      this.users = [];
    }
  }

  createUser(login, password) {
    const cleanLogin = this.cleanLogin(login);
    const cleanPassword = String(password || "");

    if (!cleanLogin || !cleanPassword) {
      throw new Error("Login and password are required.");
    }

    if (this.findByLogin(cleanLogin)) {
      throw new Error("User already exists.");
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const user = {
      id: crypto.randomUUID(),
      login: cleanLogin,
      passwordHash: this.hashPassword(cleanPassword, salt),
      salt,
      createdAt: new Date().toISOString()
    };

    this.users.push(user);
    this.save();
    return this.publicUser(user);
  }

  verifyUser(login, password) {
    const user = this.findByLogin(login);
    if (!user) return null;

    const expectedHash = Buffer.from(user.passwordHash, "hex");
    const actualHash = Buffer.from(this.hashPassword(String(password || ""), user.salt), "hex");

    if (expectedHash.length !== actualHash.length) return null;
    return crypto.timingSafeEqual(expectedHash, actualHash) ? this.publicUser(user) : null;
  }

  getUserById(userId) {
    const user = this.users.find((item) => item.id === userId);
    return user ? this.publicUser(user) : null;
  }

  findByLogin(login) {
    const cleanLogin = this.cleanLogin(login);
    return this.users.find((user) => user.login.toLowerCase() === cleanLogin.toLowerCase()) || null;
  }

  hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST).toString("hex");
  }

  save() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });

    const tempFilePath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempFilePath, `${JSON.stringify({ users: this.users }, null, 2)}\n`, "utf8");
    fs.renameSync(tempFilePath, this.filePath);
  }

  sanitizeUser(user) {
    const id = String(user?.id || "").trim();
    const login = this.cleanLogin(user?.login);
    const passwordHash = String(user?.passwordHash || "").trim();
    const salt = String(user?.salt || "").trim();
    if (!id || !login || !passwordHash || !salt) return null;

    return {
      id,
      login,
      passwordHash,
      salt,
      createdAt: this.cleanDate(user?.createdAt) || new Date().toISOString()
    };
  }

  publicUser(user) {
    return {
      id: user.id,
      login: user.login
    };
  }

  cleanLogin(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 64);
  }

  cleanDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
}

module.exports = UserStore;
