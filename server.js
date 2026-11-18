const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const OpenAI = require("openai");
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require("plaid");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const db = require("./db");
const emailService = require("./emailService");
const {
    ASSISTANT_IDENTITY,
    SUGGESTED_PROMPTS,
    INFORMATIONAL_DISCLAIMER,
    SYSTEM_PROMPT,
    buildTrustedSourcesContext,
    getHonestFallbackResponse
} = require("./assistantKnowledge");

const app = express();

const PORT = Number(process.env.PORT) || 3000;


// -----------------------------
// OPENAI CONNECTION
// -----------------------------

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

function isOpenAIConfigured() {
    return Boolean(
        process.env.OPENAI_API_KEY &&
        process.env.OPENAI_API_KEY.trim()
    );
}


// -----------------------------
// PLAID CONNECTION (SANDBOX)
// -----------------------------

function getPlaidEnvName() {
    const raw = (process.env.PLAID_ENV || "sandbox").trim().toLowerCase();
    return PlaidEnvironments[raw] ? raw : "sandbox";
}

const PLAID_ENV = getPlaidEnvName();

function getPlaidClient() {
    const envName = getPlaidEnvName();
    const basePath = PlaidEnvironments[envName] || PlaidEnvironments.sandbox;
    const cfg = new Configuration({
        basePath,
        baseOptions: {
            headers: {
                "PLAID-CLIENT-ID": (process.env.PLAID_CLIENT_ID || "").trim(),
                "PLAID-SECRET": (process.env.PLAID_SECRET || "").trim(),
                "Plaid-Version": "2020-09-14"
            }
        }
    });
    return new PlaidApi(cfg);
}

const plaidClient = getPlaidClient();

function isPlaidConfigured() {
    return Boolean(
        process.env.PLAID_CLIENT_ID &&
        process.env.PLAID_CLIENT_ID.trim() &&
        process.env.PLAID_SECRET &&
        process.env.PLAID_SECRET.trim()
    );
}

function formatPlaidError(err, fallbackMsg) {
    const plaidErr = err && err.response && err.response.data;
    if (plaidErr && typeof plaidErr === "object") {
        return {
            error: plaidErr.display_message || plaidErr.error_message || fallbackMsg,
            error_code: plaidErr.error_code || "PLAID_API_ERROR",
            error_type: plaidErr.error_type || "API_ERROR"
        };
    }
    return {
        error: fallbackMsg,
        error_code: "INTERNAL_ERROR",
        error_type: "SERVER_ERROR"
    };
}


// -----------------------------
// MIDDLEWARE
// -----------------------------

// Localhost development CORS support so requests from localhost or 127.0.0.1 never fail
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    next();
});

app.use(express.json());

app.use(session({
    name: "fundiq.sid",
    secret: process.env.SESSION_SECRET || "fundiq_secure_dev_session_key_9823471029384",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 24 * 60 * 60 * 1000 // 1 day
    }
}));

app.use(express.static(path.join(__dirname, "public")));

app.get("/profile", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "profile.html"));
});

app.get("/wallet", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "wallet.html"));
});


// -----------------------------
// TEST ROUTE
// -----------------------------

app.get("/api/test", (req, res) => {

    res.json({
        message: "FundIQ server is working!"
    });

});


// -----------------------------
// AI ALLOCATION ROUTE
// -----------------------------

app.post("/api/allocate", async (req, res) => {
    try {
        const { amountReceived, bills, savingsGoal } = req.body;

        // Validate input
        if (
            typeof amountReceived !== "number" ||
            typeof bills !== "number" ||
            typeof savingsGoal !== "number"
        ) {
            return res.status(400).json({
                error: "Please enter valid numbers."
            });
        }

        if (amountReceived <= 0) {
            return res.status(400).json({
                error: "The amount received must be greater than $0."
            });
        }

        if (bills < 0 || savingsGoal < 0) {
            return res.status(400).json({
                error: "Bills and savings goals cannot be negative."
            });
        }

        if (bills + savingsGoal > amountReceived) {
            return res.status(400).json({
                error: "Your bills and savings goal are greater than the money received."
            });
        }


        // ------------------------------------------------
        // TRY OPENAI
        // ------------------------------------------------

        try {

            const prompt = `
You are FundIQ, an AI-powered financial organization assistant.

The user received $${amountReceived.toFixed(2)}.

Their upcoming bills total $${bills.toFixed(2)}.

Their savings goal is $${savingsGoal.toFixed(2)}.

Create a suggested allocation into exactly three categories:

1. Bills
2. Spending
3. Savings

Rules:
- Bills should cover the user's provided bills.
- Savings should consider the user's savings goal.
- Spending should be the remaining amount.
- The three amounts must add up exactly to $${amountReceived.toFixed(2)}.
- Explain that this is a suggestion.
- Keep the explanation simple.

Return ONLY valid JSON in this format:

{
    "bills": 0,
    "spending": 0,
    "savings": 0,
    "explanation": "short explanation"
}
`;

            const response = await client.responses.create({
                model: "gpt-5-mini",
                input: prompt
            });

            const aiText = response.output_text;

            const cleanedText = aiText
                .replace(/```json/g, "")
                .replace(/```/g, "")
                .trim();

            const allocation = JSON.parse(cleanedText);

            console.log("FundIQ used OpenAI.");

            return res.json({
                success: true,
                mode: "openai",
                allocation: allocation
            });

        } catch (openAIError) {

            console.log("OpenAI unavailable. Using FundIQ Demo Mode.");

            console.log(
                "OpenAI error:",
                openAIError.message
            );


            // ------------------------------------------------
            // DEMO / MOCK AI MODE
            // ------------------------------------------------

            const demoBills = bills;

            const demoSavings = savingsGoal;

            const demoSpending =
                amountReceived - demoBills - demoSavings;


            const demoAllocation = {

                bills: Number(demoBills.toFixed(2)),

                spending: Number(demoSpending.toFixed(2)),

                savings: Number(demoSavings.toFixed(2)),

                explanation:
                    "This is a FundIQ demo suggestion. " +
                    "Your bills and savings goal were set aside first, " +
                    "and the remaining money was assigned to spending. " +
                    "This is only a suggested organization of your money."
            };


            return res.json({

                success: true,

                mode: "demo",

                allocation: demoAllocation

            });
        }

    } catch (error) {

        console.error("FundIQ server error:", error);

        res.status(500).json({

            success: false,

            error:
                "FundIQ could not create your plan. Please try again."

        });
    }
});


// -----------------------------
// CHATBOT RATE LIMITING
// -----------------------------
const ipRateLimit = new Map();

function isRateLimited(ip) {
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute
    const maxRequests = 30; // max 30 chat messages per minute per IP

    const history = ipRateLimit.get(ip) || [];
    const validHistory = history.filter(time => now - time < windowMs);

    if (validHistory.length >= maxRequests) {
        return true;
    }

    validHistory.push(now);
    ipRateLimit.set(ip, validHistory);
    return false;
}

// Clean up stale rate limit entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [ip, history] of ipRateLimit.entries()) {
        const valid = history.filter(time => now - time < 60000);
        if (valid.length === 0) {
            ipRateLimit.delete(ip);
        } else {
            ipRateLimit.set(ip, valid);
        }
    }
}, 5 * 60 * 1000).unref();


// -----------------------------
// CHATBOT CONFIG & TRUSTED SOURCES ROUTES
// -----------------------------
app.get("/api/chat/config", (req, res) => {
    res.json({
        name: ASSISTANT_IDENTITY.name,
        fullName: ASSISTANT_IDENTITY.fullName,
        role: ASSISTANT_IDENTITY.role,
        disclaimer: INFORMATIONAL_DISCLAIMER,
        suggestedPrompts: SUGGESTED_PROMPTS,
        trustedSources: db.getTrustedFinancialSources()
    });
});

app.get("/api/assistant/sources", (req, res) => {
    const query = req.query.q ? String(req.query.q) : "";
    const sources = query ? db.searchTrustedFinancialSources(query, 10) : db.getTrustedFinancialSources();
    return res.json({
        success: true,
        sources,
        disclaimer: INFORMATIONAL_DISCLAIMER
    });
});


