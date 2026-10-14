// db.js - Persistent SQLite Database for FundIQ Accounts, Activity & Financial Data
const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const DB_PATH = path.join(__dirname, "fundiq.db");
const db = new DatabaseSync(DB_PATH);

// Enable WAL mode and foreign keys
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

// Initialize Schema safely without dropping existing tables
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username_attempted TEXT,
    timestamp TEXT NOT NULL,
    success INTEGER NOT NULL,
    failure_reason TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS user_wallets (
    user_id INTEGER PRIMARY KEY,
    bills REAL NOT NULL DEFAULT 0,
    spending REAL NOT NULL DEFAULT 0,
    savings REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_payments (
    user_id INTEGER PRIMARY KEY,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

// Prepared statement helpers
const stmts = {
    insertUser: db.prepare(`
        INSERT INTO users (full_name, username, email, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
    `),
    findUserByUsername: db.prepare(`
        SELECT * FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1
    `),
    findUserByEmail: db.prepare(`
        SELECT * FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1
    `),
    findUserById: db.prepare(`
        SELECT id, full_name, username, email, created_at FROM users WHERE id = ? LIMIT 1
    `),
    insertActivity: db.prepare(`
        INSERT INTO login_activity (user_id, username_attempted, timestamp, success, failure_reason)
        VALUES (?, ?, ?, ?, ?)
    `),
    getWallet: db.prepare(`
        SELECT bills, spending, savings FROM user_wallets WHERE user_id = ? LIMIT 1
    `),
    upsertWallet: db.prepare(`
        INSERT INTO user_wallets (user_id, bills, spending, savings, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            bills = excluded.bills,
            spending = excluded.spending,
            savings = excluded.savings,
            updated_at = excluded.updated_at
    `),
    getPayments: db.prepare(`
        SELECT data_json FROM user_payments WHERE user_id = ? LIMIT 1
    `),
    upsertPayments: db.prepare(`
        INSERT INTO user_payments (user_id, data_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            data_json = excluded.data_json,
            updated_at = excluded.updated_at
    `)
};

function createUser(fullName, username, email, passwordHash) {
    const now = new Date().toISOString();
    const result = stmts.insertUser.run(
        fullName.trim(),
        username.trim().toLowerCase(),
        email.trim().toLowerCase(),
        passwordHash,
        now
    );
    const userId = Number(result.lastInsertRowid);

    // Initialize default wallet and payments for new user
    stmts.upsertWallet.run(userId, 0, 0, 0, now);
    stmts.upsertPayments.run(userId, JSON.stringify({ templates: [], completions: {}, overrides: {} }), now);

    return {
        id: userId,
        fullName: fullName.trim(),
        username: username.trim().toLowerCase(),
        email: email.trim().toLowerCase(),
        createdAt: now
    };
}

function findUserByUsername(username) {
    if (!username) return null;
    return stmts.findUserByUsername.get(username.trim().toLowerCase()) || null;
}

function findUserByEmail(email) {
    if (!email) return null;
    return stmts.findUserByEmail.get(email.trim().toLowerCase()) || null;
}

function findUserById(id) {
    if (!id) return null;
    return stmts.findUserById.get(Number(id)) || null;
}

function recordLoginActivity(userId, usernameAttempted, success, failureReason = null) {
    try {
        stmts.insertActivity.run(
            userId ? Number(userId) : null,
            usernameAttempted ? usernameAttempted.slice(0, 100) : "unknown",
            new Date().toISOString(),
            success ? 1 : 0,
            failureReason ? String(failureReason).slice(0, 100) : null
        );
    } catch (err) {
        console.error("FundIQ: Failed to record login activity:", err.message);
    }
}

function getUserWallet(userId) {
    const row = stmts.getWallet.get(Number(userId));
    if (row) {
        return {
            bills: Number(row.bills) || 0,
            spending: Number(row.spending) || 0,
            savings: Number(row.savings) || 0
        };
    }
    return { bills: 0, spending: 0, savings: 0 };
}

function setUserWallet(userId, wallet) {
    const now = new Date().toISOString();
    stmts.upsertWallet.run(
        Number(userId),
        Number(wallet.bills) || 0,
        Number(wallet.spending) || 0,
        Number(wallet.savings) || 0,
        now
    );
    return getUserWallet(userId);
}

function clearUserWallet(userId) {
    const now = new Date().toISOString();
    stmts.upsertWallet.run(Number(userId), 0, 0, 0, now);
    return { bills: 0, spending: 0, savings: 0 };
}

function getUserPayments(userId) {
    const row = stmts.getPayments.get(Number(userId));
    if (row && row.data_json) {
        try {
            return JSON.parse(row.data_json);
        } catch (e) {
            console.error("FundIQ: Error parsing payment json:", e);
        }
    }
    return { templates: [], completions: {}, overrides: {} };
}

function setUserPayments(userId, paymentData) {
    const now = new Date().toISOString();
    const jsonStr = JSON.stringify({
        templates: Array.isArray(paymentData.templates) ? paymentData.templates : [],
        completions: paymentData.completions && typeof paymentData.completions === "object" ? paymentData.completions : {},
        overrides: paymentData.overrides && typeof paymentData.overrides === "object" ? paymentData.overrides : {}
    });
    stmts.upsertPayments.run(Number(userId), jsonStr, now);
    return getUserPayments(userId);
}

module.exports = {
    db,
    createUser,
    findUserByUsername,
    findUserByEmail,
    findUserById,
    recordLoginActivity,
    getUserWallet,
    setUserWallet,
    clearUserWallet,
    getUserPayments,
    setUserPayments
};

