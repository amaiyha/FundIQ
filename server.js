const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const OpenAI = require("openai");
const path = require("path");
require("dotenv").config();
const db = require("./db");
const {
    ASSISTANT_IDENTITY,
    SUGGESTED_PROMPTS,
    SYSTEM_PROMPT,
    getHonestFallbackResponse
} = require("./assistantKnowledge");

const app = express();

const PORT = 3000;


// -----------------------------
// OPENAI CONNECTION
// -----------------------------

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});


// -----------------------------
// MIDDLEWARE
// -----------------------------

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
// CHATBOT CONFIG ROUTE
// -----------------------------
app.get("/api/chat/config", (req, res) => {
    res.json({
        name: ASSISTANT_IDENTITY.name,
        fullName: ASSISTANT_IDENTITY.fullName,
        role: ASSISTANT_IDENTITY.role,
        suggestedPrompts: SUGGESTED_PROMPTS
    });
});


// -----------------------------
// CHATBOT INTERACTION ROUTE
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

        // Try OpenAI Chat Completions
        try {
            if (!process.env.OPENAI_API_KEY) {
                throw new Error("OPENAI_API_KEY is not configured.");
            }

            const messages = [
                { role: "system", content: SYSTEM_PROMPT }
            ];

            // Add authenticated user context or guest boundary
            if (req.session && req.session.userId) {
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

            const reply = completion.choices[0]?.message?.content?.trim() || "";

            return res.json({
                success: true,
                mode: "openai",
                model: modelName,
                reply: reply
            });

        } catch (openAIError) {
            console.log("Penny OpenAI Chat Error:", openAIError.message);

            // Resilient honest fallback mode
            const honestReply = getHonestFallbackResponse(sanitizedMessage, Boolean(isGuest));

            return res.json({
                success: true,
                mode: "demo",
                reply: honestReply,
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

        const user = db.findUserByUsername(cleanUsername);

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
        const wallet = db.getUserWallet(req.session.userId);
        return res.json({ success: true, wallet });
    } catch (err) {
        console.error("Get wallet error:", err);
        return res.status(500).json({ success: false, error: "Failed to retrieve wallet." });
    }
});

// Update Authenticated User's Wallet
app.put("/api/wallet", requireAuth, (req, res) => {
    try {
        const { bills, spending, savings } = req.body;
        const updated = db.setUserWallet(req.session.userId, {
            bills: Number(bills) || 0,
            spending: Number(spending) || 0,
            savings: Number(savings) || 0
        });
        return res.json({ success: true, wallet: updated });
    } catch (err) {
        console.error("Update wallet error:", err);
        return res.status(500).json({ success: false, error: "Failed to update wallet." });
    }
});

// Clear Wallet: Resets balances ONLY, preserving calendar & payments
app.post("/api/wallet/clear", requireAuth, (req, res) => {
    try {
        const cleared = db.clearUserWallet(req.session.userId);
        return res.json({
            success: true,
            message: "Wallet balances cleared to $0.00. Your calendar and payment schedule remain intact.",
            wallet: cleared
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
app.post("/api/payments", requireAuth, (req, res) => {
    try {
        const updated = db.setUserPayments(req.session.userId, req.body);
        return res.json({ success: true, payments: updated });
    } catch (err) {
        console.error("Save payments error:", err);
        return res.status(500).json({ success: false, error: "Failed to save payments." });
    }
});

// Complete Payment: Idempotent deduction from authenticated user's wallet
app.post("/api/payments/complete", requireAuth, (req, res) => {
    try {
        const { occurrenceId, amount, category } = req.body;
        const numAmount = Number(amount);

        if (!occurrenceId || isNaN(numAmount) || numAmount <= 0 || !category) {
            return res.status(400).json({ success: false, error: "Invalid payment completion data." });
        }

        const payments = db.getUserPayments(req.session.userId);
        const wallet = db.getUserWallet(req.session.userId);

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
            return res.status(400).json({
                success: false,
                reason: "INSUFFICIENT_FUNDS",
                available: currentBal,
                required: numAmount,
                error: `Insufficient funds in ${category.toUpperCase()}. Balance: $${currentBal.toFixed(2)}, Required: $${numAmount.toFixed(2)}`
            });
        }

        // Deduct exactly once
        wallet[category] = Math.round((currentBal - numAmount) * 100) / 100;

        if (!payments.completions) payments.completions = {};
        payments.completions[occurrenceId] = {
            isCompleted: true,
            completedAt: new Date().toISOString(),
            deductedAmount: numAmount,
            deductedCategory: category
        };

        db.setUserWallet(req.session.userId, wallet);
        db.setUserPayments(req.session.userId, payments);

        return res.json({
            success: true,
            wallet,
            payments
        });

    } catch (err) {
        console.error("Complete payment error:", err);
        return res.status(500).json({ success: false, error: "Failed to complete payment." });
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

        return res.json({
            success: true,
            wallet,
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
// START SERVER
// -----------------------------

app.listen(PORT, () => {

    console.log(
        `FundIQ is running at http://localhost:${PORT}`
    );

});