// -----------------------------
// CHATBOT INTERACTION ROUTE (OPENAI + TRUSTED SOURCES)
// -----------------------------
app.post("/api/chat", async (req, res) => {
    try {
        const clientIp = req.ip || req.connection?.remoteAddress || "unknown";

        if (isRateLimited(clientIp)) {
            return res.status(429).json({
                success: false,
                error: "You are sending messages too quickly. Please pause for a moment and try again."
            });
        }

        const { message, history, isGuest } = req.body;

        // Validation
        if (!message || typeof message !== "string" || message.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: "Message cannot be empty."
            });
        }

        if (message.length > 1000) {
            return res.status(400).json({
                success: false,
                error: "Message is too long (maximum 1,000 characters)."
            });
        }

        const sanitizedMessage = message.trim();
        const modelName = process.env.OPENAI_MODEL || "gpt-4o-mini";

        // Build authenticated user financial summary (without exposing raw credentials or unverified bank policies)
        let userFinancialContext = null;
        if (req.session && req.session.userId && !isGuest) {
            const uid = req.session.userId;
            const summary = db.getFullWalletSummary(uid);
            const prefs = db.getUserNotificationPrefs(uid);
            userFinancialContext = [
                `Authenticated user: ${req.session.fullName} (@${req.session.username})`,
                `Combined Wallet Balances — Total: $${summary.combinedWallet.total.toFixed(2)}, Bills: $${summary.combinedWallet.bills.toFixed(2)}, Savings: $${summary.combinedWallet.savings.toFixed(2)}, Spending: $${summary.combinedWallet.spending.toFixed(2)}`,
                `Saved Deposit Allocation Rules: ${prefs.allocationBillsPct}% Bills, ${prefs.allocationSavingsPct}% Savings, ${prefs.allocationSpendingPct}% Spending`
            ].join("\n");
        }

        const { matchedSources, contextBlock } = buildTrustedSourcesContext(sanitizedMessage, userFinancialContext);

        // Try OpenAI Chat Completions
        try {
            if (!process.env.OPENAI_API_KEY) {
                throw new Error("OPENAI_API_KEY is not configured.");
            }

            const messages = [
                { role: "system", content: `${SYSTEM_PROMPT}\n\n${contextBlock}` }
            ];

            // Add authenticated user context or guest boundary
            if (req.session && req.session.userId && !isGuest) {
                messages.push({
                    role: "system",
                    content: `The user is securely authenticated as ${req.session.fullName} (username: @${req.session.username}).`
                });
            } else if (isGuest) {
                messages.push({
                    role: "system",
                    content: "Note: The user is currently on the login or registration page (unauthenticated). Provide general information about FundIQ and do not discuss private account or wallet details."
                });
            }

            // Append sanitized conversation history (limit to last 6 turns)
            if (Array.isArray(history)) {
                for (const item of history.slice(-6)) {
                    if (item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string") {
                        messages.push({
                            role: item.role,
                            content: item.content.slice(0, 1000)
                        });
                    }
                }
            }

            messages.push({
                role: "user",
                content: sanitizedMessage
            });

            const completion = await client.chat.completions.create({
                model: modelName,
                messages: messages,
                max_tokens: 500,
                temperature: 0.7
            });

            let reply = completion.choices[0]?.message?.content?.trim() || "";
            if (!reply.toLowerCase().includes("disclaimer")) {
                reply += `\n\n*${INFORMATIONAL_DISCLAIMER}*`;
            }

            return res.json({
                success: true,
                mode: "openai",
                model: modelName,
                reply: reply,
                sources: matchedSources,
                disclaimer: INFORMATIONAL_DISCLAIMER
            });

        } catch (openAIError) {
            console.log("Penny OpenAI Chat Error:", openAIError.message);

            // Resilient honest fallback mode with trusted sources
            const honestReply = getHonestFallbackResponse(sanitizedMessage, Boolean(isGuest), userFinancialContext);

            return res.json({
                success: true,
                mode: "demo",
                reply: honestReply,
                sources: matchedSources,
                disclaimer: INFORMATIONAL_DISCLAIMER,
                note: "Penny is operating in demo mode due to OpenAI API status.",
                errorDetail: openAIError.status === 429 ? "API quota exceeded" : openAIError.message
            });
        }

    } catch (err) {
        console.error("FundIQ chat server error:", err);
        return res.status(500).json({
            success: false,
            error: "Penny encountered an unexpected error. Please try again."
        });
    }
});


// -----------------------------
// LOGIN RATE LIMITING & AUTH
// -----------------------------
const loginAttempts = new Map();

function isLoginRateLimited(key) {
    const now = Date.now();
    const attempts = loginAttempts.get(key) || [];
    const recent = attempts.filter(t => now - t < 15 * 60 * 1000); // 15 mins window
    if (recent.length >= 5) {
        return true;
    }
    return false;
}

function recordFailedLogin(key) {
    const now = Date.now();
    const attempts = loginAttempts.get(key) || [];
    attempts.push(now);
    loginAttempts.set(key, attempts);
}

function clearFailedLogin(key) {
    loginAttempts.delete(key);
}

function requireAuth(req, res, next) {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({
            success: false,
            error: "Authentication required. Please log in."
        });
    }
    next();
}


// -----------------------------
// AUTHENTICATION ROUTES
// -----------------------------

// Registration: Full Name, Username, Email, Password
app.post("/api/auth/register", async (req, res) => {
    try {
        const { fullName, username, email, password } = req.body;

        if (!fullName || typeof fullName !== "string" || fullName.trim().length === 0) {
            return res.status(400).json({ success: false, error: "Full name is required." });
        }
        if (!username || typeof username !== "string" || username.trim().length === 0) {
            return res.status(400).json({ success: false, error: "Username is required." });
        }
        if (!email || typeof email !== "string" || email.trim().length === 0) {
            return res.status(400).json({ success: false, error: "Email address is required." });
        }
        if (!password || typeof password !== "string") {
            return res.status(400).json({ success: false, error: "Password is required." });
        }

        const cleanUsername = username.trim().toLowerCase();
        const cleanEmail = email.trim().toLowerCase();
        const cleanFullName = fullName.trim();

        // Username validation (3 to 30 chars, alphanumeric and underscore)
        const usernameRegex = /^[a-zA-Z0-9_]{3,30}$/;
        if (!usernameRegex.test(cleanUsername)) {
            return res.status(400).json({
                success: false,
                error: "Username must be 3-30 characters long and contain only letters, numbers, and underscores."
            });
        }

        // Email regex validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(cleanEmail)) {
            return res.status(400).json({
                success: false,
                error: "Please enter a valid email address."
            });
        }

        // Password strength validation (min 8 chars, max 100)
        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                error: "Password must be at least 8 characters long."
            });
        }
        if (password.length > 100) {
            return res.status(400).json({
                success: false,
                error: "Password cannot exceed 100 characters."
            });
        }

        // Check duplicate username
        const existingUsername = db.findUserByUsername(cleanUsername);
        if (existingUsername) {
            return res.status(409).json({
                success: false,
                error: "This username is already taken. Please choose another."
            });
        }

        // Check duplicate email
        const existingEmail = db.findUserByEmail(cleanEmail);
        if (existingEmail) {
            return res.status(409).json({
                success: false,
                error: "An account with this email address already exists."
            });
        }

        // Hash password with bcrypt
        const passwordHash = await bcrypt.hash(password, 10);

        // Store user in SQLite database
        const user = db.createUser(cleanFullName, cleanUsername, cleanEmail, passwordHash);

        return res.status(201).json({
            success: true,
            message: "Account created successfully. You can now log in.",
            user: {
                id: user.id,
                fullName: user.fullName,
                username: user.username,
                email: user.email
            }
        });

    } catch (err) {
        console.error("FundIQ Registration error:", err);
        return res.status(500).json({
            success: false,
            error: "An error occurred during registration. Please try again."
        });
    }
});

// Login: Requires ONLY username and password
app.post("/api/auth/login", async (req, res) => {
    try {
        const { username, password } = req.body;
        const clientIp = req.ip || req.connection?.remoteAddress || "unknown";

        if (!username || !password || typeof username !== "string" || typeof password !== "string") {
            return res.status(400).json({
                success: false,
                error: "Username and password are required."
            });
        }

        const cleanUsername = username.trim().toLowerCase();
        const rateLimitKey = `${clientIp}:${cleanUsername}`;

        if (isLoginRateLimited(rateLimitKey)) {
            db.recordLoginActivity(null, cleanUsername, false, "RATE_LIMITED");
            return res.status(429).json({
                success: false,
                error: "Too many failed login attempts. Please wait 15 minutes before trying again."
            });
        }

        const user = db.findUserByUsername(cleanUsername) || db.findUserByEmail(cleanUsername);

        if (!user) {
            recordFailedLogin(rateLimitKey);
            db.recordLoginActivity(null, cleanUsername, false, "USER_NOT_FOUND");
            return res.status(401).json({
                success: false,
                error: "Invalid username or password."
            });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);

        if (!isMatch) {
            recordFailedLogin(rateLimitKey);
            db.recordLoginActivity(user.id, cleanUsername, false, "INVALID_PASSWORD");
            return res.status(401).json({
                success: false,
                error: "Invalid username or password."
            });
        }

        // Login success: reset rate limiting & record activity
        clearFailedLogin(rateLimitKey);
        db.recordLoginActivity(user.id, cleanUsername, true, null);

        // Regenerate session to prevent session fixation
        req.session.regenerate((err) => {
            if (err) {
                console.error("Session regeneration error:", err);
                return res.status(500).json({ success: false, error: "Failed to create session." });
            }

            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.fullName = user.full_name;

            return res.json({
                success: true,
                message: "Logged in successfully.",
                user: {
                    id: user.id,
                    username: user.username,
                    fullName: user.full_name,
                    email: user.email
                }
            });
        });

    } catch (err) {
        console.error("FundIQ Login error:", err);
        return res.status(500).json({
            success: false,
            error: "An unexpected error occurred during login. Please try again."
        });
    }
});

// Logout: Destroys server session & clears cookie
app.post("/api/auth/logout", (req, res) => {
    if (req.session) {
        req.session.destroy((err) => {
            res.clearCookie("fundiq.sid");
            return res.json({ success: true, message: "Logged out successfully." });
        });
    } else {
        res.clearCookie("fundiq.sid");
        return res.json({ success: true, message: "Logged out successfully." });
    }
});

// Current User Session Info
app.get("/api/auth/me", (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.json({
            authenticated: false,
            user: null
        });
    }

    const user = db.findUserById(req.session.userId);
    if (!user) {
        return res.json({ authenticated: false, user: null });
    }

    return res.json({
        authenticated: true,
        user: {
            id: user.id,
            username: user.username,
            fullName: user.full_name,
            email: user.email
        }
    });
});


// -----------------------------
// USER-SCOPED FINANCIAL ROUTES
// -----------------------------

