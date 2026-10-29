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

CREATE TABLE IF NOT EXISTS plaid_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    item_id TEXT NOT NULL UNIQUE,
    access_token TEXT NOT NULL,
    institution_id TEXT,
    institution_name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS plaid_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    account_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    official_name TEXT,
    mask TEXT,
    type TEXT NOT NULL,
    subtype TEXT,
    available_balance REAL,
    current_balance REAL,
    iso_currency_code TEXT DEFAULT 'USD',
    mapped_category TEXT NOT NULL DEFAULT 'none',
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES plaid_items(item_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_notification_prefs (
    user_id INTEGER PRIMARY KEY,
    email_enabled INTEGER NOT NULL DEFAULT 1,
    payment_due_enabled INTEGER NOT NULL DEFAULT 1,
    deposit_enabled INTEGER NOT NULL DEFAULT 1,
    payment_submitted_enabled INTEGER NOT NULL DEFAULT 1,
    reminder_days_before INTEGER NOT NULL DEFAULT 3,
    sms_enabled INTEGER NOT NULL DEFAULT 0,
    phone_number TEXT NOT NULL DEFAULT '',
    sms_payment_due_enabled INTEGER NOT NULL DEFAULT 1,
    sms_deposit_enabled INTEGER NOT NULL DEFAULT 1,
    sms_payment_submitted_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS email_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL,
    provider TEXT,
    message_id TEXT,
    error_message TEXT,
    metadata_json TEXT,
    body_text TEXT,
    body_html TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    UNIQUE(user_id, event_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS wallet_subcategories (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    bucket TEXT NOT NULL,
    name TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    ratio REAL,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_ratio_seeded INTEGER NOT NULL DEFAULT 0,
    transactions_json TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS plaid_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    name TEXT NOT NULL,
    merchant_name TEXT,
    amount REAL NOT NULL,
    iso_currency_code TEXT DEFAULT 'USD',
    date TEXT NOT NULL,
    authorized_date TEXT,
    pending INTEGER NOT NULL DEFAULT 0,
    category_primary TEXT,
    category_detailed TEXT,
    payment_channel TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, transaction_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS detected_bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    bill_key TEXT NOT NULL,
    account_id TEXT,
    account_name TEXT,
    merchant_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    expected_amount REAL NOT NULL,
    frequency TEXT NOT NULL,
    last_paid_date TEXT NOT NULL,
    last_paid_amount REAL NOT NULL,
    next_due_date TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL DEFAULT 2,
    confidence TEXT NOT NULL DEFAULT 'high',
    wallet_category TEXT NOT NULL DEFAULT 'bills',
    status TEXT NOT NULL DEFAULT 'predicted',
    user_modified INTEGER NOT NULL DEFAULT 0,
    calendar_template_id TEXT,
    source_transaction_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, bill_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

// Safe non-destructive column migrations for existing databases
(function runSafeMigrations() {
    try {
        const notifCols = new Set(
            (db.prepare("PRAGMA table_info(user_notification_prefs)").all() || []).map((c) => c.name)
        );
        if (!notifCols.has("sms_enabled")) {
            db.exec("ALTER TABLE user_notification_prefs ADD COLUMN sms_enabled INTEGER NOT NULL DEFAULT 0;");
        }
        if (!notifCols.has("phone_number")) {
            db.exec("ALTER TABLE user_notification_prefs ADD COLUMN phone_number TEXT NOT NULL DEFAULT '';");
        }
        if (!notifCols.has("sms_payment_due_enabled")) {
            db.exec("ALTER TABLE user_notification_prefs ADD COLUMN sms_payment_due_enabled INTEGER NOT NULL DEFAULT 1;");
        }
        if (!notifCols.has("sms_deposit_enabled")) {
            db.exec("ALTER TABLE user_notification_prefs ADD COLUMN sms_deposit_enabled INTEGER NOT NULL DEFAULT 1;");
        }
        if (!notifCols.has("sms_payment_submitted_enabled")) {
            db.exec("ALTER TABLE user_notification_prefs ADD COLUMN sms_payment_submitted_enabled INTEGER NOT NULL DEFAULT 1;");
        }

        const itemCols = new Set(
            (db.prepare("PRAGMA table_info(plaid_items)").all() || []).map((c) => c.name)
        );
        if (!itemCols.has("transactions_cursor")) {
            db.exec("ALTER TABLE plaid_items ADD COLUMN transactions_cursor TEXT DEFAULT '';");
        }
    } catch (migErr) {
        console.warn("FundIQ DB migration check warning:", migErr.message);
    }
})();

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
    `),
    upsertPlaidItem: db.prepare(`
        INSERT INTO plaid_items (user_id, item_id, access_token, institution_id, institution_name, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
            access_token = excluded.access_token,
            institution_id = COALESCE(excluded.institution_id, plaid_items.institution_id),
            institution_name = COALESCE(excluded.institution_name, plaid_items.institution_name),
            status = excluded.status,
            updated_at = excluded.updated_at
    `),
    getPlaidItemsByUserInternal: db.prepare(`
        SELECT id, user_id, item_id, access_token, institution_id, institution_name, status, transactions_cursor, created_at, updated_at
        FROM plaid_items
        WHERE user_id = ? AND status = 'active'
        ORDER BY created_at ASC
    `),
    updatePlaidItemCursor: db.prepare(`
        UPDATE plaid_items
        SET transactions_cursor = ?, updated_at = ?
        WHERE user_id = ? AND item_id = ?
    `),
    findPlaidItemByUserAndInstitution: db.prepare(`
        SELECT id, user_id, item_id, institution_id, institution_name, status, created_at
        FROM plaid_items
        WHERE user_id = ? AND institution_id = ? AND status = 'active'
        LIMIT 1
    `),
    getPlaidItemByUserAndItemId: db.prepare(`
        SELECT id, user_id, item_id, access_token, institution_id, institution_name, status, created_at, updated_at
        FROM plaid_items
        WHERE user_id = ? AND item_id = ?
        LIMIT 1
    `),
    deletePlaidAccountsByItem: db.prepare(`
        DELETE FROM plaid_accounts WHERE user_id = ? AND item_id = ?
    `),
    deletePlaidItemByUserAndItemId: db.prepare(`
        DELETE FROM plaid_items WHERE user_id = ? AND item_id = ?
    `),
    getPlaidAccountsByUser: db.prepare(`
        SELECT
            a.id,
            a.user_id,
            a.item_id,
            a.account_id,
            a.name,
            a.official_name,
            a.mask,
            a.type,
            a.subtype,
            a.available_balance,
            a.current_balance,
            a.iso_currency_code,
            a.mapped_category,
            a.updated_at,
            i.institution_id,
            i.institution_name
        FROM plaid_accounts a
        JOIN plaid_items i ON a.item_id = i.item_id
        WHERE a.user_id = ? AND i.status = 'active'
        ORDER BY i.created_at ASC, a.id ASC
    `),
    getPlaidAccountByAccountId: db.prepare(`
        SELECT * FROM plaid_accounts WHERE account_id = ? LIMIT 1
    `),
    upsertPlaidAccount: db.prepare(`
        INSERT INTO plaid_accounts (
            user_id, item_id, account_id, name, official_name, mask,
            type, subtype, available_balance, current_balance,
            iso_currency_code, mapped_category, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
            name = excluded.name,
            official_name = excluded.official_name,
            mask = excluded.mask,
            type = excluded.type,
            subtype = excluded.subtype,
            available_balance = excluded.available_balance,
            current_balance = excluded.current_balance,
            iso_currency_code = excluded.iso_currency_code,
            mapped_category = excluded.mapped_category,
            updated_at = excluded.updated_at
    `),
    updatePlaidAccountMapping: db.prepare(`
        UPDATE plaid_accounts
        SET mapped_category = ?, updated_at = ?
        WHERE user_id = ? AND account_id = ?
    `),
    getNotificationPrefs: db.prepare(`
        SELECT user_id, email_enabled, payment_due_enabled, deposit_enabled, payment_submitted_enabled,
               reminder_days_before, sms_enabled, phone_number, sms_payment_due_enabled,
               sms_deposit_enabled, sms_payment_submitted_enabled, updated_at
        FROM user_notification_prefs
        WHERE user_id = ?
        LIMIT 1
    `),
    upsertNotificationPrefs: db.prepare(`
        INSERT INTO user_notification_prefs (
            user_id, email_enabled, payment_due_enabled, deposit_enabled,
            payment_submitted_enabled, reminder_days_before,
            sms_enabled, phone_number, sms_payment_due_enabled,
            sms_deposit_enabled, sms_payment_submitted_enabled, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            email_enabled = excluded.email_enabled,
            payment_due_enabled = excluded.payment_due_enabled,
            deposit_enabled = excluded.deposit_enabled,
            payment_submitted_enabled = excluded.payment_submitted_enabled,
            reminder_days_before = excluded.reminder_days_before,
            sms_enabled = excluded.sms_enabled,
            phone_number = excluded.phone_number,
            sms_payment_due_enabled = excluded.sms_payment_due_enabled,
            sms_deposit_enabled = excluded.sms_deposit_enabled,
            sms_payment_submitted_enabled = excluded.sms_payment_submitted_enabled,
            updated_at = excluded.updated_at
    `),
    getSubcategoriesByUser: db.prepare(`
        SELECT id, user_id, bucket, name, amount, ratio, is_default, is_ratio_seeded,
               transactions_json, sort_order, created_at, updated_at
        FROM wallet_subcategories
        WHERE user_id = ?
        ORDER BY bucket ASC, sort_order ASC, row_id ASC
    `),
    getSubcategoryById: db.prepare(`
        SELECT id, user_id, bucket, name, amount, ratio, is_default, is_ratio_seeded,
               transactions_json, sort_order, created_at, updated_at
        FROM wallet_subcategories
        WHERE user_id = ? AND id = ?
        LIMIT 1
    `),
    insertSubcategory: db.prepare(`
        INSERT INTO wallet_subcategories (
            id, user_id, bucket, name, amount, ratio, is_default, is_ratio_seeded,
            transactions_json, sort_order, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateSubcategory: db.prepare(`
        UPDATE wallet_subcategories
        SET name = ?, amount = ?, is_ratio_seeded = ?, transactions_json = ?, updated_at = ?
        WHERE user_id = ? AND id = ?
    `),
    deleteSubcategory: db.prepare(`
        DELETE FROM wallet_subcategories WHERE user_id = ? AND id = ?
    `),
    upsertPlaidTransaction: db.prepare(`
        INSERT INTO plaid_transactions (
            user_id, item_id, account_id, transaction_id, name, merchant_name,
            amount, iso_currency_code, date, authorized_date, pending,
            category_primary, category_detailed, payment_channel, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, transaction_id) DO UPDATE SET
            name = excluded.name,
            merchant_name = excluded.merchant_name,
            amount = excluded.amount,
            iso_currency_code = excluded.iso_currency_code,
            date = excluded.date,
            authorized_date = excluded.authorized_date,
            pending = excluded.pending,
            category_primary = excluded.category_primary,
            category_detailed = excluded.category_detailed,
            payment_channel = excluded.payment_channel,
            updated_at = excluded.updated_at
    `),
    deletePlaidTransactionById: db.prepare(`
        DELETE FROM plaid_transactions WHERE user_id = ? AND transaction_id = ?
    `),
    deletePlaidTransactionsByItem: db.prepare(`
        DELETE FROM plaid_transactions WHERE user_id = ? AND item_id = ?
    `),
    getPlaidTransactionsByUser: db.prepare(`
        SELECT t.*, a.name AS account_name, a.mask AS account_mask, a.subtype AS account_subtype, i.institution_name
        FROM plaid_transactions t
        LEFT JOIN plaid_accounts a ON t.account_id = a.account_id
        LEFT JOIN plaid_items i ON t.item_id = i.item_id
        WHERE t.user_id = ?
        ORDER BY t.date DESC, t.id DESC
        LIMIT ?
    `),
    getConfirmedOutflowTransactionsByUser: db.prepare(`
        SELECT t.*, a.name AS account_name, a.mask AS account_mask, a.subtype AS account_subtype, i.institution_name
        FROM plaid_transactions t
        LEFT JOIN plaid_accounts a ON t.account_id = a.account_id
        LEFT JOIN plaid_items i ON t.item_id = i.item_id
        WHERE t.user_id = ? AND t.pending = 0 AND t.amount > 0
        ORDER BY t.date ASC, t.id ASC
    `),
    getDetectedBillsByUser: db.prepare(`
        SELECT * FROM detected_bills
        WHERE user_id = ?
        ORDER BY next_due_date ASC, id ASC
    `),
    getDetectedBillByKey: db.prepare(`
        SELECT * FROM detected_bills
        WHERE user_id = ? AND bill_key = ?
        LIMIT 1
    `),
    getDetectedBillById: db.prepare(`
        SELECT * FROM detected_bills
        WHERE user_id = ? AND id = ?
        LIMIT 1
    `),
    insertDetectedBill: db.prepare(`
        INSERT INTO detected_bills (
            user_id, bill_key, account_id, account_name, merchant_name, display_name,
            expected_amount, frequency, last_paid_date, last_paid_amount, next_due_date,
            occurrence_count, confidence, wallet_category, status, user_modified,
            calendar_template_id, source_transaction_ids_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateDetectedBillAuto: db.prepare(`
        UPDATE detected_bills
        SET account_id = ?,
            account_name = ?,
            expected_amount = ?,
            frequency = ?,
            last_paid_date = ?,
            last_paid_amount = ?,
            next_due_date = ?,
            occurrence_count = ?,
            confidence = ?,
            calendar_template_id = ?,
            source_transaction_ids_json = ?,
            updated_at = ?
        WHERE user_id = ? AND id = ?
    `),
    updateDetectedBillHistoryOnly: db.prepare(`
        UPDATE detected_bills
        SET last_paid_date = ?,
            last_paid_amount = ?,
            occurrence_count = ?,
            source_transaction_ids_json = ?,
            updated_at = ?
        WHERE user_id = ? AND id = ?
    `),
    updateDetectedBillManual: db.prepare(`
        UPDATE detected_bills
        SET display_name = ?,
            expected_amount = ?,
            frequency = ?,
            next_due_date = ?,
            wallet_category = ?,
            status = ?,
            user_modified = 1,
            calendar_template_id = ?,
            updated_at = ?
        WHERE user_id = ? AND id = ?
    `),
    findNotificationByEventKey: db.prepare(`
        SELECT * FROM email_notifications
        WHERE user_id = ? AND event_key = ?
        LIMIT 1
    `),
    insertEmailNotification: db.prepare(`
        INSERT INTO email_notifications (
            user_id, event_key, event_type, recipient_email, subject,
            status, provider, message_id, error_message, metadata_json,
            body_text, body_html, attempts, created_at, sent_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateEmailNotification: db.prepare(`
        UPDATE email_notifications
        SET status = ?,
            provider = ?,
            message_id = ?,
            error_message = ?,
            attempts = ?,
            sent_at = ?
        WHERE id = ?
    `),
    getUserNotifications: db.prepare(`
        SELECT id, user_id, event_key, event_type, recipient_email, subject,
               status, provider, message_id, error_message, metadata_json,
               attempts, created_at, sent_at
        FROM email_notifications
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ?
    `),
    getAllUsers: db.prepare(`
        SELECT id, full_name, username, email, created_at FROM users ORDER BY id ASC
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

function setUserPayments(userId, paymentData, options = {}) {
    const uid = Number(userId);
    const now = new Date().toISOString();
    const prevPayments = getUserPayments(uid);
    const prevTemplates = Array.isArray(prevPayments.templates) ? prevPayments.templates : [];
    const nextTemplates = Array.isArray(paymentData.templates) ? paymentData.templates : [];
    const nextOverrides = paymentData.overrides && typeof paymentData.overrides === "object" ? paymentData.overrides : {};

    const rawCompletions =
        paymentData.completions && typeof paymentData.completions === "object"
            ? paymentData.completions
            : paymentData.completed && typeof paymentData.completed === "object"
            ? paymentData.completed
            : {};

    // Synchronize manual Calendar edits or deletions of predicted bills with detected_bills
    // so subsequent Plaid refreshes never overwrite user changes or resurrect deleted predictions
    if (!options.skipDetectedBillSync) {
        try {
            const existingDetected = stmts.getDetectedBillsByUser.all(uid) || [];
            const prevTplById = new Map(prevTemplates.map((t) => [String(t.id), t]));
            const nextTplById = new Map(nextTemplates.map((t) => [String(t.id), t]));

            for (const det of existingDetected) {
                if (det.status === "dismissed") continue;
                const tplId = det.calendar_template_id ? String(det.calendar_template_id) : null;
                if (!tplId) continue;

                const nextTpl = nextTplById.get(tplId);
                const hadPrevTpl = prevTplById.has(tplId);

                if (!nextTpl && hadPrevTpl) {
                    // User deleted the predicted payment series from the calendar -> mark dismissed
                    stmts.updateDetectedBillManual.run(
                        det.display_name,
                        Number(det.expected_amount) || 0,
                        det.frequency || "monthly",
                        det.next_due_date,
                        det.wallet_category || "bills",
                        "dismissed",
                        null,
                        now,
                        uid,
                        det.id
                    );
                    continue;
                }

                if (nextTpl) {
                    // Check if single occurrence override for next_due_date deleted or modified it
                    const primaryOccId = `${tplId}_${det.next_due_date}`;
                    const occOverride = nextOverrides[primaryOccId];
                    if (occOverride && occOverride.isDeleted && (nextTpl.recurrence === "none" || nextTpl.userDismissedPrediction)) {
                        stmts.updateDetectedBillManual.run(
                            det.display_name,
                            Number(det.expected_amount) || 0,
                            det.frequency || "monthly",
                            det.next_due_date,
                            det.wallet_category || "bills",
                            "dismissed",
                            null,
                            now,
                            uid,
                            det.id
                        );
                        continue;
                    }

                    const newName = String((occOverride && occOverride.title) || nextTpl.title || det.display_name).trim();
                    const newAmt = Number(
                        occOverride && occOverride.amount !== undefined
                            ? occOverride.amount
                            : nextTpl.amount !== undefined
                            ? nextTpl.amount
                            : det.expected_amount
                    );
                    const newFreq = String(nextTpl.recurrence || det.frequency || "monthly").toLowerCase();
                    const newDue = String((occOverride && occOverride.date) || nextTpl.startDate || det.next_due_date);
                    const newCat = String((occOverride && occOverride.category) || nextTpl.category || det.wallet_category || "bills").toLowerCase();

                    const changed =
                        Boolean(nextTpl.userModified) ||
                        newName !== det.display_name ||
                        Math.abs(newAmt - Number(det.expected_amount)) > 0.005 ||
                        newFreq !== String(det.frequency).toLowerCase() ||
                        newDue !== det.next_due_date ||
                        newCat !== String(det.wallet_category || "bills").toLowerCase();

                    if (changed) {
                        stmts.updateDetectedBillManual.run(
                            newName,
                            Math.round(newAmt * 100) / 100,
                            newFreq,
                            newDue,
                            newCat,
                            nextTpl.predictionStatus === "dismissed" ? "dismissed" : "confirmed",
                            tplId,
                            now,
                            uid,
                            det.id
                        );
                    }
                }
            }
        } catch (syncErr) {
            console.warn("FundIQ detected bill sync warning:", syncErr.message);
        }
    }

    const jsonStr = JSON.stringify({
        templates: nextTemplates,
        completions: rawCompletions,
        overrides: nextOverrides
    });
    stmts.upsertPayments.run(uid, jsonStr, now);
    return getUserPayments(uid);
}

// -----------------------------
// WALLET SUBCATEGORIES (USER-SCOPED & EDITABLE)
// -----------------------------

const DEFAULT_SUBCATEGORY_SPECS = [
    { id: "sub_savings_emergency", bucket: "savings", name: "Emergency fund", ratio: 0.615, sortOrder: 1 },
    { id: "sub_savings_vacation", bucket: "savings", name: "Vacation", ratio: 0.249, sortOrder: 2 },
    { id: "sub_savings_car", bucket: "savings", name: "New car", ratio: 0.136, sortOrder: 3 },
    { id: "sub_bills_housing", bucket: "bills", name: "Housing", ratio: 0.657, sortOrder: 1 },
    { id: "sub_bills_utilities", bucket: "bills", name: "Utilities", ratio: 0.151, sortOrder: 2 },
    { id: "sub_bills_insurance", bucket: "bills", name: "Insurance", ratio: 0.192, sortOrder: 3 },
    { id: "sub_spending_groceries", bucket: "spending", name: "Groceries", ratio: 0.387, sortOrder: 1 },
    { id: "sub_spending_dining", bucket: "spending", name: "Dining out", ratio: 0.312, sortOrder: 2 },
    { id: "sub_spending_fun", bucket: "spending", name: "Fun money", ratio: 0.301, sortOrder: 3 }
];

function getCombinedBucketBalances(userId) {
    const manual = getUserWallet(userId);
    const bank = getUserBankBalances(userId);
    return {
        savings: Math.round(((Number(manual.savings) || 0) + (Number(bank.savings) || 0)) * 100) / 100,
        bills: Math.round(((Number(manual.bills) || 0) + (Number(bank.bills) || 0)) * 100) / 100,
        spending: Math.round((Number(manual.spending) || 0) * 100) / 100
    };
}

function ensureDefaultUserSubcategories(userId) {
    const uid = Number(userId);
    if (!uid) return;
    const existing = stmts.getSubcategoriesByUser.all(uid) || [];
    if (existing.length > 0) return;

    const now = new Date().toISOString();
    const bucketTotals = getCombinedBucketBalances(uid);

    for (const spec of DEFAULT_SUBCATEGORY_SPECS) {
        const bucketBal = Number(bucketTotals[spec.bucket]) || 0;
        const seededAmount = Math.round(bucketBal * spec.ratio * 100) / 100;
        stmts.insertSubcategory.run(
            spec.id,
            uid,
            spec.bucket,
            spec.name,
            seededAmount,
            spec.ratio,
            1, // is_default
            1, // is_ratio_seeded (uses ratio of bucket until user explicitly edits amount)
            "[]",
            spec.sortOrder,
            now,
            now
        );
    }
}

function formatSubcategoryRow(row, bucketTotals) {
    let transactions = [];
    if (row.transactions_json) {
        try {
            const parsed = JSON.parse(row.transactions_json);
            if (Array.isArray(parsed)) transactions = parsed;
        } catch (_) {}
    }

    const bucket = String(row.bucket || "spending").toLowerCase();
    const isRatioSeeded = Boolean(row.is_ratio_seeded);
    let displayAmount = Math.round((Number(row.amount) || 0) * 100) / 100;
    if (isRatioSeeded && row.ratio !== null && row.ratio !== undefined && bucketTotals && bucketTotals[bucket] !== undefined) {
        displayAmount = Math.round((Number(bucketTotals[bucket]) || 0) * Number(row.ratio) * 100) / 100;
    }

    return {
        id: row.id,
        userId: row.user_id,
        bucket,
        name: row.name,
        amount: displayAmount,
        storedAmount: Math.round((Number(row.amount) || 0) * 100) / 100,
        ratio: row.ratio !== null && row.ratio !== undefined ? Number(row.ratio) : null,
        isDefault: Boolean(row.is_default),
        isRatioSeeded,
        transactions,
        sortOrder: Number(row.sort_order) || 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function getUserSubcategories(userId) {
    const uid = Number(userId);
    if (!uid) return { savings: [], bills: [], spending: [] };
    ensureDefaultUserSubcategories(uid);
    const bucketTotals = getCombinedBucketBalances(uid);
    const rows = stmts.getSubcategoriesByUser.all(uid) || [];

    const grouped = { savings: [], bills: [], spending: [] };
    for (const row of rows) {
        const formatted = formatSubcategoryRow(row, bucketTotals);
        if (!grouped[formatted.bucket]) grouped[formatted.bucket] = [];
        grouped[formatted.bucket].push(formatted);
    }
    return grouped;
}

function addUserSubcategory(userId, payload = {}) {
    const uid = Number(userId);
    ensureDefaultUserSubcategories(uid);

    const bucket = String(payload.bucket || payload.category || "").trim().toLowerCase();
    if (bucket !== "savings" && bucket !== "bills" && bucket !== "spending") {
        const err = new Error('Invalid wallet category bucket. Must be "savings", "bills", or "spending".');
        err.status = 400;
        throw err;
    }

    const cleanName = typeof payload.name === "string" ? payload.name.trim() : "";
    if (!cleanName) {
        const err = new Error("Subcategory name cannot be empty.");
        err.status = 400;
        throw err;
    }
    if (cleanName.length > 60) {
        const err = new Error("Subcategory name cannot exceed 60 characters.");
        err.status = 400;
        throw err;
    }

    const rawAmount = payload.amount !== undefined && payload.amount !== null && payload.amount !== "" ? Number(payload.amount) : 0;
    if (isNaN(rawAmount) || rawAmount < 0) {
        const err = new Error("Subcategory amount must be a valid non-negative number.");
        err.status = 400;
        throw err;
    }
    const cleanAmount = Math.round(rawAmount * 100) / 100;

    // Check case-insensitive duplicate name within the same bucket for this user
    const existingRows = stmts.getSubcategoriesByUser.all(uid) || [];
    const duplicate = existingRows.find(
        (r) => String(r.bucket).toLowerCase() === bucket && String(r.name).trim().toLowerCase() === cleanName.toLowerCase()
    );
    if (duplicate) {
        const err = new Error(`A subcategory named "${cleanName}" already exists in ${bucket.charAt(0).toUpperCase() + bucket.slice(1)}.`);
        err.status = 409;
        throw err;
    }

    const now = new Date().toISOString();
    const subId = payload.id && String(payload.id).trim()
        ? String(payload.id).trim()
        : `sub_${bucket}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const transactions = Array.isArray(payload.transactions) ? payload.transactions : [];
    const maxOrder = existingRows
        .filter((r) => String(r.bucket).toLowerCase() === bucket)
        .reduce((m, r) => Math.max(m, Number(r.sort_order) || 0), 0);

    stmts.insertSubcategory.run(
        subId,
        uid,
        bucket,
        cleanName,
        cleanAmount,
        null,
        0,
        0,
        JSON.stringify(transactions),
        maxOrder + 1,
        now,
        now
    );

    const bucketTotals = getCombinedBucketBalances(uid);
    const createdRow = stmts.getSubcategoryById.get(uid, subId);
    return {
        subcategory: formatSubcategoryRow(createdRow, bucketTotals),
        subcategories: getUserSubcategories(uid)
    };
}

function updateUserSubcategory(userId, subcategoryId, payload = {}) {
    const uid = Number(userId);
    ensureDefaultUserSubcategories(uid);

    const subId = String(subcategoryId || payload.id || "").trim();
    if (!subId) {
        const err = new Error("Subcategory ID is required.");
        err.status = 400;
        throw err;
    }

    const existing = stmts.getSubcategoryById.get(uid, subId);
    if (!existing) {
        const err = new Error("Subcategory not found or does not belong to your account.");
        err.status = 404;
        throw err;
    }

    const bucket = String(existing.bucket).toLowerCase();
    const bucketTotals = getCombinedBucketBalances(uid);
    const existingFormatted = formatSubcategoryRow(existing, bucketTotals);

    const cleanName = payload.name !== undefined ? String(payload.name).trim() : existing.name;
    if (!cleanName) {
        const err = new Error("Subcategory name cannot be empty.");
        err.status = 400;
        throw err;
    }
    if (cleanName.length > 60) {
        const err = new Error("Subcategory name cannot exceed 60 characters.");
        err.status = 400;
        throw err;
    }

    // Check case-insensitive duplicate name against OTHER subcategories in the same bucket for this user
    const allUserRows = stmts.getSubcategoriesByUser.all(uid) || [];
    const duplicate = allUserRows.find(
        (r) =>
            r.id !== subId &&
            String(r.bucket).toLowerCase() === bucket &&
            String(r.name).trim().toLowerCase() === cleanName.toLowerCase()
    );
    if (duplicate) {
        const err = new Error(`Another subcategory named "${cleanName}" already exists in ${bucket.charAt(0).toUpperCase() + bucket.slice(1)}.`);
        err.status = 409;
        throw err;
    }

    let nextAmount = existingFormatted.amount;
    let nextIsRatioSeeded = existing.is_ratio_seeded;

    if (payload.amount !== undefined && payload.amount !== null && payload.amount !== "") {
        const parsedAmt = Number(payload.amount);
        if (isNaN(parsedAmt) || parsedAmt < 0) {
            const err = new Error("Subcategory amount must be a valid non-negative number.");
            err.status = 400;
            throw err;
        }
        nextAmount = Math.round(parsedAmt * 100) / 100;
        nextIsRatioSeeded = 0; // User explicitly set or confirmed the subcategory balance
    } else {
        // Preserve current effective balance so renaming a ratio-seeded default subcategory locks in its current balance cleanly
        nextAmount = existingFormatted.amount;
        nextIsRatioSeeded = 0;
    }

    const nextTransactionsJson = Array.isArray(payload.transactions)
        ? JSON.stringify(payload.transactions)
        : existing.transactions_json || "[]";

    const now = new Date().toISOString();
    stmts.updateSubcategory.run(
        cleanName,
        nextAmount,
        nextIsRatioSeeded,
        nextTransactionsJson,
        now,
        uid,
        subId
    );

    const updatedRow = stmts.getSubcategoryById.get(uid, subId);
    return {
        subcategory: formatSubcategoryRow(updatedRow, bucketTotals),
        subcategories: getUserSubcategories(uid)
    };
}

function deleteUserSubcategory(userId, subcategoryId) {
    const uid = Number(userId);
    ensureDefaultUserSubcategories(uid);
    const subId = String(subcategoryId || "").trim();
    const existing = stmts.getSubcategoryById.get(uid, subId);
    if (!existing) {
        const err = new Error("Subcategory not found.");
        err.status = 404;
        throw err;
    }
    stmts.deleteSubcategory.run(uid, subId);
    return {
        deletedId: subId,
        subcategories: getUserSubcategories(uid)
    };
}

// -----------------------------
// PLAID PERSISTENCE & MAPPING
// -----------------------------

function isCheckingAccount(acc) {
    const subtype = String(acc.subtype || "").toLowerCase();
    return subtype === "checking";
}

function isSavingsAccount(acc) {
    const type = String(acc.type || "").toLowerCase();
    const subtype = String(acc.subtype || "").toLowerCase();
    return (
        subtype === "savings" ||
        subtype === "money market" ||
        subtype === "cd" ||
        subtype === "cash management" ||
        (type === "depository" && subtype !== "checking")
    );
}

function getEffectiveAccountBalance(acc) {
    if (acc.available_balance !== null && acc.available_balance !== undefined && !isNaN(Number(acc.available_balance))) {
        return Math.round(Number(acc.available_balance) * 100) / 100;
    }
    if (acc.current_balance !== null && acc.current_balance !== undefined && !isNaN(Number(acc.current_balance))) {
        return Math.round(Number(acc.current_balance) * 100) / 100;
    }
    return 0;
}

function findPlaidItemByUserAndInstitution(userId, institutionId) {
    if (!userId || !institutionId) return null;
    return stmts.findPlaidItemByUserAndInstitution.get(Number(userId), String(institutionId)) || null;
}

function getPlaidItemByUserAndItemId(userId, itemId) {
    if (!userId || !itemId) return null;
    return stmts.getPlaidItemByUserAndItemId.get(Number(userId), String(itemId)) || null;
}

function getPlaidItemsInternal(userId) {
    if (!userId) return [];
    return stmts.getPlaidItemsByUserInternal.all(Number(userId)) || [];
}

function getPlaidItemsSanitized(userId) {
    const items = getPlaidItemsInternal(userId);
    return items.map((item) => ({
        item_id: item.item_id,
        institution_id: item.institution_id || null,
        institution_name: item.institution_name || "Connected Bank",
        status: item.status,
        created_at: item.created_at,
        updated_at: item.updated_at
    }));
}

function getPlaidAccountsByUser(userId) {
    if (!userId) return [];
    const rows = stmts.getPlaidAccountsByUser.all(Number(userId)) || [];
    return rows.map((row) => ({
        account_id: row.account_id,
        item_id: row.item_id,
        institution_id: row.institution_id || null,
        institution_name: row.institution_name || "Connected Bank",
        name: row.name,
        official_name: row.official_name || null,
        mask: row.mask || null,
        type: row.type,
        subtype: row.subtype || null,
        available_balance: row.available_balance !== null && row.available_balance !== undefined ? Number(row.available_balance) : null,
        current_balance: row.current_balance !== null && row.current_balance !== undefined ? Number(row.current_balance) : null,
        effective_balance: getEffectiveAccountBalance(row),
        iso_currency_code: row.iso_currency_code || "USD",
        mapped_category: row.mapped_category || "none",
        eligible_category: isCheckingAccount(row) ? "bills" : (isSavingsAccount(row) ? "savings" : "none"),
        updated_at: row.updated_at
    }));
}

function savePlaidItemAndAccounts(userId, itemData, plaidAccounts) {
    const uid = Number(userId);
    const now = new Date().toISOString();

    const existingAccounts = getPlaidAccountsByUser(uid);
    let hasMappedBills = existingAccounts.some((a) => a.mapped_category === "bills");
    let hasMappedSavings = existingAccounts.some((a) => a.mapped_category === "savings");

    stmts.upsertPlaidItem.run(
        uid,
        String(itemData.itemId),
        String(itemData.accessToken),
        itemData.institutionId ? String(itemData.institutionId) : null,
        itemData.institutionName ? String(itemData.institutionName) : "Connected Financial Institution",
        "active",
        now,
        now
    );

    if (Array.isArray(plaidAccounts)) {
        for (const acc of plaidAccounts) {
            const existingAcc = stmts.getPlaidAccountByAccountId.get(String(acc.account_id));
            let mappedCategory = "none";

            if (existingAcc && existingAcc.user_id === uid && existingAcc.mapped_category) {
                mappedCategory = existingAcc.mapped_category;
            } else {
                // Auto-map the first checking account to 'bills' and first savings account to 'savings'
                // only if the user does not already have an account mapped to that category.
                const accObj = {
                    type: acc.type,
                    subtype: acc.subtype
                };
                if (isCheckingAccount(accObj) && !hasMappedBills) {
                    mappedCategory = "bills";
                    hasMappedBills = true;
                } else if (String(acc.subtype || "").toLowerCase() === "savings" && !hasMappedSavings) {
                    mappedCategory = "savings";
                    hasMappedSavings = true;
                }
            }

            const avail = acc.balances && acc.balances.available !== null && acc.balances.available !== undefined
                ? Number(acc.balances.available)
                : null;
            const curr = acc.balances && acc.balances.current !== null && acc.balances.current !== undefined
                ? Number(acc.balances.current)
                : null;
            const currency = (acc.balances && acc.balances.iso_currency_code) || "USD";

            stmts.upsertPlaidAccount.run(
                uid,
                String(itemData.itemId),
                String(acc.account_id),
                String(acc.name || "Bank Account"),
                acc.official_name ? String(acc.official_name) : null,
                acc.mask ? String(acc.mask) : null,
                String(acc.type || "depository"),
                acc.subtype ? String(acc.subtype) : null,
                avail,
                curr,
                currency,
                mappedCategory,
                now
            );
        }
    }

    return getPlaidAccountsByUser(uid);
}

function updatePlaidAccountBalances(userId, itemId, plaidAccounts) {
    const uid = Number(userId);
    const now = new Date().toISOString();

    if (!Array.isArray(plaidAccounts)) return getPlaidAccountsByUser(uid);

    for (const acc of plaidAccounts) {
        const existingAcc = stmts.getPlaidAccountByAccountId.get(String(acc.account_id));
        const mappedCategory = existingAcc && existingAcc.user_id === uid
            ? existingAcc.mapped_category
            : "none";

        const avail = acc.balances && acc.balances.available !== null && acc.balances.available !== undefined
            ? Number(acc.balances.available)
            : null;
        const curr = acc.balances && acc.balances.current !== null && acc.balances.current !== undefined
            ? Number(acc.balances.current)
            : null;
        const currency = (acc.balances && acc.balances.iso_currency_code) || "USD";

        stmts.upsertPlaidAccount.run(
            uid,
            String(itemId),
            String(acc.account_id),
            String(acc.name || "Bank Account"),
            acc.official_name ? String(acc.official_name) : null,
            acc.mask ? String(acc.mask) : null,
            String(acc.type || "depository"),
            acc.subtype ? String(acc.subtype) : null,
            avail,
            curr,
            currency,
            mappedCategory,
            now
        );
    }

    return getPlaidAccountsByUser(uid);
}

function updatePlaidAccountMappings(userId, payload) {
    const uid = Number(userId);
    const userAccounts = getPlaidAccountsByUser(uid);
    const accountById = new Map(userAccounts.map((a) => [a.account_id, a]));

    // Normalize input into a map of account_id -> targetCategory ('bills' | 'savings' | 'none')
    const desiredMappings = new Map();

    if (payload && payload.mappings && typeof payload.mappings === "object" && !Array.isArray(payload.mappings)) {
        for (const [accId, cat] of Object.entries(payload.mappings)) {
            desiredMappings.set(String(accId), String(cat || "none").toLowerCase());
        }
    } else if (payload && ("billsAccountId" in payload || "savingsAccountId" in payload || "billsAccountIds" in payload || "savingsAccountIds" in payload)) {
        // Initialize all user accounts to 'none' before applying category selections
        for (const acc of userAccounts) {
            desiredMappings.set(acc.account_id, "none");
        }

        const billsIds = Array.isArray(payload.billsAccountIds)
            ? payload.billsAccountIds
            : (payload.billsAccountId ? [payload.billsAccountId] : []);
        const savingsIds = Array.isArray(payload.savingsAccountIds)
            ? payload.savingsAccountIds
            : (payload.savingsAccountId ? [payload.savingsAccountId] : []);

        for (const id of billsIds) {
            if (id && id !== "none") {
                desiredMappings.set(String(id), "bills");
            }
        }
        for (const id of savingsIds) {
            if (id && id !== "none") {
                if (desiredMappings.get(String(id)) === "bills") {
                    const err = new Error("The same bank account cannot be mapped to both Bills and Savings.");
                    err.status = 400;
                    throw err;
                }
                desiredMappings.set(String(id), "savings");
            }
        }
    } else {
        const err = new Error("Invalid account mapping payload.");
        err.status = 400;
        throw err;
    }

    // Validate ownership and category compatibility
    for (const [accId, targetCat] of desiredMappings.entries()) {
        const acc = accountById.get(accId);
        if (!acc) {
            const err = new Error("Account not found or does not belong to the signed-in user.");
            err.status = 403;
            throw err;
        }

        if (targetCat === "spending") {
            const err = new Error("Bank accounts cannot be mapped to Spending. FundIQ Spending remains your discretionary balance.");
            err.status = 400;
            throw err;
        }

        if (targetCat !== "bills" && targetCat !== "savings" && targetCat !== "none") {
            const err = new Error(`Invalid mapping category "${targetCat}". Allowed values are "bills", "savings", or "none".`);
            err.status = 400;
            throw err;
        }

        if (targetCat === "bills" && !isCheckingAccount(acc)) {
            const err = new Error(`Account "${acc.name}" (${acc.subtype || acc.type}) cannot be mapped to Bills / Checking. Only checking accounts map to Bills.`);
            err.status = 400;
            throw err;
        }

        if (targetCat === "savings" && !isSavingsAccount(acc)) {
            const err = new Error(`Account "${acc.name}" (${acc.subtype || acc.type}) cannot be mapped to Rainy Day / Savings. Only savings accounts map to Savings.`);
            err.status = 400;
            throw err;
        }
    }

    const now = new Date().toISOString();
    for (const [accId, targetCat] of desiredMappings.entries()) {
        stmts.updatePlaidAccountMapping.run(targetCat, now, uid, accId);
    }

    return getPlaidAccountsByUser(uid);
}

function getUserBankBalances(userId) {
    const uid = Number(userId);
    const items = getPlaidItemsSanitized(uid);
    const accounts = getPlaidAccountsByUser(uid);

    let bankBills = 0;
    let bankSavings = 0;
    let mappedBillsCount = 0;
    let mappedSavingsCount = 0;
    let lastUpdated = null;

    // Deduplicate by account_id AND by institution+subtype+mask+name signature
    // so the same money is never added twice even if multiple accounts are connected.
    const seenAccountIds = new Set();
    const seenSignatures = new Set();

    for (const acc of accounts) {
        if (acc.updated_at && (!lastUpdated || acc.updated_at > lastUpdated)) {
            lastUpdated = acc.updated_at;
        }

        if (acc.mapped_category !== "bills" && acc.mapped_category !== "savings") {
            continue;
        }

        if (seenAccountIds.has(acc.account_id)) {
            continue;
        }

        const signature = `${acc.institution_id || acc.item_id}:${String(acc.subtype || "").toLowerCase()}:${String(acc.mask || "")}:${String(acc.name || "").toLowerCase()}`;
        if (seenSignatures.has(signature)) {
            continue;
        }

        seenAccountIds.add(acc.account_id);
        seenSignatures.add(signature);

        const bal = getEffectiveAccountBalance(acc);
        if (acc.mapped_category === "bills" && isCheckingAccount(acc)) {
            bankBills = Math.round((bankBills + bal) * 100) / 100;
            mappedBillsCount++;
        } else if (acc.mapped_category === "savings" && isSavingsAccount(acc)) {
            bankSavings = Math.round((bankSavings + bal) * 100) / 100;
            mappedSavingsCount++;
        }
    }

    return {
        bills: bankBills,
        spending: 0,
        savings: bankSavings,
        total: Math.round((bankBills + bankSavings) * 100) / 100,
        connected: items.length > 0,
        institutionCount: items.length,
        accountCount: accounts.length,
        mappedBillsCount,
        mappedSavingsCount,
        lastUpdated
    };
}

function getFullWalletSummary(userId) {
    const manual = getUserWallet(userId);
    const bank = getUserBankBalances(userId);
    const combinedBills = Math.round((manual.bills + bank.bills) * 100) / 100;
    const combinedSpending = Math.round(manual.spending * 100) / 100;
    const combinedSavings = Math.round((manual.savings + bank.savings) * 100) / 100;
    const combinedTotal = Math.round((combinedBills + combinedSpending + combinedSavings) * 100) / 100;
    const subcategories = getUserSubcategories(userId);
    const detectedBills = getDetectedBillsByUser(userId).filter((b) => b.status !== "dismissed");

    return {
        wallet: manual,
        manualWallet: manual,
        bankBalances: bank,
        combinedWallet: {
            bills: combinedBills,
            spending: combinedSpending,
            savings: combinedSavings,
            total: combinedTotal
        },
        subcategories,
        detectedBills
    };
}

function removePlaidItem(userId, itemId) {
    const uid = Number(userId);
    const iid = String(itemId);
    stmts.deletePlaidTransactionsByItem.run(uid, iid);
    stmts.deletePlaidAccountsByItem.run(uid, iid);
    const res = stmts.deletePlaidItemByUserAndItemId.run(uid, iid);
    return res.changes > 0;
}

// -----------------------------
// PLAID TRANSACTIONS & RECURRING BILL DETECTION / PREDICTION
// -----------------------------

function updatePlaidItemCursor(userId, itemId, cursor) {
    const now = new Date().toISOString();
    stmts.updatePlaidItemCursor.run(String(cursor || ""), now, Number(userId), String(itemId));
}

function savePlaidTransactions(userId, itemId, addedOrModifiedTxs = [], removedTxIds = []) {
    const uid = Number(userId);
    const iid = String(itemId || "plaid_item");
    const now = new Date().toISOString();

    if (Array.isArray(removedTxIds)) {
        for (const rem of removedTxIds) {
            const txId = typeof rem === "string" ? rem : rem && rem.transaction_id;
            if (txId) {
                stmts.deletePlaidTransactionById.run(uid, String(txId));
            }
        }
    }

    let savedCount = 0;
    if (Array.isArray(addedOrModifiedTxs)) {
        for (const tx of addedOrModifiedTxs) {
            if (!tx || !tx.transaction_id || !tx.date) continue;
            const pfc = tx.personal_finance_category || {};
            const catPrimary = pfc.primary || (Array.isArray(tx.category) && tx.category[0]) || null;
            const catDetailed = pfc.detailed || (Array.isArray(tx.category) && tx.category.join(" > ")) || null;

            stmts.upsertPlaidTransaction.run(
                uid,
                iid,
                String(tx.account_id || ""),
                String(tx.transaction_id),
                String(tx.name || tx.merchant_name || "Transaction"),
                tx.merchant_name ? String(tx.merchant_name) : null,
                Number(tx.amount) || 0,
                String(tx.iso_currency_code || "USD"),
                String(tx.date),
                tx.authorized_date ? String(tx.authorized_date) : null,
                tx.pending ? 1 : 0,
                catPrimary ? String(catPrimary) : null,
                catDetailed ? String(catDetailed) : null,
                tx.payment_channel ? String(tx.payment_channel) : null,
                now,
                now
            );
            savedCount++;
        }
    }

    return savedCount;
}

function getUserPlaidTransactions(userId, limit = 100) {
    const uid = Number(userId);
    if (!uid) return [];
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const rows = stmts.getPlaidTransactionsByUser.all(uid, safeLimit) || [];
    return rows.map((r) => ({
        transaction_id: r.transaction_id,
        item_id: r.item_id,
        account_id: r.account_id,
        account_name: r.account_name || "Connected Bank Account",
        account_mask: r.account_mask || null,
        account_subtype: r.account_subtype || null,
        institution_name: r.institution_name || "Connected Bank",
        name: r.name,
        merchant_name: r.merchant_name || r.name,
        amount: Math.round((Number(r.amount) || 0) * 100) / 100,
        iso_currency_code: r.iso_currency_code || "USD",
        date: r.date,
        authorized_date: r.authorized_date || null,
        pending: Boolean(r.pending),
        record_type: r.pending ? "pending_transaction" : "verified_transaction",
        category_primary: r.category_primary || null,
        category_detailed: r.category_detailed || null,
        payment_channel: r.payment_channel || null,
        updated_at: r.updated_at
    }));
}

function normalizeMerchantKey(tx) {
    const raw = String(tx.merchant_name || tx.name || "")
        .toLowerCase()
        .replace(/\b(autopay|auto pay|bill pay|payment|ach|pos|debit|recurring|online|web|pmt|#\d+|\d{4,})\b/gi, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return raw || String(tx.name || "unknown").toLowerCase().trim();
}

function cleanDisplayBillName(tx) {
    const base = String(tx.merchant_name || tx.name || "Recurring Bill")
        .replace(/\s*#\d+.*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
    return base || "Recurring Bill";
}

function parseUtcDateStr(dateStr) {
    if (!dateStr || typeof dateStr !== "string") return null;
    const parts = dateStr.split("-").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}

function formatUtcDateStr(dt) {
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dt.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function advanceDateByFrequency(dateStr, frequency, anchorDay = null) {
    const dt = parseUtcDateStr(dateStr);
    if (!dt) return dateStr;
    const freq = String(frequency || "monthly").toLowerCase();

    if (freq === "weekly") {
        dt.setUTCDate(dt.getUTCDate() + 7);
        return formatUtcDateStr(dt);
    }
    if (freq === "biweekly") {
        dt.setUTCDate(dt.getUTCDate() + 14);
        return formatUtcDateStr(dt);
    }
    if (freq === "yearly") {
        const targetYear = dt.getUTCFullYear() + 1;
        const month = dt.getUTCMonth();
        const maxDay = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
        const day = Math.min(anchorDay || dt.getUTCDate(), maxDay);
        return formatUtcDateStr(new Date(Date.UTC(targetYear, month, day)));
    }
    // Default: monthly
    let targetYear = dt.getUTCFullYear();
    let targetMonth = dt.getUTCMonth() + 1;
    if (targetMonth > 11) {
        targetMonth = 0;
        targetYear++;
    }
    const maxDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const day = Math.min(anchorDay || dt.getUTCDate(), maxDay);
    return formatUtcDateStr(new Date(Date.UTC(targetYear, targetMonth, day)));
}

function computeNextPredictedDueDate(lastPaidDateStr, frequency, referenceDateInput = null) {
    const lastDt = parseUtcDateStr(lastPaidDateStr);
    if (!lastDt) return lastPaidDateStr;
    const anchorDay = lastDt.getUTCDate();

    let nextDateStr = advanceDateByFrequency(lastPaidDateStr, frequency, anchorDay);
    if (!referenceDateInput) return nextDateStr;

    const refStr =
        typeof referenceDateInput === "string" && /^\d{4}-\d{2}-\d{2}$/.test(referenceDateInput)
            ? referenceDateInput
            : formatUtcDateStr(new Date(referenceDateInput));
    const refDt = parseUtcDateStr(refStr);
    if (!refDt) return nextDateStr;

    let guard = 0;
    while (parseUtcDateStr(nextDateStr) < refDt && guard < 120) {
        nextDateStr = advanceDateByFrequency(nextDateStr, frequency, anchorDay);
        guard++;
    }
    return nextDateStr;
}

function classifyRecurrenceIntervals(intervalsDays) {
    if (!Array.isArray(intervalsDays) || intervalsDays.length === 0) return null;

    const allWeekly = intervalsDays.every((d) => d >= 5 && d <= 9);
    if (allWeekly) return "weekly";

    const allBiweekly = intervalsDays.every((d) => d >= 12 && d <= 17);
    if (allBiweekly) return "biweekly";

    const allMonthly = intervalsDays.every((d) => d >= 25 && d <= 35);
    if (allMonthly) return "monthly";

    const allYearly = intervalsDays.every((d) => d >= 350 && d <= 380);
    if (allYearly) return "yearly";

    return null;
}

function formatDetectedBillRow(row) {
    let sourceTxIds = [];
    if (row.source_transaction_ids_json) {
        try {
            const parsed = JSON.parse(row.source_transaction_ids_json);
            if (Array.isArray(parsed)) sourceTxIds = parsed;
        } catch (_) {}
    }

    return {
        id: row.id,
        userId: row.user_id,
        billKey: row.bill_key,
        accountId: row.account_id || null,
        accountName: row.account_name || "Connected Bank Account",
        account_name: row.account_name || "Connected Bank Account",
        merchantName: row.merchant_name,
        displayName: row.display_name,
        name: row.display_name,
        expectedAmount: Math.round((Number(row.expected_amount) || 0) * 100) / 100,
        amount: Math.round((Number(row.expected_amount) || 0) * 100) / 100,
        frequency: row.frequency,
        recurrence: row.frequency,
        lastPaidDate: row.last_paid_date,
        last_paid_date: row.last_paid_date,
        lastPaidAmount: Math.round((Number(row.last_paid_amount) || 0) * 100) / 100,
        nextDueDate: row.next_due_date,
        next_due_date: row.next_due_date,
        occurrenceCount: Number(row.occurrence_count) || 2,
        confidence: row.confidence || "high",
        walletCategory: row.wallet_category || "bills",
        category: row.wallet_category || "bills",
        status: row.status || "predicted",
        isPredicted: row.status !== "confirmed",
        is_predicted: row.status !== "confirmed",
        recordType: "predicted_future_payment",
        userModified: Boolean(row.user_modified),
        calendarTemplateId: row.calendar_template_id || null,
        sourceTransactionIds: sourceTxIds,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function getDetectedBillsByUser(userId) {
    const uid = Number(userId);
    if (!uid) return [];
    const rows = stmts.getDetectedBillsByUser.all(uid) || [];
    return rows.map(formatDetectedBillRow);
}

/**
 * Analyze confirmed Plaid transactions for recurring bills, upsert detected_bills,
 * and insert/update predicted payment templates in user_payments without overwriting
 * user-modified or dismissed predictions or fabricating transactions.
 */
function detectAndPredictRecurringBills(userId, referenceDateInput = null) {
    const uid = Number(userId);
    if (!uid) return { detectedBills: [], activePredictions: [] };

    const confirmedTxs = stmts.getConfirmedOutflowTransactionsByUser.all(uid) || [];
    const groups = new Map();

    for (const tx of confirmedTxs) {
        // Ignore internal transfers or credit card payments that aren't recurring merchant bills if needed,
        // or group by account + normalized merchant key
        const normMerchant = normalizeMerchantKey(tx);
        if (!normMerchant || normMerchant.length < 2) continue;

        const groupKey = `${tx.account_id || "default"}::${normMerchant}`;
        if (!groups.has(groupKey)) {
            groups.set(groupKey, []);
        }
        groups.get(groupKey).push(tx);
    }

    const now = new Date().toISOString();

    for (const [billKey, rawList] of groups.entries()) {
        // Sort ascending by date
        rawList.sort((a, b) => String(a.date).localeCompare(String(b.date)));

        // Deduplicate same-date transactions in the same group
        const uniqueDatesList = [];
        for (const item of rawList) {
            const prev = uniqueDatesList[uniqueDatesList.length - 1];
            if (!prev || prev.date !== item.date) {
                uniqueDatesList.push(item);
            }
        }

        // Require at least 2 confirmed occurrences on distinct dates
        if (uniqueDatesList.length < 2) {
            continue;
        }

        const intervals = [];
        let validDates = true;
        for (let i = 1; i < uniqueDatesList.length; i++) {
            const dPrev = parseUtcDateStr(uniqueDatesList[i - 1].date);
            const dCurr = parseUtcDateStr(uniqueDatesList[i].date);
            if (!dPrev || !dCurr) {
                validDates = false;
                break;
            }
            const diffDays = Math.round((dCurr.getTime() - dPrev.getTime()) / (24 * 60 * 60 * 1000));
            intervals.push(diffDays);
        }
        if (!validDates) continue;

        const detectedFreq = classifyRecurrenceIntervals(intervals);
        if (!detectedFreq) {
            // Erratic intervals -> do NOT create a recurring prediction
            continue;
        }

        // Check amount consistency (prevent wildly erratic one-off purchases from being treated as recurring bills)
        const amounts = uniqueDatesList.map((t) => Number(t.amount) || 0);
        const avgAmount = amounts.reduce((s, v) => s + v, 0) / amounts.length;
        if (avgAmount <= 0) continue;

        const maxDeviationRatio = Math.max(...amounts.map((a) => Math.abs(a - avgAmount) / avgAmount));
        if (maxDeviationRatio > 0.35) {
            // Amounts vary by more than 35% from average -> erratic, skip automatic bill prediction
            continue;
        }

        const latestTx = uniqueDatesList[uniqueDatesList.length - 1];
        const expectedAmount = Math.round(Number(latestTx.amount) * 100) / 100;
        const lastPaidDate = String(latestTx.date);
        const lastPaidAmount = expectedAmount;
        const nextDueDate = computeNextPredictedDueDate(lastPaidDate, detectedFreq, referenceDateInput);
        const displayName = cleanDisplayBillName(latestTx);
        const accountName = latestTx.account_name
            ? `${latestTx.institution_name ? latestTx.institution_name + " • " : ""}${latestTx.account_name}${latestTx.account_mask ? " (••••" + latestTx.account_mask + ")" : ""}`
            : "Connected Checking Account";
        const sourceTxIdsJson = JSON.stringify(uniqueDatesList.map((t) => t.transaction_id));
        const confidence = uniqueDatesList.length >= 3 && maxDeviationRatio <= 0.1 ? "high" : "medium";

        const existingBill = stmts.getDetectedBillByKey.get(uid, billKey);
        if (!existingBill) {
            const tplId = `pred_${uid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            stmts.insertDetectedBill.run(
                uid,
                billKey,
                latestTx.account_id || null,
                accountName,
                displayName,
                displayName,
                expectedAmount,
                detectedFreq,
                lastPaidDate,
                lastPaidAmount,
                nextDueDate,
                uniqueDatesList.length,
                confidence,
                "bills",
                "predicted",
                0,
                tplId,
                sourceTxIdsJson,
                now,
                now
            );
        } else if (Boolean(existingBill.user_modified) || existingBill.status === "dismissed") {
            // Respect user edits & dismissals: only update verified history stats, NEVER overwrite name/amount/due date/status
            stmts.updateDetectedBillHistoryOnly.run(
                lastPaidDate,
                lastPaidAmount,
                uniqueDatesList.length,
                sourceTxIdsJson,
                now,
                uid,
                existingBill.id
            );
        } else {
            const tplId = existingBill.calendar_template_id || `pred_${uid}_${existingBill.id}`;
            stmts.updateDetectedBillAuto.run(
                latestTx.account_id || existingBill.account_id || null,
                accountName,
                expectedAmount,
                detectedFreq,
                lastPaidDate,
                lastPaidAmount,
                nextDueDate,
                uniqueDatesList.length,
                confidence,
                tplId,
                sourceTxIdsJson,
                now,
                uid,
                existingBill.id
            );
        }
    }

    // Sync active (non-dismissed) detected_bills into user_payments.templates without duplicating
    syncDetectedBillsToCalendar(uid);

    const allBills = getDetectedBillsByUser(uid);
    const activeBills = allBills.filter((b) => b.status !== "dismissed");
    return {
        detectedBills: activeBills,
        allDetectedBills: allBills,
        activePredictions: activeBills
    };
}

function syncDetectedBillsToCalendar(userId) {
    const uid = Number(userId);
    const allDetected = stmts.getDetectedBillsByUser.all(uid) || [];
    const paymentData = getUserPayments(uid);
    const templates = Array.isArray(paymentData.templates) ? [...paymentData.templates] : [];
    const completions = paymentData.completions || {};
    const overrides = paymentData.overrides || {};
    const now = new Date().toISOString();

    let modifiedPayments = false;

    for (const det of allDetected) {
        const tplId = det.calendar_template_id ? String(det.calendar_template_id) : `pred_${uid}_${det.id}`;

        if (det.status === "dismissed") {
            const idx = templates.findIndex(
                (t) => String(t.id) === tplId || (t.billKey && t.billKey === det.bill_key) || (t.detectedBillId && Number(t.detectedBillId) === Number(det.id))
            );
            if (idx !== -1) {
                templates.splice(idx, 1);
                modifiedPayments = true;
            }
            continue;
        }

        // Find existing template by calendar_template_id, billKey, or detectedBillId
        let existingIdx = templates.findIndex(
            (t) =>
                String(t.id) === tplId ||
                (t.billKey && t.billKey === det.bill_key) ||
                (t.detectedBillId && Number(t.detectedBillId) === Number(det.id))
        );

        // Also check if user already has a manual non-predicted template with identical normalized name & recurrence
        if (existingIdx === -1) {
            const normDetName = String(det.display_name || "").trim().toLowerCase();
            const manualMatchIdx = templates.findIndex(
                (t) =>
                    !t.isPredicted &&
                    String(t.title || "").trim().toLowerCase() === normDetName &&
                    String(t.recurrence || "").toLowerCase() === String(det.frequency || "").toLowerCase()
            );
            if (manualMatchIdx !== -1) {
                // Link to existing manual template without creating a duplicate calendar series
                const matchedManual = templates[manualMatchIdx];
                if (det.calendar_template_id !== matchedManual.id) {
                    stmts.updateDetectedBillManual.run(
                        det.display_name,
                        Number(det.expected_amount) || 0,
                        det.frequency,
                        det.next_due_date,
                        det.wallet_category || "bills",
                        det.status,
                        String(matchedManual.id),
                        now,
                        uid,
                        det.id
                    );
                }
                continue;
            }
        }

        const templatePayload = {
            id: tplId,
            title: det.display_name,
            name: det.display_name,
            amount: Math.round((Number(det.expected_amount) || 0) * 100) / 100,
            category: det.wallet_category || "bills",
            startDate: det.next_due_date,
            recurrence: det.frequency || "monthly",
            frequency: det.frequency || "monthly",
            isPredicted: det.status !== "confirmed",
            predictionStatus: det.status || "predicted",
            userModified: Boolean(det.user_modified),
            detectedBillId: det.id,
            billKey: det.bill_key,
            sourceAccountId: det.account_id || null,
            sourceAccountName: det.account_name || "Connected Bank Account",
            lastPaidDate: det.last_paid_date,
            lastPaidAmount: Math.round((Number(det.last_paid_amount) || 0) * 100) / 100
        };

        if (existingIdx === -1) {
            templates.push(templatePayload);
            modifiedPayments = true;
        } else {
            const currentTpl = templates[existingIdx];
            // Only overwrite template fields if not manually modified exclusively in calendar, or sync from detected_bills
            templates[existingIdx] = {
                ...currentTpl,
                ...templatePayload,
                id: currentTpl.id || tplId
            };
            modifiedPayments = true;
        }
    }

    if (modifiedPayments) {
        setUserPayments(uid, { templates, completions, overrides }, { skipDetectedBillSync: true });
    }
}

function updateDetectedBill(userId, billId, updates = {}) {
    const uid = Number(userId);
    const id = Number(billId);
    const existing = stmts.getDetectedBillById.get(uid, id);
    if (!existing) {
        const err = new Error("Detected bill not found.");
        err.status = 404;
        throw err;
    }

    const nextName =
        updates.displayName !== undefined
            ? String(updates.displayName).trim()
            : updates.name !== undefined
            ? String(updates.name).trim()
            : updates.title !== undefined
            ? String(updates.title).trim()
            : existing.display_name;

    if (!nextName) {
        const err = new Error("Bill name cannot be empty.");
        err.status = 400;
        throw err;
    }

    const rawAmt =
        updates.expectedAmount !== undefined
            ? updates.expectedAmount
            : updates.amount !== undefined
            ? updates.amount
            : existing.expected_amount;
    const nextAmt = Number(rawAmt);
    if (isNaN(nextAmt) || nextAmt <= 0) {
        const err = new Error("Bill amount must be greater than $0.00.");
        err.status = 400;
        throw err;
    }

    const nextFreq = String(updates.frequency || updates.recurrence || existing.frequency || "monthly").toLowerCase();
    if (!["none", "weekly", "biweekly", "monthly", "yearly"].includes(nextFreq)) {
        const err = new Error('Invalid recurrence frequency. Allowed: "none", "weekly", "biweekly", "monthly", "yearly".');
        err.status = 400;
        throw err;
    }

    const nextDue = String(updates.nextDueDate || updates.dueDate || updates.startDate || existing.next_due_date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDue) || !parseUtcDateStr(nextDue)) {
        const err = new Error("Valid due date (YYYY-MM-DD) is required.");
        err.status = 400;
        throw err;
    }

    const nextCat = String(updates.walletCategory || updates.category || existing.wallet_category || "bills").toLowerCase();
    if (!["bills", "spending", "savings"].includes(nextCat)) {
        const err = new Error('Invalid wallet category. Allowed: "bills", "spending", "savings".');
        err.status = 400;
        throw err;
    }

    const nextStatus = updates.status === "dismissed" ? "dismissed" : (updates.status || "confirmed");
    const tplId = existing.calendar_template_id || `pred_${uid}_${existing.id}`;
    const now = new Date().toISOString();

    stmts.updateDetectedBillManual.run(
        nextName,
        Math.round(nextAmt * 100) / 100,
        nextFreq,
        nextDue,
        nextCat,
        nextStatus,
        nextStatus === "dismissed" ? null : tplId,
        now,
        uid,
        id
    );

    // Clear any stale occurrence overrides for this template so the new date/amount takes effect cleanly
    if (existing.calendar_template_id) {
        const paymentData = getUserPayments(uid);
        if (paymentData.overrides && typeof paymentData.overrides === "object") {
            for (const key of Object.keys(paymentData.overrides)) {
                if (key.startsWith(`${existing.calendar_template_id}_`)) {
                    delete paymentData.overrides[key];
                }
            }
            setUserPayments(uid, paymentData, { skipDetectedBillSync: true });
        }
    }

    syncDetectedBillsToCalendar(uid);

    const updatedRow = stmts.getDetectedBillById.get(uid, id);
    const allBills = getDetectedBillsByUser(uid);
    return {
        bill: formatDetectedBillRow(updatedRow),
        detectedBills: allBills.filter((b) => b.status !== "dismissed"),
        allDetectedBills: allBills,
        payments: getUserPayments(uid)
    };
}

function dismissDetectedBill(userId, billId) {
    const uid = Number(userId);
    const id = Number(billId);
    const existing = stmts.getDetectedBillById.get(uid, id);
    if (!existing) {
        const err = new Error("Detected bill not found.");
        err.status = 404;
        throw err;
    }

    const now = new Date().toISOString();
    stmts.updateDetectedBillManual.run(
        existing.display_name,
        Number(existing.expected_amount) || 0,
        existing.frequency || "monthly",
        existing.next_due_date,
        existing.wallet_category || "bills",
        "dismissed",
        null,
        now,
        uid,
        id
    );

    syncDetectedBillsToCalendar(uid);

    const allBills = getDetectedBillsByUser(uid);
    return {
        dismissedId: id,
        detectedBills: allBills.filter((b) => b.status !== "dismissed"),
        allDetectedBills: allBills,
        payments: getUserPayments(uid)
    };
}

// -----------------------------
// EMAIL & SMS NOTIFICATION PREFS & DEDUPLICATION LOG
// -----------------------------

function getUserNotificationPrefs(userId) {
    const uid = Number(userId);
    const row = stmts.getNotificationPrefs.get(uid);
    if (row) {
        const emailEnabled = Boolean(row.email_enabled);
        const paymentDueEnabled = Boolean(row.payment_due_enabled);
        const depositEnabled = Boolean(row.deposit_enabled);
        const paymentSubmittedEnabled = Boolean(row.payment_submitted_enabled);
        const reminderDaysBefore = Number.isFinite(Number(row.reminder_days_before))
            ? Math.max(0, Math.min(30, Number(row.reminder_days_before)))
            : 3;
        const smsEnabled = Boolean(row.sms_enabled);
        const phoneNumber = row.phone_number ? String(row.phone_number).trim() : "";
        const smsPaymentDueEnabled = row.sms_payment_due_enabled !== undefined ? Boolean(row.sms_payment_due_enabled) : true;
        const smsDepositEnabled = row.sms_deposit_enabled !== undefined ? Boolean(row.sms_deposit_enabled) : true;
        const smsPaymentSubmittedEnabled = row.sms_payment_submitted_enabled !== undefined ? Boolean(row.sms_payment_submitted_enabled) : true;

        return {
            userId: uid,
            emailEnabled,
            paymentDueEnabled,
            notifyPaymentDue: paymentDueEnabled,
            depositEnabled,
            notifyDepositMade: depositEnabled,
            paymentSubmittedEnabled,
            notifyPaymentSubmitted: paymentSubmittedEnabled,
            reminderDaysBefore,
            smsEnabled,
            phoneNumber,
            smsPaymentDueEnabled,
            smsDepositEnabled,
            smsPaymentSubmittedEnabled,
            updatedAt: row.updated_at
        };
    }
    return {
        userId: uid,
        emailEnabled: true,
        paymentDueEnabled: true,
        notifyPaymentDue: true,
        depositEnabled: true,
        notifyDepositMade: true,
        paymentSubmittedEnabled: true,
        notifyPaymentSubmitted: true,
        reminderDaysBefore: 3,
        smsEnabled: false,
        phoneNumber: "",
        smsPaymentDueEnabled: true,
        smsDepositEnabled: true,
        smsPaymentSubmittedEnabled: true,
        updatedAt: null
    };
}

function setUserNotificationPrefs(userId, prefs = {}) {
    const uid = Number(userId);
    const current = getUserNotificationPrefs(uid);
    const now = new Date().toISOString();

    const emailEnabled = prefs.emailEnabled !== undefined ? Boolean(prefs.emailEnabled) : current.emailEnabled;
    const rawDue = prefs.paymentDueEnabled !== undefined ? prefs.paymentDueEnabled : prefs.notifyPaymentDue;
    const paymentDueEnabled = rawDue !== undefined ? Boolean(rawDue) : current.paymentDueEnabled;

    const rawDep = prefs.depositEnabled !== undefined ? prefs.depositEnabled : prefs.notifyDepositMade;
    const depositEnabled = rawDep !== undefined ? Boolean(rawDep) : current.depositEnabled;

    const rawSub = prefs.paymentSubmittedEnabled !== undefined ? prefs.paymentSubmittedEnabled : prefs.notifyPaymentSubmitted;
    const paymentSubmittedEnabled = rawSub !== undefined ? Boolean(rawSub) : current.paymentSubmittedEnabled;

    let reminderDaysBefore = current.reminderDaysBefore;
    if (prefs.reminderDaysBefore !== undefined && !isNaN(Number(prefs.reminderDaysBefore))) {
        reminderDaysBefore = Math.max(0, Math.min(30, Math.round(Number(prefs.reminderDaysBefore))));
    }

    const smsEnabled = prefs.smsEnabled !== undefined ? Boolean(prefs.smsEnabled) : current.smsEnabled;
    const phoneNumber = prefs.phoneNumber !== undefined ? String(prefs.phoneNumber || "").trim() : current.phoneNumber;
    const smsPaymentDueEnabled =
        prefs.smsPaymentDueEnabled !== undefined ? Boolean(prefs.smsPaymentDueEnabled) : current.smsPaymentDueEnabled;
    const smsDepositEnabled =
        prefs.smsDepositEnabled !== undefined ? Boolean(prefs.smsDepositEnabled) : current.smsDepositEnabled;
    const smsPaymentSubmittedEnabled =
        prefs.smsPaymentSubmittedEnabled !== undefined
            ? Boolean(prefs.smsPaymentSubmittedEnabled)
            : current.smsPaymentSubmittedEnabled;

    stmts.upsertNotificationPrefs.run(
        uid,
        emailEnabled ? 1 : 0,
        paymentDueEnabled ? 1 : 0,
        depositEnabled ? 1 : 0,
        paymentSubmittedEnabled ? 1 : 0,
        reminderDaysBefore,
        smsEnabled ? 1 : 0,
        phoneNumber,
        smsPaymentDueEnabled ? 1 : 0,
        smsDepositEnabled ? 1 : 0,
        smsPaymentSubmittedEnabled ? 1 : 0,
        now
    );

    return getUserNotificationPrefs(uid);
}

function findEmailNotificationByEventKey(userId, eventKey) {
    if (!userId || !eventKey) return null;
    return stmts.findNotificationByEventKey.get(Number(userId), String(eventKey)) || null;
}

function recordEmailNotification({
    userId,
    eventKey,
    eventType,
    recipientEmail,
    subject,
    status,
    provider = null,
    messageId = null,
    errorMessage = null,
    metadata = null,
    bodyText = null,
    bodyHtml = null,
    attempts = 1,
    sentAt = null
}) {
    const uid = Number(userId);
    const key = String(eventKey);
    const now = new Date().toISOString();
    const existing = findEmailNotificationByEventKey(uid, key);

    if (existing) {
        stmts.updateEmailNotification.run(
            String(status),
            provider ? String(provider) : existing.provider,
            messageId ? String(messageId) : existing.message_id,
            errorMessage ? String(errorMessage) : null,
            Number(attempts) || (Number(existing.attempts) + 1),
            sentAt || existing.sent_at,
            existing.id
        );
        return findEmailNotificationByEventKey(uid, key);
    }

    stmts.insertEmailNotification.run(
        uid,
        key,
        String(eventType),
        String(recipientEmail),
        String(subject),
        String(status),
        provider ? String(provider) : null,
        messageId ? String(messageId) : null,
        errorMessage ? String(errorMessage) : null,
        metadata ? JSON.stringify(metadata) : null,
        bodyText ? String(bodyText) : null,
        bodyHtml ? String(bodyHtml) : null,
        Number(attempts) || 1,
        now,
        sentAt
    );

    return findEmailNotificationByEventKey(uid, key);
}

function getUserEmailNotifications(userId, limit = 25) {
    if (!userId) return [];
    const rows = stmts.getUserNotifications.all(Number(userId), Math.max(1, Math.min(100, Number(limit) || 25))) || [];
    return rows.map((row) => {
        let metadata = null;
        if (row.metadata_json) {
            try { metadata = JSON.parse(row.metadata_json); } catch (_) {}
        }
        return {
            id: row.id,
            userId: row.user_id,
            eventKey: row.event_key,
            eventType: row.event_type,
            recipientEmail: row.recipient_email,
            subject: row.subject,
            status: row.status,
            provider: row.provider,
            messageId: row.message_id,
            errorMessage: row.error_message,
            metadata,
            attempts: row.attempts,
            createdAt: row.created_at,
            sentAt: row.sent_at
        };
    });
}

function getAllUsers() {
    return stmts.getAllUsers.all() || [];
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
    setUserPayments,
    getUserSubcategories,
    addUserSubcategory,
    updateUserSubcategory,
    deleteUserSubcategory,
    findPlaidItemByUserAndInstitution,
    getPlaidItemByUserAndItemId,
    getPlaidItemsInternal,
    getPlaidItemsSanitized,
    getPlaidAccountsByUser,
    savePlaidItemAndAccounts,
    updatePlaidAccountBalances,
    updatePlaidAccountMappings,
    getUserBankBalances,
    getFullWalletSummary,
    removePlaidItem,
    updatePlaidItemCursor,
    savePlaidTransactions,
    getUserPlaidTransactions,
    detectAndPredictRecurringBills,
    getDetectedBillsByUser,
    updateDetectedBill,
    dismissDetectedBill,
    getUserNotificationPrefs,
    setUserNotificationPrefs,
    findEmailNotificationByEventKey,
    recordEmailNotification,
    getUserEmailNotifications,
    getAllUsers
};