// Get Authenticated User's Wallet
app.get("/api/wallet", requireAuth, (req, res) => {
    try {
        const summary = db.getFullWalletSummary(req.session.userId);
        return res.json({
            success: true,
            wallet: summary.wallet,
            manualWallet: summary.manualWallet,
            bankBalances: summary.bankBalances,
            combinedWallet: summary.combinedWallet,
            subcategories: summary.subcategories,
            detectedBills: summary.detectedBills
        });
    } catch (err) {
        console.error("Get wallet error:", err);
        return res.status(500).json({ success: false, error: "Failed to retrieve wallet." });
    }
});

// Get Authenticated User's Wallet Subcategories
app.get("/api/wallet/subcategories", requireAuth, (req, res) => {
    try {
        const subcategories = db.getUserSubcategories(req.session.userId);
        return res.json({
            success: true,
            subcategories
        });
    } catch (err) {
        console.error("Get subcategories error:", err);
        return res.status(500).json({ success: false, error: "Failed to retrieve wallet subcategories." });
    }
});

// Create a New Wallet Subcategory
app.post("/api/wallet/subcategories", requireAuth, (req, res) => {
    try {
        const result = db.addUserSubcategory(req.session.userId, req.body || {});
        const summary = db.getFullWalletSummary(req.session.userId);
        return res.status(201).json({
            success: true,
            message: "Subcategory added successfully.",
            subcategory: result.subcategory,
            subcategories: result.subcategories,
            wallet: summary.wallet,
            manualWallet: summary.manualWallet,
            bankBalances: summary.bankBalances,
            combinedWallet: summary.combinedWallet
        });
    } catch (err) {
        const status = err.status || 400;
        return res.status(status).json({
            success: false,
            error: err.message || "Failed to add subcategory."
        });
    }
});

// Update an Existing Wallet Subcategory (preserves ID, transactions, and wallet balances)
function handleUpdateWalletSubcategory(req, res) {
    try {
        const subId = req.params.id || (req.body && req.body.id);
        const result = db.updateUserSubcategory(req.session.userId, subId, req.body || {});
        const summary = db.getFullWalletSummary(req.session.userId);
        return res.json({
            success: true,
            message: "Subcategory updated successfully.",
            subcategory: result.subcategory,
            subcategories: result.subcategories,
            wallet: summary.wallet,
            manualWallet: summary.manualWallet,
            bankBalances: summary.bankBalances,
            combinedWallet: summary.combinedWallet
        });
    } catch (err) {
        const status = err.status || 400;
        return res.status(status).json({
            success: false,
            error: err.message || "Failed to update subcategory."
        });
    }
}

app.put("/api/wallet/subcategories/:id", requireAuth, handleUpdateWalletSubcategory);
app.put("/api/wallet/subcategories", requireAuth, handleUpdateWalletSubcategory);

// Delete a Wallet Subcategory
app.delete("/api/wallet/subcategories/:id", requireAuth, (req, res) => {
    try {
        const result = db.deleteUserSubcategory(req.session.userId, req.params.id);
        return res.json({
            success: true,
            message: "Subcategory removed.",
            deletedId: result.deletedId,
            subcategories: result.subcategories
        });
    } catch (err) {
        const status = err.status || 400;
        return res.status(status).json({
            success: false,
            error: err.message || "Failed to delete subcategory."
        });
    }
});

// Update Authenticated User's Wallet
app.put("/api/wallet", requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const prevWallet = db.getUserWallet(userId);
        const { bills, spending, savings, depositEvent, suppressDepositEmail } = req.body || {};

        const nextBills = Number(bills) || 0;
        const nextSpending = Number(spending) || 0;
        const nextSavings = Number(savings) || 0;

        db.setUserWallet(userId, {
            bills: nextBills,
            spending: nextSpending,
            savings: nextSavings
        });

        const summary = db.getFullWalletSummary(userId);
        let emailNotification = null;

        // Detect if a deposit was made (either explicit depositEvent or net positive deposit into buckets)
        const dBills = Math.round((nextBills - prevWallet.bills) * 100) / 100;
        const dSpending = Math.round((nextSpending - prevWallet.spending) * 100) / 100;
        const dSavings = Math.round((nextSavings - prevWallet.savings) * 100) / 100;
        const netDeposit = Math.round((dBills + dSpending + dSavings) * 100) / 100;

        if (!suppressDepositEmail && (depositEvent || netDeposit > 0)) {
            const user = db.findUserById(userId);
            if (user) {
                const changedBuckets = [];
                if (dBills > 0) changedBuckets.push(`Bills (+$${dBills.toFixed(2)})`);
                if (dSavings > 0) changedBuckets.push(`Savings (+$${dSavings.toFixed(2)})`);
                if (dSpending > 0) changedBuckets.push(`Spending (+$${dSpending.toFixed(2)})`);

                let categoryLabel = "Wallet";
                if (depositEvent && depositEvent.category) {
                    categoryLabel = depositEvent.category;
                } else if (dBills > 0 && dSavings === 0 && dSpending === 0) {
                    categoryLabel = "Bills";
                } else if (dSavings > 0 && dBills === 0 && dSpending === 0) {
                    categoryLabel = "Savings";
                } else if (dSpending > 0 && dBills === 0 && dSavings === 0) {
                    categoryLabel = "Spending";
                } else if (changedBuckets.length > 1) {
                    categoryLabel = "Money Sorter Split (Bills, Savings, Spending)";
                }

                const amountToNotify =
                    depositEvent && Number(depositEvent.amount) > 0
                        ? Number(depositEvent.amount)
                        : netDeposit;

                if (amountToNotify > 0) {
                    try {
                        emailNotification = await emailService.sendDepositNotification(user, {
                            amount: amountToNotify,
                            category: categoryLabel,
                            date: (depositEvent && depositEvent.date) || new Date().toISOString().split("T")[0],
                            source: (depositEvent && depositEvent.source) || "FundIQ Wallet Update",
                            eventId:
                                (depositEvent && depositEvent.eventId) ||
                                `wallet_put:${nextBills.toFixed(2)}_${nextSavings.toFixed(2)}_${nextSpending.toFixed(2)}`,
                            breakdownText: changedBuckets.length > 1 ? changedBuckets.join(", ") : null,
                            newTotalBalance: Math.round((nextBills + nextSavings + nextSpending) * 100) / 100
                        });
                    } catch (notifyErr) {
                        console.warn("Non-blocking deposit email warning:", notifyErr.message);
                    }
                }
            }
        }

        return res.json({
            success: true,
            wallet: summary.wallet,
            manualWallet: summary.manualWallet,
            bankBalances: summary.bankBalances,
            combinedWallet: summary.combinedWallet,
            emailNotification
        });
    } catch (err) {
        console.error("Update wallet error:", err);
        return res.status(500).json({ success: false, error: "Failed to update wallet." });
    }
});

// Record an Explicit Deposit into Authenticated User's Wallet & Trigger Deposit Email
async function handleWalletDeposit(req, res) {
    try {
        const userId = req.session.userId;
        const user = db.findUserById(userId);
        if (!user) {
            return res.status(401).json({ success: false, error: "Authenticated user not found." });
        }

        const current = db.getUserWallet(userId);
        const body = req.body || {};

        let addBills = 0;
        let addSpending = 0;
        let addSavings = 0;
        let categoryLabel = "Spending";

        if (body.amount !== undefined && Number(body.amount) > 0) {
            const amt = Math.round(Number(body.amount) * 100) / 100;
            const cat = String(body.category || "spending").toLowerCase();
            if (cat === "bills") {
                addBills = amt;
                categoryLabel = "Bills";
            } else if (cat === "savings") {
                addSavings = amt;
                categoryLabel = "Savings";
            } else {
                addSpending = amt;
                categoryLabel = "Spending";
            }
        } else {
            addBills = Math.max(0, Math.round((Number(body.bills) || 0) * 100) / 100);
            addSpending = Math.max(0, Math.round((Number(body.spending) || 0) * 100) / 100);
            addSavings = Math.max(0, Math.round((Number(body.savings) || 0) * 100) / 100);
            const activeCats = [];
            if (addBills > 0) activeCats.push("Bills");
            if (addSavings > 0) activeCats.push("Savings");
            if (addSpending > 0) activeCats.push("Spending");
            categoryLabel = activeCats.length === 1 ? activeCats[0] : activeCats.join(" / ");
        }

        const totalDeposit = Math.round((addBills + addSpending + addSavings) * 100) / 100;
        if (totalDeposit <= 0) {
            return res.status(400).json({
                success: false,
                error: "Deposit amount must be greater than $0.00."
            });
        }

        // Check if this exact deposit eventId was already processed to avoid double-adding money or sending duplicate emails
        const eventId = body.eventId ? String(body.eventId).trim() : null;
        if (eventId) {
            const existingNotify = db.findEmailNotificationByEventKey(userId, `deposit_made:${eventId}`);
            if (existingNotify && (existingNotify.status === "sent" || existingNotify.status === "queued_dry_run")) {
                const summary = db.getFullWalletSummary(userId);
                return res.json({
                    success: true,
                    duplicate: true,
                    wallet: summary.wallet,
                    manualWallet: summary.manualWallet,
                    bankBalances: summary.bankBalances,
                    combinedWallet: summary.combinedWallet,
                    emailNotification: {
                        sent: false,
                        duplicate: true,
                        skipped: true,
                        reason: "DUPLICATE_EVENT",
                        notification: existingNotify
                    }
                });
            }
        }

        const updatedWallet = db.setUserWallet(userId, {
            bills: Math.round((current.bills + addBills) * 100) / 100,
            spending: Math.round((current.spending + addSpending) * 100) / 100,
            savings: Math.round((current.savings + addSavings) * 100) / 100
        });

        const summary = db.getFullWalletSummary(userId);
        const newTotal = Math.round((updatedWallet.bills + updatedWallet.spending + updatedWallet.savings) * 100) / 100;

        let emailNotification = null;
        try {
            const breakdownParts = [];
            if (addBills > 0) breakdownParts.push(`Bills: +$${addBills.toFixed(2)}`);
            if (addSavings > 0) breakdownParts.push(`Savings: +$${addSavings.toFixed(2)}`);
            if (addSpending > 0) breakdownParts.push(`Spending: +$${addSpending.toFixed(2)}`);

            emailNotification = await emailService.sendDepositNotification(user, {
                amount: totalDeposit,
                category: body.categoryLabel || categoryLabel,
                date: body.date || new Date().toISOString().split("T")[0],
                source: body.source || "FundIQ Wallet Deposit",
                eventId: eventId || `deposit_${Date.now()}_${totalDeposit.toFixed(2)}`,
                breakdownText: breakdownParts.length > 1 ? breakdownParts.join(", ") : null,
                newTotalBalance: newTotal
            });
        } catch (notifyErr) {
            console.warn("Non-blocking deposit email warning:", notifyErr.message);
        }

        return res.json({
            success: true,
            depositAmount: totalDeposit,
            wallet: summary.wallet,
            manualWallet: summary.manualWallet,
            bankBalances: summary.bankBalances,
            combinedWallet: summary.combinedWallet,
            emailNotification
        });
    } catch (err) {
        console.error("Wallet deposit error:", err);
        return res.status(500).json({ success: false, error: "Failed to record deposit." });
    }
}

app.post("/api/wallet/deposit", requireAuth, handleWalletDeposit);
app.post("/api/wallet/add", requireAuth, handleWalletDeposit);

// Clear Wallet: Resets balances ONLY, preserving calendar & payments
app.post("/api/wallet/clear", requireAuth, (req, res) => {
    try {
        db.clearUserWallet(req.session.userId);
        const summary = db.getFullWalletSummary(req.session.userId);
        return res.json({
            success: true,
            message: "Wallet balances cleared to $0.00. Your calendar and payment schedule remain intact.",
            wallet: summary.wallet,
            manualWallet: summary.manualWallet,
            bankBalances: summary.bankBalances,
            combinedWallet: summary.combinedWallet
        });
    } catch (err) {
        console.error("Clear wallet error:", err);
        return res.status(500).json({ success: false, error: "Failed to clear wallet." });
    }
});

// Get Authenticated User's Payments
app.get("/api/payments", requireAuth, (req, res) => {
    try {
        const payments = db.getUserPayments(req.session.userId);
        return res.json({ success: true, payments });
    } catch (err) {
        console.error("Get payments error:", err);
        return res.status(500).json({ success: false, error: "Failed to retrieve payments." });
    }
});

// Save Authenticated User's Payments
app.post("/api/payments", requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const updated = db.setUserPayments(userId, req.body);

        // Trigger due/upcoming unpaid payment reminder check without blocking response
        let reminderCheck = null;
        if (req.body && req.body.checkRemindersSync) {
            reminderCheck = await emailService.checkUserDuePaymentReminders(
                userId,
                req.body.referenceDate || new Date()
            );
        } else {
            emailService.checkUserDuePaymentReminders(userId, new Date()).catch((e) => {
                console.warn("Background payment reminder check warning:", e.message);
            });
        }

        return res.json({
            success: true,
            payments: updated,
            reminderCheck: reminderCheck || undefined
        });
    } catch (err) {
        console.error("Save payments error:", err);
        return res.status(500).json({ success: false, error: "Failed to save payments." });
    }
});

// Complete Payment: Idempotent deduction from authenticated user's manual wallet
app.post("/api/payments/complete", requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const { occurrenceId, amount, category, title: reqTitle } = req.body || {};
        const numAmount = Number(amount);

        if (!occurrenceId || isNaN(numAmount) || numAmount <= 0 || !category) {
            return res.status(400).json({ success: false, error: "Invalid payment completion data." });
        }

        const payments = db.getUserPayments(userId);
        const wallet = db.getUserWallet(userId);

        // Check if already completed
        if (payments.completions && payments.completions[occurrenceId] && payments.completions[occurrenceId].isCompleted) {
            return res.status(400).json({
                success: false,
                reason: "ALREADY_COMPLETED",
                error: "This payment occurrence has already been completed."
            });
        }

        const currentBal = wallet[category] || 0;
        if (currentBal < numAmount) {
            const bankBalances = db.getUserBankBalances(userId);
            const bankCatBal = Number(bankBalances[category]) || 0;
            return res.status(400).json({
                success: false,
                reason: "INSUFFICIENT_FUNDS",
                available: currentBal,
                bankBalance: bankCatBal,
                required: numAmount,
                error: `Insufficient funds in manual ${category.toUpperCase()} wallet. Manual Balance: $${currentBal.toFixed(2)}, Required: $${numAmount.toFixed(2)}. Note: Connected bank balances are read-only and are not automatically deducted when completing scheduled payments.`
            });
        }

        // Deduct exactly once from manual FundIQ wallet (never from Plaid bank balances)
        wallet[category] = Math.round((currentBal - numAmount) * 100) / 100;

        if (!payments.completions) payments.completions = {};
        payments.completions[occurrenceId] = {
            isCompleted: true,
            completedAt: new Date().toISOString(),
            deductedAmount: numAmount,
            deductedCategory: category
        };

        db.setUserWallet(userId, wallet);
        db.setUserPayments(userId, payments);
        const summary = db.getFullWalletSummary(userId);

        // Resolve payment title for notification
        let resolvedTitle = reqTitle || "Scheduled Payment";
        if (!reqTitle && Array.isArray(payments.templates)) {
            const matchedTpl = payments.templates.find((t) => String(occurrenceId).startsWith(`${t.id}_`));
            if (matchedTpl && matchedTpl.title) {
                resolvedTitle = matchedTpl.title;
            }
        }
        if (payments.overrides && payments.overrides[occurrenceId]?.title) {
            resolvedTitle = payments.overrides[occurrenceId].title;
        }

        let emailNotification = null;
        const user = db.findUserById(userId);
        if (user) {
            try {
                emailNotification = await emailService.sendPaymentActivityNotification(user, {
                    submissionType: "completed_local",
                    occurrenceId,
                    title: resolvedTitle,
                    amount: numAmount,
                    category,
                    date: new Date().toISOString().split("T")[0],
                    remainingManualBalance: wallet[category]
                });
            } catch (notifyErr) {
                console.warn("Non-blocking payment completion email warning:", notifyErr.message);
            }
        }

        return res.json({
            success: true,
            wallet: summary.wallet,
            manualWallet: summary.manualWallet,
            bankBalances: summary.bankBalances,
            combinedWallet: summary.combinedWallet,
            payments,
            completedPayment: {
                occurrenceId,
                title: resolvedTitle,
                amount: numAmount,
                category,
                status: "completed",
                submissionType: "completed_local",
                bankTransferOccurred: false
            },
            emailNotification
        });

    } catch (err) {
        console.error("Complete payment error:", err);
        return res.status(500).json({ success: false, error: "Failed to complete payment." });
    }
});

// Submit or Record Payment Activity Notification (Distinguishes External Submission vs. Local Completion)
app.post("/api/payments/submit", requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const user = db.findUserById(userId);
        if (!user) {
            return res.status(401).json({ success: false, error: "Authenticated user not found." });
        }

        const {
            occurrenceId,
            paymentId,
            eventId,
            title,
            amount,
            category,
            date,
            dueDate,
            submissionType,
            serviceName,
            paymentService,
            processorReference,
            externalConfirmationId,
            allowControlledProcessorTest
        } = req.body || {};

        const numAmount = Number(amount);
        if (!title || isNaN(numAmount) || numAmount <= 0) {
            return res.status(400).json({
                success: false,
                error: "Valid payment title and positive amount are required."
            });
        }

        const resolvedRef = processorReference || externalConfirmationId || null;
        const resolvedService = serviceName || paymentService || "External Payment Service";
        const resolvedType = submissionType || (resolvedRef ? "submitted_external" : null);

        if (resolvedType !== "completed_local" && !resolvedRef) {
            return res.status(400).json({
                success: false,
                error: "Cannot send a 'Payment Submitted' confirmation without a verified external payment processor reference (processorReference / externalConfirmationId). Use POST /api/payments/complete to mark a scheduled payment complete locally in your FundIQ Wallet."
            });
        }

        const emailNotification = await emailService.sendPaymentActivityNotification(user, {
            submissionType: resolvedType,
            occurrenceId: occurrenceId || paymentId,
            eventId: eventId || paymentId,
            title,
            amount: numAmount,
            category: category || "bills",
            date: date || dueDate || new Date().toISOString().split("T")[0],
            serviceName: resolvedService,
            processorReference: resolvedRef,
            allowControlledProcessorTest:
                allowControlledProcessorTest !== undefined ? Boolean(allowControlledProcessorTest) : Boolean(resolvedRef)
        });

        return res.json({
            success: true,
            emailNotification
        });
    } catch (err) {
        console.error("Payment submit notification error:", err);
        return res.status(500).json({ success: false, error: "Failed to process payment notification." });
    }
});

// -----------------------------
// EMAIL NOTIFICATION PREFERENCES & REMINDER ROUTES
// -----------------------------

app.get("/api/notifications/preferences", requireAuth, (req, res) => {
    try {
        const userId = req.session.userId;
        const user = db.findUserById(userId);
        const prefs = db.getUserNotificationPrefs(userId);
        const history = db.getUserEmailNotifications(userId, 20);
        const cfg = emailService.getEmailConfig();

        return res.json({
            success: true,
            recipientEmail: user ? user.email : null,
            preferences: prefs,
            emailDelivery: {
                configured: cfg.configured,
                mode: cfg.dryRun ? "dry_run" : "live",
                provider: cfg.provider,
                paymentProcessorEnabled: cfg.paymentProcessorEnabled
            },
            history
        });
    } catch (err) {
        console.error("Get notification preferences error:", err);
        return res.status(500).json({ success: false, error: "Failed to load notification preferences." });
    }
});

function handleUpdateNotificationPrefs(req, res) {
    try {
        const userId = req.session.userId;
        const body = req.body || {};

        if (body.reminderDaysBefore !== undefined) {
            const numDays = Number(body.reminderDaysBefore);
            if (isNaN(numDays) || numDays < 0 || numDays > 30) {
                return res.status(400).json({
                    success: false,
                    error: "Advance reminder days must be a number between 0 and 30."
                });
            }
        }

        if (body.phoneNumber !== undefined && String(body.phoneNumber).trim() !== "") {
            const rawPhone = String(body.phoneNumber).trim();
            const digitsOnly = rawPhone.replace(/\D/g, "");
            if (digitsOnly.length < 7 || digitsOnly.length > 15 || !/^[0-9+\-().\s]+$/.test(rawPhone)) {
                return res.status(400).json({
                    success: false,
                    error: "Please enter a valid phone number (7 to 15 digits) for SMS notifications."
                });
            }
        }

        if (
            body.allocationBillsPct !== undefined ||
            body.allocationSavingsPct !== undefined ||
            body.allocationSpendingPct !== undefined
        ) {
            const current = db.getUserNotificationPrefs(userId);
            const bPct = Number(body.allocationBillsPct ?? current.allocationBillsPct);
            const sPct = Number(body.allocationSavingsPct ?? current.allocationSavingsPct);
            const spPct = Number(body.allocationSpendingPct ?? current.allocationSpendingPct);
            if (isNaN(bPct) || isNaN(sPct) || isNaN(spPct) || bPct < 0 || sPct < 0 || spPct < 0) {
                return res.status(400).json({
                    success: false,
                    error: "Allocation percentages must be valid non-negative numbers."
                });
            }
            if (Math.abs(bPct + sPct + spPct - 100) > 0.5) {
                return res.status(400).json({
                    success: false,
                    error: "Bills %, Savings %, and Spending % must add up to 100%."
                });
            }
        }

        const updatedPrefs = db.setUserNotificationPrefs(userId, body);
        return res.json({
            success: true,
            message: "Your notification preferences have been saved.",
            preferences: updatedPrefs
        });
    } catch (err) {
        console.error("Update notification preferences error:", err);
        return res.status(500).json({ success: false, error: "Failed to update notification preferences." });
    }
}

app.put("/api/notifications/preferences", requireAuth, handleUpdateNotificationPrefs);
app.post("/api/notifications/preferences", requireAuth, handleUpdateNotificationPrefs);

app.post("/api/notifications/check-due", requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const referenceDate = (req.body && req.body.referenceDate) || new Date();
        const result = await emailService.checkUserDuePaymentReminders(userId, referenceDate);
        return res.json({
            success: true,
            result,
            ...result
        });
    } catch (err) {
        console.error("Check due payments error:", err);
        return res.status(500).json({ success: false, error: "Failed to check due payment reminders." });
    }
});

// Undo Payment: Reverse deduction and restore funds to user's wallet
app.post("/api/payments/undo", requireAuth, (req, res) => {
    try {
        const { occurrenceId } = req.body;
        if (!occurrenceId) {
            return res.status(400).json({ success: false, error: "Occurrence ID is required." });
        }

        const payments = db.getUserPayments(req.session.userId);
        const wallet = db.getUserWallet(req.session.userId);

        const comp = payments.completions && payments.completions[occurrenceId];
        if (!comp || !comp.isCompleted) {
            return res.status(400).json({
                success: false,
                reason: "NOT_COMPLETED",
                error: "This payment occurrence is not completed."
            });
        }

        const refundAmount = Number(comp.deductedAmount) || 0;
        const refundCategory = comp.deductedCategory || "bills";

        // Restore funds exactly once
        wallet[refundCategory] = Math.round(((wallet[refundCategory] || 0) + refundAmount) * 100) / 100;

        delete payments.completions[occurrenceId];

        db.setUserWallet(req.session.userId, wallet);
        db.setUserPayments(req.session.userId, payments);
        const summary = db.getFullWalletSummary(req.session.userId);

        return res.json({
            success: true,
            wallet: summary.wallet,
            manualWallet: summary.manualWallet,
            bankBalances: summary.bankBalances,
            combinedWallet: summary.combinedWallet,
            payments,
            refundedAmount: refundAmount,
            refundedCategory: refundCategory
        });

    } catch (err) {
        console.error("Undo payment error:", err);
        return res.status(500).json({ success: false, error: "Failed to undo payment." });
    }
});


// -----------------------------
// PLAID BANK INTEGRATION ROUTES
// -----------------------------

// 1. Create a Plaid Link Token for the currently authenticated user
app.post("/api/plaid/create_link_token", requireAuth, async (req, res) => {
    try {
        const user = db.findUserById(req.session.userId);
        if (!user) {
            return res.status(401).json({
                success: false,
                error: "Authenticated user account not found. Please log in again."
            });
        }

        if (!isPlaidConfigured()) {
            return res.status(500).json({
                success: false,
                error: "Plaid credentials (PLAID_CLIENT_ID / PLAID_SECRET) are not configured on the server."
            });
        }

        const linkTokenRequest = {
            user: {
                client_user_id: String(user.id)
            },
            client_name: "FundIQ",
            products: [Products.Auth],
            optional_products: [Products.Transactions],
            country_codes: [CountryCode.Us],
            language: "en"
        };

        const activeClient = getPlaidClient();
        const createTokenResponse = await activeClient.linkTokenCreate(linkTokenRequest);

        return res.json({
            success: true,
            link_token: createTokenResponse.data.link_token,
            expiration: createTokenResponse.data.expiration,
            env: getPlaidEnvName()
        });
    } catch (err) {
        console.error("Plaid create_link_token error:", err.response?.data || err.message);
        const formatted = formatPlaidError(err, "Unable to initialize Plaid Link right now. Please try again.");
        return res.status(502).json({
            success: false,
            ...formatted
        });
    }
});

// 2. Exchange temporary public_token for an access_token and fetch accounts/balances
app.post("/api/plaid/exchange_public_token", requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const user = db.findUserById(userId);
        if (!user) {
            return res.status(401).json({
                success: false,
                error: "Authenticated user account not found. Please log in again."
            });
        }

        if (!isPlaidConfigured()) {
            return res.status(500).json({
                success: false,
                error: "Plaid credentials are not configured on the server."
            });
        }

        const { public_token, metadata } = req.body || {};

        if (!public_token || typeof public_token !== "string" || !public_token.trim().startsWith("public-")) {
            return res.status(400).json({
                success: false,
                error: "A valid Plaid public_token is required."
            });
        }

        let institutionId = metadata?.institution?.institution_id
            ? String(metadata.institution.institution_id).trim()
            : null;
        let institutionName = metadata?.institution?.name
            ? String(metadata.institution.name).trim()
            : null;

        // Pre-check duplicate institution connection if metadata included institution_id
        if (institutionId) {
            const existing = db.findPlaidItemByUserAndInstitution(userId, institutionId);
            if (existing) {
                return res.status(409).json({
                    success: false,
                    error_code: "DUPLICATE_INSTITUTION",
                    error: `${institutionName || existing.institution_name || "This financial institution"} is already connected to your FundIQ account. Use "Refresh Balances" to update your balances, or disconnect the existing connection first.`
                });
            }
        }

        const activeClient = getPlaidClient();

        // Exchange public_token for permanent access_token (kept strictly server-side)
        const exchangeResponse = await activeClient.itemPublicTokenExchange({
            public_token: public_token.trim()
        });

        const accessToken = exchangeResponse.data.access_token;
        const itemId = exchangeResponse.data.item_id;

        // Resolve institution details from Plaid if not supplied in metadata
        if (!institutionId || !institutionName) {
            try {
                const itemResp = await activeClient.itemGet({ access_token: accessToken });
                if (itemResp.data?.item?.institution_id) {
                    institutionId = itemResp.data.item.institution_id;
                }
                if (institutionId && !institutionName) {
                    const instResp = await activeClient.institutionsGetById({
                        institution_id: institutionId,
                        country_codes: [CountryCode.Us]
                    });
                    if (instResp.data?.institution?.name) {
                        institutionName = instResp.data.institution.name;
                    }
                }
            } catch (instErr) {
                console.warn("Plaid institution lookup warning:", instErr.message);
            }
        }

        // Post-exchange duplicate check once authoritative institution_id is known
        if (institutionId) {
            const existing = db.findPlaidItemByUserAndInstitution(userId, institutionId);
            if (existing && existing.item_id !== itemId) {
                // Clean up the duplicate Plaid Item so unused tokens don't linger
                await activeClient.itemRemove({ access_token: accessToken }).catch(() => {});
                return res.status(409).json({
                    success: false,
                    error_code: "DUPLICATE_INSTITUTION",
                    error: `${institutionName || existing.institution_name || "This financial institution"} is already connected to your FundIQ account. Use "Refresh Balances" to update your balances, or disconnect the existing connection first.`
                });
            }
        }

        // Retrieve account information and balances from Plaid
        const accountsResponse = await activeClient.accountsGet({
            access_token: accessToken
        });

        const plaidAccounts = accountsResponse.data.accounts || [];

        // Save item and accounts in SQLite, scoped strictly to req.session.userId
        const savedAccounts = db.savePlaidItemAndAccounts(
            userId,
            {
                itemId,
                accessToken,
                institutionId,
                institutionName: institutionName || "Connected Financial Institution"
            },
            plaidAccounts
        );

        // Sync verified transaction history & detect recurring bills without blocking connection if transactions are still initializing
        await syncUserPlaidTransactions(userId).catch((txErr) => {
            console.warn("Initial Plaid transactions sync notice:", txErr.message);
        });

        const summary = db.getFullWalletSummary(userId);
        const transactions = db.getUserPlaidTransactions(userId, 50);
        const payments = db.getUserPayments(userId);

        return res.json({
            success: true,
            message: `Connected to ${institutionName || "your bank"} successfully.`,
            env: getPlaidEnvName(),
            items: db.getPlaidItemsSanitized(userId),
            accounts: savedAccounts,
            wallet: summary.wallet,
            manualWallet: summary.manualWallet,
            bankBalances: summary.bankBalances,
            combinedWallet: summary.combinedWallet,
            subcategories: summary.subcategories,
            detectedBills: summary.detectedBills,
            transactions,
            payments
        });
    } catch (err) {
        console.error("Plaid exchange_public_token error:", err.response?.data || err.message);
        const formatted = formatPlaidError(err, "Failed to complete bank connection. Please try again.");
        return res.status(400).json({
            success: false,
            ...formatted
        });
    }
});

// Helper to sync verified Plaid transactions and run recurring bill detection for a user
async function syncUserPlaidTransactions(userId, options = {}) {
    const internalItems = db.getPlaidItemsInternal(userId);
    const activeClient = getPlaidClient();
    const txSyncNotices = [];
    let syncedCount = 0;

    if (isPlaidConfigured()) {
        for (const item of internalItems) {
            try {
                let cursor = item.transactions_cursor || undefined;
                let hasMore = true;
                let pageGuard = 0;

                while (hasMore && pageGuard < 10) {
                    const syncResp = await activeClient.transactionsSync({
                        access_token: item.access_token,
                        cursor,
                        count: 100
                    });
                    const data = syncResp.data || {};
                    const combined = [
                        ...(Array.isArray(data.added) ? data.added : []),
                        ...(Array.isArray(data.modified) ? data.modified : [])
                    ];
                    const removed = Array.isArray(data.removed) ? data.removed : [];
                    syncedCount += db.savePlaidTransactions(userId, item.item_id, combined, removed);
                    cursor = data.next_cursor || cursor;
                    hasMore = Boolean(data.has_more);
                    pageGuard++;
                }

                if (cursor) {
                    db.updatePlaidItemCursor(userId, item.item_id, cursor);
                }
            } catch (syncErr) {
                // Fallback to transactionsGet if transactionsSync is not ready or unsupported for this item
                try {
                    const endDt = new Date();
                    const startDt = new Date(endDt.getTime() - 180 * 24 * 60 * 60 * 1000);
                    const endDate = endDt.toISOString().split("T")[0];
                    const startDate = startDt.toISOString().split("T")[0];
                    const getResp = await activeClient.transactionsGet({
                        access_token: item.access_token,
                        start_date: startDate,
                        end_date: endDate
                    });
                    const txs = (getResp.data && Array.isArray(getResp.data.transactions)) ? getResp.data.transactions : [];
                    syncedCount += db.savePlaidTransactions(userId, item.item_id, txs, []);
                } catch (fallbackErr) {
                    const code = fallbackErr.response?.data?.error_code || syncErr.response?.data?.error_code || "TRANSACTIONS_UNAVAILABLE";
                    txSyncNotices.push({
                        item_id: item.item_id,
                        institution_name: item.institution_name,
                        code,
                        message: fallbackErr.response?.data?.error_message || syncErr.message
                    });
                }
            }
        }
    }

    const detection = db.detectAndPredictRecurringBills(userId, options.referenceDate || null);
    return {
        syncedCount,
        txSyncNotices,
        ...detection
    };
}

// Helper to refresh all active Plaid items for a user
async function refreshUserPlaidBalances(userId) {
    const internalItems = db.getPlaidItemsInternal(userId);
    const refreshErrors = [];
    const activeClient = getPlaidClient();

    for (const item of internalItems) {
        try {
            const balResp = await activeClient.accountsBalanceGet({
                access_token: item.access_token
            });
            if (balResp.data && Array.isArray(balResp.data.accounts)) {
                db.updatePlaidAccountBalances(userId, item.item_id, balResp.data.accounts);
            }
        } catch (err) {
            console.error(`Plaid balance refresh error for item ${item.item_id}:`, err.response?.data || err.message);
            refreshErrors.push({
                item_id: item.item_id,
                institution_name: item.institution_name,
                ...formatPlaidError(err, `Could not refresh balances for ${item.institution_name || "bank"}.`)
            });
        }
    }

    await syncUserPlaidTransactions(userId).catch((txErr) => {
        console.warn("Plaid refresh transactions sync notice:", txErr.message);
    });

    return refreshErrors;
}

// 3. Retrieve connected user's account information, balances, and wallet mappings
app.get("/api/plaid/accounts", requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        let refreshErrors = [];

        if (req.query.refresh === "true" || req.query.refresh === "1") {
            refreshErrors = await refreshUserPlaidBalances(userId);
        } else {
            // Ensure any stored transactions are evaluated for recurring bills
            db.detectAndPredictRecurringBills(userId);
        }

        const items = db.getPlaidItemsSanitized(userId);
        const accounts = db.getPlaidAccountsByUser(userId);
        const summary = db.getFullWalletSummary(userId);
        const transactions = db.getUserPlaidTransactions(userId, 50);
        const payments = db.getUserPayments(userId);

        return res.json({
            success: true,
            env: getPlaidEnvName(),
            connected: items.length > 0,
            items,
            accounts,
            wallet: summary.wallet,
            manualWallet: summary.manualWallet,
            bankBalances: summary.bankBalances,
            combinedWallet: summary.combinedWallet,
            subcategories: summary.subcategories,
            detectedBills: summary.detectedBills,
            transactions,
            payments,
            refreshErrors: refreshErrors.length > 0 ? refreshErrors : undefined
        });
    } catch (err) {
        console.error("Plaid get accounts error:", err);
        return res.status(500).json({
            success: false,
            error: "Failed to retrieve connected bank accounts."
        });
    }
});

// 4. Explicitly refresh live bank balances from Plaid without altering manual balances or payments
app.post("/api/plaid/refresh", requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const internalItems = db.getPlaidItemsInternal(userId);

        if (internalItems.length === 0) {
            return res.status(400).json({
                success: false,
                error: "No bank accounts are currently connected to refresh."
            });
        }

        const refreshErrors = await refreshUserPlaidBalances(userId);
        const items = db.getPlaidItemsSanitized(userId);
        const accounts = db.getPlaidAccountsByUser(userId);
        const summary = db.getFullWalletSummary(userId);
        const transactions = db.getUserPlaidTransactions(userId, 50);
        const payments = db.getUserPayments(userId);

        if (refreshErrors.length === internalItems.length) {
            return res.status(502).json({
                success: false,
                error: refreshErrors[0].error || "Could not refresh balances from Plaid right now.",
                refreshErrors,
                items,
                accounts,
                wallet: summary.wallet,
                manualWallet: summary.manualWallet,
                bankBalances: summary.bankBalances,
                combinedWallet: summary.combinedWallet,
                subcategories: summary.subcategories,
                detectedBills: summary.detectedBills,
                transactions,
                payments
            });
        }

        return res.json({
            success: true,
            message: "Live bank balances refreshed successfully. Your manual balances and payment schedule remain intact.",
            env: getPlaidEnvName(),
            connected: items.length > 0,
            items,
            accounts,
            wallet: summary.wallet,
            manualWallet: summary.manualWallet,
            bankBalances: summary.bankBalances,
            combinedWallet: summary.combinedWallet,
            subcategories: summary.subcategories,
            detectedBills: summary.detectedBills,
            transactions,
            payments,
            refreshErrors: refreshErrors.length > 0 ? refreshErrors : undefined
        });
    } catch (err) {
        console.error("Plaid refresh balances error:", err);
        return res.status(500).json({
            success: false,
            error: "Failed to refresh bank balances."
        });
    }
});

// 5. Update user's checking -> Bills and savings -> Rainy Day / Savings account mappings
function handleUpdatePlaidMappings(req, res) {
    try {
        const userId = req.session.userId;
        const updatedAccounts = db.updatePlaidAccountMappings(userId, req.body || {});
        const summary = db.getFullWalletSummary(userId);

        return res.json({
            success: true,
            message: "Account category mappings updated.",
            items: db.getPlaidItemsSanitized(userId),
            accounts: updatedAccounts,
            wallet: summary.wallet,
            manualWallet: summary.manualWallet,
            bankBalances: summary.bankBalances,
            combinedWallet: summary.combinedWallet
        });
    } catch (err) {
        const status = err.status || 400;
        return res.status(status).json({
            success: false,
            error: err.message || "Failed to update account mappings."
        });
    }
}

app.put("/api/plaid/mappings", requireAuth, handleUpdatePlaidMappings);
app.post("/api/plaid/mappings", requireAuth, handleUpdatePlaidMappings);

// 6. Disconnect a bank connection securely
async function handleDisconnectPlaid(req, res) {
    try {
        const userId = req.session.userId;
        const requestedItemId = req.params?.itemId || req.body?.item_id || req.body?.itemId || null;
        const activeClient = getPlaidClient();

        if (requestedItemId) {
            const item = db.getPlaidItemByUserAndItemId(userId, requestedItemId);
            if (!item) {
                return res.status(404).json({
                    success: false,
                    error: "Bank connection not found or does not belong to your account."
                });
            }

            // Revoke access token with Plaid
            if (isPlaidConfigured() && item.access_token) {
                try {
                    await activeClient.itemRemove({ access_token: item.access_token });
                } catch (plaidErr) {
                    console.warn("Plaid itemRemove warning (proceeding with local cleanup):", plaidErr.response?.data || plaidErr.message);
                }
            }

            db.removePlaidItem(userId, item.item_id);
        } else {
            const userItems = db.getPlaidItemsInternal(userId);
            if (userItems.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: "No active bank connection found to disconnect."
                });
            }

            for (const item of userItems) {
                if (isPlaidConfigured() && item.access_token) {
                    try {
                        await activeClient.itemRemove({ access_token: item.access_token });
                    } catch (plaidErr) {
                        console.warn("Plaid itemRemove warning:", plaidErr.response?.data || plaidErr.message);
                    }
                }
                db.removePlaidItem(userId, item.item_id);
            }
        }

        const items = db.getPlaidItemsSanitized(userId);
        const accounts = db.getPlaidAccountsByUser(userId);
        const summary = db.getFullWalletSummary(userId);

        return res.json({
            success: true,
            message: "Bank connection disconnected securely. Your manual wallet balances and scheduled payments remain intact.",
            connected: items.length > 0,
            items,
            accounts,
            wallet: summary.wallet,
            manualWallet: summary.manualWallet,
            bankBalances: summary.bankBalances,
            combinedWallet: summary.combinedWallet
        });
    } catch (err) {
        console.error("Plaid disconnect error:", err);
        return res.status(500).json({
            success: false,
            error: "Failed to disconnect bank connection."
        });
    }
}

app.post("/api/plaid/disconnect", requireAuth, handleDisconnectPlaid);
app.delete("/api/plaid/items/:itemId", requireAuth, handleDisconnectPlaid);

// -----------------------------
// DETECTED RECURRING BILLS & TRANSACTION HISTORY ROUTES
// -----------------------------

app.get("/api/bills/detected", requireAuth, (req, res) => {
    try {
        const userId = req.session.userId;
        const detection = db.detectAndPredictRecurringBills(userId, req.query.referenceDate || null);
        const transactions = db.getUserPlaidTransactions(userId, Number(req.query.limit) || 50);
        const payments = db.getUserPayments(userId);
        return res.json({
            success: true,
            detectedBills: detection.detectedBills,
            activePredictions: detection.activePredictions,
            transactions,
            payments
        });
    } catch (err) {
        console.error("Get detected bills error:", err);
        return res.status(500).json({
            success: false,
            error: "Failed to retrieve detected bills and transaction history."
        });
    }
});

app.post("/api/bills/sync", requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const referenceDate = (req.body && req.body.referenceDate) || null;
        const syncResult = await syncUserPlaidTransactions(userId, { referenceDate });
        const transactions = db.getUserPlaidTransactions(userId, 50);
        const payments = db.getUserPayments(userId);
        const summary = db.getFullWalletSummary(userId);
        return res.json({
            success: true,
            message: "Recurring bill detection and payment history synced.",
            syncedCount: syncResult.syncedCount,
            detectedBills: syncResult.detectedBills,
            activePredictions: syncResult.activePredictions,
            transactions,
            payments,
            wallet: summary.wallet,
            manualWallet: summary.manualWallet,
            bankBalances: summary.bankBalances,
            combinedWallet: summary.combinedWallet,
            txSyncNotices: syncResult.txSyncNotices && syncResult.txSyncNotices.length > 0 ? syncResult.txSyncNotices : undefined
        });
    } catch (err) {
        console.error("Sync detected bills error:", err);
        return res.status(500).json({
            success: false,
            error: "Failed to sync recurring bills."
        });
    }
});

app.put("/api/bills/detected/:id", requireAuth, (req, res) => {
    try {
        const userId = req.session.userId;
        const result = db.updateDetectedBill(userId, req.params.id, req.body || {});
        return res.json({
            success: true,
            message: "Predicted bill updated and synced to your calendar.",
            bill: result.bill,
            detectedBills: result.detectedBills,
            activePredictions: result.detectedBills.filter((b) => b.status !== "dismissed"),
            payments: result.payments
        });
    } catch (err) {
        const status = err.status || 400;
        return res.status(status).json({
            success: false,
            error: err.message || "Failed to update detected bill."
        });
    }
});

function handleDismissDetectedBill(req, res) {
    try {
        const userId = req.session.userId;
        const result = db.dismissDetectedBill(userId, req.params.id);
        return res.json({
            success: true,
            message: "Predicted bill dismissed and removed from your calendar.",
            dismissedId: result.dismissedId,
            detectedBills: result.detectedBills,
            activePredictions: result.detectedBills.filter((b) => b.status !== "dismissed"),
            payments: result.payments
        });
    } catch (err) {
        const status = err.status || 400;
        return res.status(status).json({
            success: false,
            error: err.message || "Failed to dismiss detected bill."
        });
    }
}

app.delete("/api/bills/detected/:id", requireAuth, handleDismissDetectedBill);
app.post("/api/bills/detected/:id/dismiss", requireAuth, handleDismissDetectedBill);

// -----------------------------
// WEEKLY AI FINANCIAL INSIGHTS ROUTES
// -----------------------------

async function generateOpenAIWeeklySummaryInsight(reportMetrics) {
    if (!isOpenAIConfigured()) return null;

    const prompt = `
You are Penny, FundIQ's AI financial assistant.
Analyze this user's weekly financial summary (${reportMetrics.weekStart} to ${reportMetrics.weekEnd}):
- Total spent this week: $${Number(reportMetrics.totalSpent || 0).toFixed(2)}
- Previous week spent: $${Number(reportMetrics.prevWeekSpent || 0).toFixed(2)} (${reportMetrics.spendingChangePct}% change)
- Total deposited this week: $${Number(reportMetrics.totalDeposited || 0).toFixed(2)}
- Spending breakdown: ${JSON.stringify(reportMetrics.spendingBreakdown || [])}
- Category comparison vs. last week: ${JSON.stringify(reportMetrics.categoryComparison || [])}
- Current combined balances: ${JSON.stringify((reportMetrics.accountBalances && reportMetrics.accountBalances.combinedWallet) || {})}

Return ONLY valid JSON with:
{
  "insightsText": "2-3 sentence friendly, accurate summary of their week",
  "suggestions": ["actionable suggestion 1", "actionable suggestion 2"]
}
`;
    const completion = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 350,
        temperature: 0.3
    });
    const raw = (completion.choices[0]?.message?.content || "").replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(raw);
}

app.get("/api/insights/weekly", requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const reports = db.getWeeklyFinancialReportsByUser(userId, 12);
        const insights = db.getAiFinancialInsightsByUser(userId, 12);
        const prefs = db.getUserNotificationPrefs(userId);
        return res.json({
            success: true,
            latestReport: reports[0] || null,
            reports,
            insights,
            schedule: {
                enabled: prefs.weeklyReportEnabled,
                deliveryMethod: prefs.weeklyDeliveryMethod,
                deliveryTime: prefs.weeklyDeliveryTime,
                timezone: prefs.timezone,
                dayOfWeek: "Sunday"
            }
        });
    } catch (err) {
        console.error("Get weekly insights error:", err);
        return res.status(500).json({
            success: false,
            error: "Failed to load weekly financial insights."
        });
    }
});

app.post("/api/insights/weekly/generate", requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const body = req.body || {};
        const result = await emailService.generateWeeklyFinancialReport(userId, {
            referenceDate: body.referenceDate || null,
            includeSampleData: Boolean(body.includeSampleData),
            sendNotification: Boolean(body.sendNotification),
            deliveryMethod: body.deliveryMethod || null,
            aiGenerator: isOpenAIConfigured() ? generateOpenAIWeeklySummaryInsight : null
        });
        const reports = db.getWeeklyFinancialReportsByUser(userId, 12);
        const noActivity = result.reason === "NO_ACTIVITY";
        return res.json({
            success: true,
            noActivity,
            message: noActivity
                ? "No weekly insights yet — connect a bank account or add payments/deposits manually first."
                : body.sendNotification
                ? "Weekly AI Financial Summary generated and sent via your selected notification method."
                : "Weekly AI Financial Summary generated.",
            report: result.report,
            notification: result.notification,
            reports
        });
    } catch (err) {
        console.error("Generate weekly insight error:", err);
        return res.status(500).json({
            success: false,
            error: err.message || "Failed to generate weekly financial summary."
        });
    }
});

// -----------------------------
// AI DEPOSIT NOTIFICATIONS & PROPOSED ALLOCATIONS ROUTES
// -----------------------------

async function computeRecommendedDepositSplit(userId, depositAmount, sourceDescription = "Direct Deposit") {
    const uid = Number(userId);
    const prefs = db.getUserNotificationPrefs(uid);
    const billsPct = Number(prefs.allocationBillsPct) || 50;
    const savingsPct = Number(prefs.allocationSavingsPct) || 30;
    const spendingPct = Math.max(0, 100 - billsPct - savingsPct);

    const recBills = Math.round(((depositAmount * billsPct) / 100) * 100) / 100;
    const recSavings = Math.round(((depositAmount * savingsPct) / 100) * 100) / 100;
    const recSpending = Math.round((depositAmount - recBills - recSavings) * 100) / 100;

    let aiExplanation = `Based on your saved FundIQ allocation preferences (${billsPct}% Bills, ${savingsPct}% Savings, ${spendingPct}% Spending), Penny recommends assigning $${recBills.toFixed(2)} to Bills, $${recSavings.toFixed(2)} to Savings, and $${recSpending.toFixed(2)} to Spending. Your actual balances remain unchanged until you approve this proposed split.`;

    if (isOpenAIConfigured()) {
        try {
            const prompt = `
You are Penny, FundIQ's AI assistant.
A user received a deposit of $${depositAmount.toFixed(2)} (${sourceDescription}).
Based on their saved allocation rules (${billsPct}% Bills, ${savingsPct}% Savings, ${spendingPct}% Spending), the proposed split is:
- Bills: $${recBills.toFixed(2)}
- Savings: $${recSavings.toFixed(2)}
- Spending: $${recSpending.toFixed(2)}
Write a 2-sentence encouraging explanation referencing CFPB/MyMoney.gov best practices and reminding them that this is a proposed split awaiting their approval.
`;
            const completion = await client.chat.completions.create({
                model: process.env.OPENAI_MODEL || "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 180,
                temperature: 0.3
            });
            const aiNote = completion.choices[0]?.message?.content?.trim();
            if (aiNote) aiExplanation = aiNote;
        } catch (_) {}
    }

    return {
        recommendedBills: recBills,
        recommendedSavings: recSavings,
        recommendedSpending: recSpending,
        aiExplanation,
        rulesUsed: { billsPct, savingsPct, spendingPct }
    };
}

app.get("/api/deposits/allocations", requireAuth, (req, res) => {
    try {
        const userId = req.session.userId;
        const allocations = db.getDepositAllocationsByUser(userId, Number(req.query.limit) || 30);
        const prefs = db.getUserNotificationPrefs(userId);
        const summary = db.getFullWalletSummary(userId);
        const deliveryHistory = db.getNotificationDeliveryHistoryByUser(userId, 40);
        return res.json({
            success: true,
            allocations,
            pendingAllocations: allocations.filter((a) => a.status === "proposed"),
            allocationRules: {
                billsPct: prefs.allocationBillsPct,
                savingsPct: prefs.allocationSavingsPct,
                spendingPct: prefs.allocationSpendingPct
            },
            actualBalances: {
                manualWallet: summary.manualWallet,
                bankBalances: summary.bankBalances,
                combinedWallet: summary.combinedWallet
            },
            deliveryHistory
        });
    } catch (err) {
        console.error("Get deposit allocations error:", err);
        return res.status(500).json({
            success: false,
            error: "Failed to load deposit allocations."
        });
    }
});

app.post("/api/deposits/simulate", requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const user = db.findUserById(userId);
        const body = req.body || {};
        const depositAmount = Number(body.depositAmount ?? body.amount);

        if (isNaN(depositAmount) || depositAmount <= 0) {
            return res.status(400).json({
                success: false,
                error: "Please enter a valid deposit amount greater than $0.00."
            });
        }

        const depositDate =
            body.depositDate && /^\d{4}-\d{2}-\d{2}$/.test(String(body.depositDate))
                ? String(body.depositDate)
                : new Date().toISOString().split("T")[0];
        const sourceDescription = String(body.sourceDescription || body.source || "Direct Deposit").trim();
        const accountName = String(body.accountName || "Connected Checking Account").trim();
        const depositKey = body.depositKey ? String(body.depositKey) : `dep_${userId}_${Date.now()}_${Math.round(depositAmount * 100)}`;

        const split = await computeRecommendedDepositSplit(userId, depositAmount, sourceDescription);

        const allocation = db.createDepositAllocation(userId, {
            depositKey,
            accountId: body.accountId || null,
            accountName,
            depositAmount,
            depositDate,
            sourceDescription,
            recommendedBills: split.recommendedBills,
            recommendedSavings: split.recommendedSavings,
            recommendedSpending: split.recommendedSpending,
            aiExplanation: split.aiExplanation
        });

        let notificationResult = null;
        if (user) {
            notificationResult = await emailService.sendProposedDepositAllocationNotification(user, allocation);
        }

        const refreshedAllocation = db.getDepositAllocationById(userId, allocation.id) || allocation;
        const allAllocations = db.getDepositAllocationsByUser(userId, 30);
        const summary = db.getFullWalletSummary(userId);

        return res.status(201).json({
            success: true,
            message:
                "Deposit detected! A proposed AI allocation has been created and sent to your notifications. Your actual Wallet balances remain unchanged until you approve the allocation.",
            allocation: refreshedAllocation,
            allocations: allAllocations,
            pendingAllocations: allAllocations.filter((a) => a.status === "proposed"),
            actualBalances: {
                manualWallet: summary.manualWallet,
                bankBalances: summary.bankBalances,
                combinedWallet: summary.combinedWallet
            },
            notification: notificationResult
        });
    } catch (err) {
        const status = err.status || 500;
        return res.status(status).json({
            success: false,
            error: err.message || "Failed to process deposit notification."
        });
    }
});

app.put("/api/deposits/allocations/:id", requireAuth, (req, res) => {
    try {
        const userId = req.session.userId;
        const updated = db.updateProposedDepositAllocation(userId, req.params.id, req.body || {});
        const allAllocations = db.getDepositAllocationsByUser(userId, 30);
        return res.json({
            success: true,
            message: "Proposed deposit allocation updated. Click Approve when ready to apply it to your Wallet.",
            allocation: updated,
            allocations: allAllocations,
            pendingAllocations: allAllocations.filter((a) => a.status === "proposed")
        });
    } catch (err) {
        const status = err.status || 400;
        return res.status(status).json({
            success: false,
            error: err.message || "Failed to update proposed deposit allocation."
        });
    }
});

app.post("/api/deposits/allocations/:id/approve", requireAuth, (req, res) => {
    try {
        const userId = req.session.userId;
        const result = db.approveDepositAllocation(userId, req.params.id, req.body || null);
        const allAllocations = db.getDepositAllocationsByUser(userId, 30);
        return res.json({
            success: true,
            message: "Deposit allocation approved and applied to your FundIQ Wallet!",
            allocation: result.allocation,
            allocations: allAllocations,
            pendingAllocations: allAllocations.filter((a) => a.status === "proposed"),
            wallet: result.summary.wallet,
            manualWallet: result.summary.manualWallet,
            bankBalances: result.summary.bankBalances,
            combinedWallet: result.summary.combinedWallet
        });
    } catch (err) {
        const status = err.status || 400;
        return res.status(status).json({
            success: false,
            error: err.message || "Failed to approve deposit allocation."
        });
    }
});

app.post("/api/deposits/allocations/:id/reject", requireAuth, (req, res) => {
    try {
        const userId = req.session.userId;
        const rejected = db.rejectDepositAllocation(userId, req.params.id);
        const allAllocations = db.getDepositAllocationsByUser(userId, 30);
        return res.json({
            success: true,
            message: "Proposed deposit allocation dismissed. Your Wallet balances were not changed.",
            allocation: rejected,
            allocations: allAllocations,
            pendingAllocations: allAllocations.filter((a) => a.status === "proposed")
        });
    } catch (err) {
        const status = err.status || 400;
        return res.status(status).json({
            success: false,
            error: err.message || "Failed to dismiss deposit allocation."
        });
    }
});

app.get("/api/notifications/history", requireAuth, (req, res) => {
    try {
        const userId = req.session.userId;
        const deliveryHistory = db.getNotificationDeliveryHistoryByUser(userId, Number(req.query.limit) || 50);
        const emailNotifications = db.getUserEmailNotifications(userId, 30);
        const depositAllocations = db.getDepositAllocationsByUser(userId, 30);
        return res.json({
            success: true,
            deliveryHistory,
            emailNotifications,
            depositAllocations
        });
    } catch (err) {
        console.error("Get notification history error:", err);
        return res.status(500).json({
            success: false,
            error: "Failed to load notification history."
        });
    }
});

// Ensure any unmatched /api/* route returns a JSON 404 response (never an HTML 404 page)
app.use("/api", (req, res) => {
    return res.status(404).json({
        success: false,
        error: `API endpoint not found: ${req.method} ${req.originalUrl}`
    });
});


// -----------------------------
// START SERVER
// -----------------------------

if (require.main === module) {
    emailService.startPaymentReminderScheduler();
    emailService.startWeeklyInsightsScheduler();
    const httpServer = app.listen(PORT, () => {
        console.log(
            `FundIQ is running at http://localhost:${PORT} (Plaid: ${isPlaidConfigured() ? getPlaidEnvName() : "unconfigured"}, Email: ${emailService.getEmailConfig().provider})`
        );
    });
    httpServer.on("error", (err) => {
        if (err && err.code === "EADDRINUSE") {
            console.error(
                `[FundIQ Error] Port ${PORT} is already in use by another process. Stop the existing process on port ${PORT} and run "npm start" again so updated routes are loaded.`
            );
        } else {
            console.error("[FundIQ Server Error]:", err);
        }
        process.exit(1);
    });
}

module.exports = app;