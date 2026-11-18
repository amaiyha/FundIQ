/**
 * FundIQ - Reusable Email Notification Service & Payment Reminder Scheduler (emailService.js)
 *
 * Handles:
 *  A. Payment due reminders (on due date & configurable advance reminder, unpaid only, deduplicated)
 *  B. Deposit confirmations (amount, date, wallet category, deduplicated)
 *  C. Payment submitted vs. locally completed notifications (honestly distinguishing local wallet
 *     completion from external payment processor submission; never falsely claims bank transfers)
 */

const net = require("node:net");
const tls = require("node:tls");
const crypto = require("node:crypto");
const db = require("./db");

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function isValidEmail(email) {
    if (!email || typeof email !== "string") return false;
    return EMAIL_REGEX.test(email.trim());
}

function escapeHtml(str) {
    return String(str === null || str === undefined ? "" : str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatMoney(amount) {
    return `$${(Number(amount) || 0).toFixed(2)}`;
}

/**
 * Inspect current environment configuration for email delivery
 */
function getEmailConfig() {
    const dryRun =
        String(process.env.EMAIL_DRY_RUN || "").toLowerCase() === "true" ||
        String(process.env.EMAIL_MODE || "").toLowerCase() === "test";

    const smtpHost = (process.env.SMTP_HOST || "").trim();
    const smtpPort = Number(process.env.SMTP_PORT) || 587;
    const smtpUser = (process.env.SMTP_USER || "").trim();
    const smtpPass = process.env.SMTP_PASS || "";
    const smtpSecure =
        String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || smtpPort === 465;
    const smtpRequireTls =
        String(process.env.SMTP_REQUIRE_TLS || "").toLowerCase() === "true";

    const resendApiKey = (process.env.RESEND_API_KEY || "").trim();
    const sendgridApiKey = (process.env.SENDGRID_API_KEY || "").trim();
    const fromAddress = (
        process.env.SMTP_FROM ||
        process.env.EMAIL_FROM ||
        "FundIQ Notifications <notifications@fundiq.local>"
    ).trim();

    let provider = "dry_run";
    if (!dryRun) {
        if (smtpHost) {
            provider = "smtp";
        } else if (resendApiKey) {
            provider = "resend";
        } else if (sendgridApiKey) {
            provider = "sendgrid";
        }
    }

    return {
        configured: provider !== "dry_run",
        dryRun: provider === "dry_run",
        provider,
        fromAddress,
        smtp: {
            host: smtpHost,
            port: smtpPort,
            user: smtpUser,
            pass: smtpPass,
            secure: smtpSecure,
            requireTls: smtpRequireTls
        },
        resendApiKey,
        sendgridApiKey,
        paymentProcessorEnabled:
            String(process.env.PAYMENT_PROCESSOR_ENABLED || "").toLowerCase() === "true"
    };
}

/**
 * Build a FundIQ-branded HTML email wrapper
 */
function buildFundIQEmailHtml({ eyebrow, title, greetingName, leadText, detailsRows = [], calloutBox = null, footerNote = null }) {
    const rowsHtml = detailsRows
        .map(
            (r) => `
            <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #ECECEF; color: #6B7280; font-size: 13px;">${escapeHtml(r.label)}</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #ECECEF; color: #111827; font-size: 13px; font-weight: 700; text-align: right;">${escapeHtml(r.value)}</td>
            </tr>`
        )
        .join("");

    const calloutHtml = calloutBox
        ? `<div style="margin-top: 18px; padding: 12px 14px; border-radius: 10px; background: ${calloutBox.bg || "#F3E8FF"}; border: 1px solid ${calloutBox.border || "#D8B4FE"}; color: ${calloutBox.color || "#5B21B6"}; font-size: 12.5px; line-height: 1.5;">
               <strong>${escapeHtml(calloutBox.heading || "Important:")}</strong> ${escapeHtml(calloutBox.text)}
           </div>`
        : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0; padding:24px; background:#F7F7F9; font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; color:#111827;">
    <div style="max-width:560px; margin:0 auto; background:#FFFFFF; border:1px solid #ECECEF; border-radius:18px; overflow:hidden;">
        <div style="background:linear-gradient(120deg, #130F1D 0%, #381D68 100%); padding:22px 28px; color:#FFFFFF;">
            <div style="font-size:10px; font-weight:700; letter-spacing:0.14em; text-transform:uppercase; color:#C4B5FD; margin-bottom:6px;">
                ${escapeHtml(eyebrow || "FUNDIQ NOTIFICATION")}
            </div>
            <h1 style="margin:0; font-size:20px; font-weight:800; color:#FFFFFF;">${escapeHtml(title)}</h1>
        </div>
        <div style="padding:24px 28px;">
            <p style="margin:0 0 12px; font-size:14px; color:#111827;">Hello ${escapeHtml(greetingName || "there")},</p>
            <p style="margin:0 0 18px; font-size:14px; line-height:1.55; color:#4B5563;">${escapeHtml(leadText)}</p>
            ${
                rowsHtml
                    ? `<table style="width:100%; border-collapse:collapse; margin:8px 0 14px;"><tbody>${rowsHtml}</tbody></table>`
                    : ""
            }
            ${calloutHtml}
            <p style="margin:20px 0 0; font-size:12px; color:#9CA3AF; line-height:1.5;">
                ${escapeHtml(footerNote || "You are receiving this email because notifications are enabled on your FundIQ account. You can manage your notification preferences anytime in your FundIQ Wallet & Profile settings.")}
            </p>
        </div>
    </div>
</body>
</html>`;
}

/**
 * Low-level native Node.js SMTP sender (supports plain SMTP, SMTPS 465, and STARTTLS 587)
 */
function extractEmailAddress(addr) {
    const match = String(addr).match(/<([^>]+)>/);
    return (match ? match[1] : String(addr)).trim();
}

function sendViaNativeSmtp(smtpConfig, { from, to, subject, text, html }) {
    return new Promise((resolve, reject) => {
        const timeoutMs = Number(process.env.SMTP_TIMEOUT_MS) || 8000;
        let socket = null;
        let settled = false;
        let buffer = "";

        const finish = (err, result) => {
            if (settled) return;
            settled = true;
            try {
                if (socket && !socket.destroyed) socket.end();
            } catch (_) {}
            if (err) reject(err);
            else resolve(result);
        };

        const waitResponse = () =>
            new Promise((resWait, rejWait) => {
                const onData = (chunk) => {
                    buffer += chunk.toString("utf8");
                    const lines = buffer.split(/\r?\n/);
                    // Keep incomplete trailing line in buffer
                    buffer = lines.pop() || "";
                    for (const line of lines) {
                        if (!line) continue;
                        // Final line of an SMTP response has a space at index 3 (e.g., "250 OK")
                        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
                            socket.removeListener("data", onData);
                            socket.removeListener("error", onErr);
                            const code = Number(line.slice(0, 3));
                            if (code >= 400) {
                                rejWait(new Error(`SMTP Error ${line}`));
                            } else {
                                resWait({ code, line });
                            }
                            return;
                        }
                    }
                };
                const onErr = (e) => {
                    socket.removeListener("data", onData);
                    rejWait(e);
                };
                socket.on("data", onData);
                socket.once("error", onErr);
            });

        const sendCmd = async (cmd) => {
            socket.write(`${cmd}\r\n`);
            return waitResponse();
        };

        const runProtocol = async () => {
            try {
                await waitResponse(); // 220 banner
                await sendCmd(`EHLO fundiq.local`);

                if (!smtpConfig.secure && smtpConfig.requireTls) {
                    await sendCmd("STARTTLS");
                    socket = tls.connect({
                        socket,
                        servername: smtpConfig.host
                    });
                    await new Promise((r, j) => {
                        socket.once("secureConnect", r);
                        socket.once("error", j);
                    });
                    await sendCmd(`EHLO fundiq.local`);
                }

                if (smtpConfig.user && smtpConfig.pass) {
                    const token = Buffer.from(`\0${smtpConfig.user}\0${smtpConfig.pass}`, "utf8").toString("base64");
                    await sendCmd(`AUTH PLAIN ${token}`);
                }

                const mailFrom = extractEmailAddress(from);
                const rcptTo = extractEmailAddress(to);
                await sendCmd(`MAIL FROM:<${mailFrom}>`);
                await sendCmd(`RCPT TO:<${rcptTo}>`);
                await sendCmd("DATA");

                const boundary = `fiq_${crypto.randomBytes(12).toString("hex")}`;
                const msgId = `<${crypto.randomUUID()}@fundiq.local>`;
                const mimeMessage = [
                    `From: ${from}`,
                    `To: <${rcptTo}>`,
                    `Subject: ${subject}`,
                    `Message-ID: ${msgId}`,
                    `Date: ${new Date().toUTCString()}`,
                    `MIME-Version: 1.0`,
                    `Content-Type: multipart/alternative; boundary="${boundary}"`,
                    ``,
                    `--${boundary}`,
                    `Content-Type: text/plain; charset="UTF-8"`,
                    `Content-Transfer-Encoding: 8bit`,
                    ``,
                    text,
                    ``,
                    `--${boundary}`,
                    `Content-Type: text/html; charset="UTF-8"`,
                    `Content-Transfer-Encoding: 8bit`,
                    ``,
                    html,
                    ``,
                    `--${boundary}--`,
                    `.`
                ]
                    .map((line) => (line.startsWith(".") && line !== "." ? `.${line}` : line))
                    .join("\r\n");

                await sendCmd(mimeMessage);
                await sendCmd("QUIT").catch(() => {});
                finish(null, { messageId: msgId, provider: "smtp" });
            } catch (err) {
                finish(err);
            }
        };

        const connOptions = {
            host: smtpConfig.host,
            port: smtpConfig.port
        };

        socket = smtpConfig.secure
            ? tls.connect({ ...connOptions, servername: smtpConfig.host }, runProtocol)
            : net.createConnection(connOptions, runProtocol);

        socket.setTimeout(timeoutMs, () => {
            finish(new Error(`SMTP connection timed out after ${timeoutMs}ms`));
        });
        socket.on("error", (err) => finish(err));
    });
}

/**
 * Send via Resend or SendGrid HTTP API if configured
 */
async function sendViaHttpApi(config, { from, to, subject, text, html }) {
    if (config.provider === "resend") {
        const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${config.resendApiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ from, to: [to], subject, text, html })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.message || `Resend API HTTP ${res.status}`);
        }
        return { messageId: data.id || `resend_${Date.now()}`, provider: "resend" };
    }

    if (config.provider === "sendgrid") {
        const fromEmail = extractEmailAddress(from);
        const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${config.sendgridApiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                personalizations: [{ to: [{ email: to }] }],
                from: { email: fromEmail, name: "FundIQ Notifications" },
                subject,
                content: [
                    { type: "text/plain", value: text },
                    { type: "text/html", value: html }
                ]
            })
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`SendGrid API HTTP ${res.status}: ${errText.slice(0, 120)}`);
        }
        return {
            messageId: res.headers.get("x-message-id") || `sg_${Date.now()}`,
            provider: "sendgrid"
        };
    }

    throw new Error(`Unsupported email provider: ${config.provider}`);
}

/**
 * Dispatch an SMS notification when SMS preferences are enabled, strictly respecting
 * smsEnabled and per-event SMS toggles independently of Email notifications.
 */
async function dispatchSmsNotification({
    user,
    prefs,
    eventKey,
    eventType,
    subject,
    smsText,
    metadata = {}
}) {
    if (!user || !user.id) {
        return { sent: false, skipped: true, reason: "MISSING_USER" };
    }
    const userId = Number(user.id);
    const activePrefs = prefs || db.getUserNotificationPrefs(userId);

    if (!activePrefs.smsEnabled) {
        return { sent: false, skipped: true, reason: "SMS_NOTIFICATIONS_DISABLED" };
    }
    if (eventType === "payment_due" && !activePrefs.smsPaymentDueEnabled) {
        return { sent: false, skipped: true, reason: "SMS_PAYMENT_DUE_DISABLED" };
    }
    if (eventType === "deposit_made" && !activePrefs.smsDepositEnabled) {
        return { sent: false, skipped: true, reason: "SMS_DEPOSIT_DISABLED" };
    }
    if (
        (eventType === "payment_submitted" || eventType === "payment_completed_local") &&
        !activePrefs.smsPaymentSubmittedEnabled
    ) {
        return { sent: false, skipped: true, reason: "SMS_PAYMENT_ACTIVITY_DISABLED" };
    }

    const smsEventKey = `sms:${eventKey}`;
    const existingSms = db.findEmailNotificationByEventKey(userId, smsEventKey);
    if (existingSms && (existingSms.status === "sent" || existingSms.status === "queued_sms_dry_run")) {
        return {
            sent: false,
            duplicate: true,
            skipped: true,
            reason: "DUPLICATE_SMS_EVENT",
            notification: existingSms
        };
    }

    const phone = String(activePrefs.phoneNumber || user.phone || "").trim();
    const messageId = `<sms_${crypto.randomUUID()}@fundiq.local>`;
    const now = new Date().toISOString();

    const record = db.recordEmailNotification({
        userId,
        eventKey: smsEventKey,
        eventType: `sms_${eventType}`,
        recipientEmail: phone || "sms_subscriber",
        subject: `[SMS] ${subject}`,
        status: "queued_sms_dry_run",
        provider: "sms_dry_run",
        messageId,
        metadata: { ...metadata, channel: "sms", phoneNumber: phone || null },
        bodyText: smsText || subject,
        bodyHtml: null,
        attempts: 1,
        sentAt: now
    });

    return {
        sent: true,
        dryRun: true,
        duplicate: false,
        channel: "sms",
        provider: "sms_dry_run",
        messageId,
        notification: record
    };
}

/**
 * Core dispatch with deduplication, independent Email & SMS preference enforcement, retries, and SQLite audit logging
 */
async function dispatchNotification({
    user,
    eventKey,
    eventType,
    subject,
    text,
    html,
    metadata = {},
    maxRetries = 2
}) {
    if (!user || !user.id) {
        return { sent: false, skipped: true, reason: "MISSING_USER" };
    }

    const userId = Number(user.id);
    const recipientEmail = (user.email || "").trim();
    const prefs = db.getUserNotificationPrefs(userId);

    // Evaluate independent SMS channel
    const smsResult = await dispatchSmsNotification({
        user,
        prefs,
        eventKey,
        eventType,
        subject,
        smsText: subject,
        metadata
    });

    // 1. Check Email deduplication first
    const existing = db.findEmailNotificationByEventKey(userId, eventKey);
    if (existing && (existing.status === "sent" || existing.status === "queued_dry_run")) {
        return {
            sent: false,
            duplicate: true,
            skipped: true,
            reason: "DUPLICATE_EVENT",
            notification: existing,
            sms: smsResult
        };
    }

    // 2. Check user's Email notification preferences and consent independently
    if (!prefs.emailEnabled || prefs.consentEmail === false) {
        return {
            sent: false,
            skipped: true,
            reason: "EMAIL_NOTIFICATIONS_DISABLED",
            sms: smsResult
        };
    }
    if (eventType === "weekly_report" && !prefs.weeklyReportEnabled) {
        return {
            sent: false,
            skipped: true,
            reason: "WEEKLY_REPORT_DISABLED",
            sms: smsResult
        };
    }
    if (eventType === "payment_due" && !prefs.paymentDueEnabled) {
        return {
            sent: false,
            skipped: true,
            reason: "PAYMENT_DUE_NOTIFICATIONS_DISABLED",
            sms: smsResult
        };
    }
    if (eventType === "deposit_made" && !prefs.depositEnabled) {
        return {
            sent: false,
            skipped: true,
            reason: "DEPOSIT_NOTIFICATIONS_DISABLED",
            sms: smsResult
        };
    }
    if (
        (eventType === "payment_submitted" || eventType === "payment_completed_local") &&
        !prefs.paymentSubmittedEnabled
    ) {
        return {
            sent: false,
            skipped: true,
            reason: "PAYMENT_NOTIFICATIONS_DISABLED",
            sms: smsResult
        };
    }

    // 3. Validate email format
    if (!isValidEmail(recipientEmail)) {
        const failedRec = db.recordEmailNotification({
            userId,
            eventKey,
            eventType,
            recipientEmail: recipientEmail || "invalid",
            subject,
            status: "failed",
            provider: "validation",
            errorMessage: "Invalid recipient email address format.",
            metadata,
            bodyText: text,
            bodyHtml: html,
            attempts: 1
        });
        return {
            sent: false,
            skipped: false,
            reason: "INVALID_EMAIL",
            error: "Invalid recipient email address format.",
            notification: failedRec,
            sms: smsResult
        };
    }

    const config = getEmailConfig();

    // 4. If in dry-run / unconfigured mode, persist safely in SQLite without throwing or blocking
    if (config.dryRun) {
        const messageId = `<dryrun_${crypto.randomUUID()}@fundiq.local>`;
        const now = new Date().toISOString();
        const record = db.recordEmailNotification({
            userId,
            eventKey,
            eventType,
            recipientEmail,
            subject,
            status: "queued_dry_run",
            provider: "dry_run",
            messageId,
            metadata,
            bodyText: text,
            bodyHtml: html,
            attempts: 1,
            sentAt: now
        });
        return {
            sent: true,
            dryRun: true,
            duplicate: false,
            provider: "dry_run",
            messageId,
            notification: record,
            sms: smsResult
        };
    }

    // 5. Real delivery with retry support
    let attempt = 0;
    let lastError = null;

    while (attempt < maxRetries) {
        attempt++;
        try {
            let deliveryResult;
            if (config.provider === "smtp") {
                deliveryResult = await sendViaNativeSmtp(config.smtp, {
                    from: config.fromAddress,
                    to: recipientEmail,
                    subject,
                    text,
                    html
                });
            } else {
                deliveryResult = await sendViaHttpApi(config, {
                    from: config.fromAddress,
                    to: recipientEmail,
                    subject,
                    text,
                    html
                });
            }

            const now = new Date().toISOString();
            const record = db.recordEmailNotification({
                userId,
                eventKey,
                eventType,
                recipientEmail,
                subject,
                status: "sent",
                provider: deliveryResult.provider,
                messageId: deliveryResult.messageId,
                metadata,
                bodyText: text,
                bodyHtml: html,
                attempts: attempt,
                sentAt: now
            });

            return {
                sent: true,
                dryRun: false,
                duplicate: false,
                provider: deliveryResult.provider,
                messageId: deliveryResult.messageId,
                attempts: attempt,
                notification: record,
                sms: smsResult
            };
        } catch (err) {
            lastError = err;
            console.warn(
                `FundIQ Email delivery attempt ${attempt}/${maxRetries} failed (${eventType} -> ${recipientEmail}):`,
                err.message
            );
        }
    }

    const failedRecord = db.recordEmailNotification({
        userId,
        eventKey,
        eventType,
        recipientEmail,
        subject,
        status: "failed",
        provider: config.provider,
        errorMessage: lastError ? lastError.message : "Delivery failed",
        metadata,
        bodyText: text,
        bodyHtml: html,
        attempts: attempt
    });

    return {
        sent: false,
        duplicate: false,
        reason: "DELIVERY_FAILED",
        error: lastError ? lastError.message : "Delivery failed",
        attempts: attempt,
        notification: failedRecord,
        sms: smsResult
    };
}

/**
 * EVENT A: Payment Due Notification (on due date or advance reminder for unpaid scheduled payments)
 */
async function sendPaymentDueNotification(user, occurrence, daysUntilDue = 0) {
    if (!occurrence || occurrence.isCompleted) {
        return { sent: false, skipped: true, reason: "ALREADY_PAID" };
    }

    const timingTag = daysUntilDue <= 0 ? "due_today" : `advance_${daysUntilDue}d`;
    const eventKey = `payment_due:${occurrence.occurrenceId}:${timingTag}`;
    const displayName = user.full_name || user.fullName || user.username || "FundIQ Member";
    const categoryLabel = String(occurrence.category || "bills").toUpperCase();
    const amountStr = formatMoney(occurrence.amount);

    const subject =
        daysUntilDue <= 0
            ? `[FundIQ] Payment Due Today: ${occurrence.title} (${amountStr})`
            : `[FundIQ] Upcoming Payment Reminder: ${occurrence.title} due in ${daysUntilDue} ${daysUntilDue === 1 ? "day" : "days"}`;

    const leadText =
        daysUntilDue <= 0
            ? `Your scheduled payment "${occurrence.title}" for ${amountStr} is due today (${occurrence.date}) and is still marked as unpaid on your FundIQ Payment Calendar.`
            : `Heads up! Your scheduled payment "${occurrence.title}" for ${amountStr} is coming up in ${daysUntilDue} ${daysUntilDue === 1 ? "day" : "days"} on ${occurrence.date}.`;

    const text = [
        `Hello ${displayName},`,
        ``,
        leadText,
        ``,
        `Payment Details:`,
        `- Payment: ${occurrence.title}`,
        `- Amount: ${amountStr}`,
        `- Due Date: ${occurrence.date}`,
        `- Wallet Category: ${categoryLabel}`,
        `- Schedule: ${occurrence.recurrence || "one-time"}`,
        `- Status: Unpaid`,
        ``,
        `Note: FundIQ tracks your scheduled payments and manual wallet balances. Marking a payment complete on the FundIQ Calendar updates your manual FundIQ Wallet only and does not transfer money from your bank.`
    ].join("\n");

    const html = buildFundIQEmailHtml({
        eyebrow: daysUntilDue <= 0 ? "PAYMENT DUE TODAY" : "UPCOMING PAYMENT REMINDER",
        title: daysUntilDue <= 0 ? `${occurrence.title} is due today` : `${occurrence.title} is due on ${occurrence.date}`,
        greetingName: displayName,
        leadText,
        detailsRows: [
            { label: "Payment", value: occurrence.title },
            { label: "Amount Due", value: amountStr },
            { label: "Due Date", value: occurrence.date },
            { label: "Wallet Bucket", value: categoryLabel },
            { label: "Status", value: "Unpaid" }
        ],
        calloutBox: {
            heading: "Reminder",
            text: "Once you pay this bill through your financial institution or biller, mark it complete on your FundIQ Calendar to keep your manual wallet balance in sync."
        }
    });

    return dispatchNotification({
        user,
        eventKey,
        eventType: "payment_due",
        subject,
        text,
        html,
        metadata: {
            occurrenceId: occurrence.occurrenceId,
            title: occurrence.title,
            amount: Number(occurrence.amount) || 0,
            dueDate: occurrence.date,
            category: occurrence.category || "bills",
            daysUntilDue
        }
    });
}

/**
 * EVENT B: Deposit Made Notification
 */
async function sendDepositNotification(user, depositInfo = {}) {
    const amount = Number(depositInfo.amount) || 0;
    if (amount <= 0) {
        return { sent: false, skipped: true, reason: "NON_POSITIVE_DEPOSIT" };
    }

    const category = depositInfo.category || "Wallet";
    const dateStr = depositInfo.date || new Date().toISOString().split("T")[0];
    const sourceLabel = depositInfo.source || "FundIQ Wallet Deposit";
    const rawEventId =
        depositInfo.eventId ||
        `${dateStr}:${category}:${amount.toFixed(2)}:${depositInfo.newCategoryBalance || ""}`;
    const eventKey = `deposit_made:${rawEventId}`;

    const displayName = user.full_name || user.fullName || user.username || "FundIQ Member";
    const amountStr = formatMoney(amount);

    const subject = `[FundIQ] Deposit Recorded: ${amountStr} added to ${category}`;
    const leadText = `A deposit of ${amountStr} has been recorded in your FundIQ ${category} balance on ${dateStr}.`;

    const detailsRows = [
        { label: "Deposit Amount", value: amountStr },
        { label: "Date Recorded", value: dateStr },
        { label: "Wallet Category / Account", value: String(category) },
        { label: "Source", value: sourceLabel }
    ];

    if (depositInfo.breakdownText) {
        detailsRows.push({ label: "Allocation Breakdown", value: depositInfo.breakdownText });
    }
    if (depositInfo.newTotalBalance !== undefined && depositInfo.newTotalBalance !== null) {
        detailsRows.push({
            label: "Updated Manual Wallet Total",
            value: formatMoney(depositInfo.newTotalBalance)
        });
    }

    const text = [
        `Hello ${displayName},`,
        ``,
        leadText,
        ``,
        ...detailsRows.map((r) => `- ${r.label}: ${r.value}`),
        ``,
        `Your FundIQ Wallet has been updated.`
    ].join("\n");

    const html = buildFundIQEmailHtml({
        eyebrow: "DEPOSIT CONFIRMATION",
        title: `${amountStr} added to ${category}`,
        greetingName: displayName,
        leadText,
        detailsRows
    });

    return dispatchNotification({
        user,
        eventKey,
        eventType: "deposit_made",
        subject,
        text,
        html,
        metadata: {
            amount,
            date: dateStr,
            category,
            source: sourceLabel,
            eventId: rawEventId
        }
    });
}

/**
 * EVENT C: Payment Submitted vs. Locally Completed Notification
 *
 * Strictly distinguishes:
 *  1. 'submitted_external': A payment actually submitted/processed via an external payment service.
 *  2. 'completed_local': A scheduled payment marked complete locally in the FundIQ Wallet/Calendar
 *     (never falsely claims that money was transferred or submitted to a bank).
 */
async function sendPaymentActivityNotification(user, paymentInfo = {}) {
    const config = getEmailConfig();
    const isExternalSubmission =
        paymentInfo.submissionType === "submitted_external" &&
        Boolean(paymentInfo.processorReference) &&
        (config.paymentProcessorEnabled || Boolean(paymentInfo.allowControlledProcessorTest));

    const amount = Number(paymentInfo.amount) || 0;
    const amountStr = formatMoney(amount);
    const title = paymentInfo.title || "Scheduled Payment";
    const category = String(paymentInfo.category || "bills").toUpperCase();
    const dateStr = paymentInfo.date || new Date().toISOString().split("T")[0];
    const displayName = user.full_name || user.fullName || user.username || "FundIQ Member";

    if (isExternalSubmission) {
        const eventId = paymentInfo.eventId || paymentInfo.processorReference || `${title}:${dateStr}:${amount.toFixed(2)}`;
        const eventKey = `payment_submitted:${eventId}`;
        const serviceName = paymentInfo.serviceName || "External Payment Service";
        const subject = `[FundIQ] Payment Submitted: ${title} (${amountStr})`;
        const leadText = `Your payment of ${amountStr} for "${title}" was submitted and processed through ${serviceName}.`;

        const detailsRows = [
            { label: "Payment", value: title },
            { label: "Amount Submitted", value: amountStr },
            { label: "Activity Type", value: "Submitted Payment (External Processor)" },
            { label: "Payment Service", value: serviceName },
            { label: "Confirmation Ref", value: String(paymentInfo.processorReference) },
            { label: "Date", value: dateStr }
        ];

        const text = [
            `Hello ${displayName},`,
            ``,
            leadText,
            ``,
            ...detailsRows.map((r) => `- ${r.label}: ${r.value}`)
        ].join("\n");

        const html = buildFundIQEmailHtml({
            eyebrow: "PAYMENT SUBMITTED",
            title: `Payment Submitted: ${title}`,
            greetingName: displayName,
            leadText,
            detailsRows,
            calloutBox: {
                bg: "#ECFDF5",
                border: "#A7F3D0",
                color: "#065F46",
                heading: "Payment Submitted",
                text: `Confirmed by ${serviceName} (Ref: ${paymentInfo.processorReference}).`
            }
        });

        return dispatchNotification({
            user,
            eventKey,
            eventType: "payment_submitted",
            subject,
            text,
            html,
            metadata: {
                submissionType: "submitted_external",
                title,
                amount,
                category,
                date: dateStr,
                serviceName,
                processorReference: paymentInfo.processorReference
            }
        });
    }

    // Default / Local completion: Explicitly state this is a local FundIQ Wallet record only
    // and that NO bank transfer or external payment submission occurred.
    const occurrenceId = paymentInfo.occurrenceId || paymentInfo.eventId || `${title}:${dateStr}:${amount.toFixed(2)}`;
    const eventKey = `payment_completed_local:${occurrenceId}`;
    const subject = `[FundIQ] Payment Marked Complete in Wallet: ${title} (${amountStr})`;
    const leadText = `You marked "${title}" (${amountStr}) as completed on your FundIQ Payment Calendar. Your manual ${category} wallet balance has been updated.`;

    const detailsRows = [
        { label: "Payment", value: title },
        { label: "Amount Recorded", value: amountStr },
        { label: "Activity Type", value: "Completed Locally in FundIQ Wallet (No Bank Transfer)" },
        { label: "Wallet Bucket Deducted", value: `Manual ${category}` },
        { label: "Date Marked Complete", value: dateStr }
    ];

    if (paymentInfo.remainingManualBalance !== undefined && paymentInfo.remainingManualBalance !== null) {
        detailsRows.push({
            label: `Remaining Manual ${category} Balance`,
            value: formatMoney(paymentInfo.remainingManualBalance)
        });
    }

    const disclosureText =
        "This action only records the payment as complete in your local FundIQ Wallet and deducts from your manual wallet balance. No money was transferred from your bank account and no payment was submitted to an external biller.";

    const text = [
        `Hello ${displayName},`,
        ``,
        leadText,
        ``,
        ...detailsRows.map((r) => `- ${r.label}: ${r.value}`),
        ``,
        `IMPORTANT NOTICE: ${disclosureText}`
    ].join("\n");

    const html = buildFundIQEmailHtml({
        eyebrow: "LOCAL WALLET RECORD",
        title: `Marked Complete: ${title}`,
        greetingName: displayName,
        leadText,
        detailsRows,
        calloutBox: {
            bg: "#FFFBEB",
            border: "#FDE68A",
            color: "#92400E",
            heading: "Local Record Only — No Bank Transfer",
            text: disclosureText
        }
    });

    return dispatchNotification({
        user,
        eventKey,
        eventType: "payment_completed_local",
        subject,
        text,
        html,
        metadata: {
            submissionType: "completed_local",
            bankTransferOccurred: false,
            occurrenceId,
            title,
            amount,
            category,
            date: dateStr
        }
    });
}

/**
 * Date & Recurrence Expansion Helpers for Scheduled Payment Reminders
 */
function parseLocalDate(dateStr) {
    if (!dateStr || typeof dateStr !== "string") return null;
    const parts = dateStr.split("-").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}

function formatUtcDate(dt) {
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dt.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function expandUserOccurrencesInWindow(paymentData, windowStartDateStr, windowEndDateStr) {
    const startUtc = parseLocalDate(windowStartDateStr);
    const endUtc = parseLocalDate(windowEndDateStr);
    if (!startUtc || !endUtc || endUtc < startUtc) return [];

    const templates = Array.isArray(paymentData?.templates) ? paymentData.templates : [];
    const completions =
        paymentData?.completions && typeof paymentData.completions === "object"
            ? paymentData.completions
            : paymentData?.completed && typeof paymentData.completed === "object"
            ? paymentData.completed
            : {};
    const overrides = paymentData?.overrides && typeof paymentData.overrides === "object" ? paymentData.overrides : {};

    const occurrences = [];

    for (const tpl of templates) {
        const baseStartStr = tpl.startDate || tpl.dueDate;
        const tplStartUtc = parseLocalDate(baseStartStr);
        if (!tplStartUtc) continue;

        const recurrence = String(tpl.recurrence || "none").toLowerCase();
        const candidateDates = [];

        if (recurrence === "none" || recurrence === "once") {
            if (tplStartUtc >= startUtc && tplStartUtc <= endUtc) {
                candidateDates.push(formatUtcDate(tplStartUtc));
            }
        } else if (recurrence === "weekly" || recurrence === "biweekly") {
            const stepDays = recurrence === "weekly" ? 7 : 14;
            let cursor = new Date(tplStartUtc.getTime());
            let guard = 0;
            while (cursor <= endUtc && guard < 1000) {
                if (cursor >= startUtc) {
                    candidateDates.push(formatUtcDate(cursor));
                }
                cursor.setUTCDate(cursor.getUTCDate() + stepDays);
                guard++;
            }
        } else if (recurrence === "monthly") {
            const origDay = tplStartUtc.getUTCDate();
            let year = tplStartUtc.getUTCFullYear();
            let month = tplStartUtc.getUTCMonth();
            let guard = 0;
            while (guard < 240) {
                const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
                const day = Math.min(origDay, daysInMonth);
                const occDate = new Date(Date.UTC(year, month, day));
                if (occDate > endUtc) break;
                if (occDate >= tplStartUtc && occDate >= startUtc) {
                    candidateDates.push(formatUtcDate(occDate));
                }
                month++;
                if (month > 11) {
                    month = 0;
                    year++;
                }
                guard++;
            }
        } else if (recurrence === "yearly") {
            const origDay = tplStartUtc.getUTCDate();
            const month = tplStartUtc.getUTCMonth();
            let year = tplStartUtc.getUTCFullYear();
            let guard = 0;
            while (guard < 50) {
                const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
                const day = Math.min(origDay, daysInMonth);
                const occDate = new Date(Date.UTC(year, month, day));
                if (occDate > endUtc) break;
                if (occDate >= tplStartUtc && occDate >= startUtc) {
                    candidateDates.push(formatUtcDate(occDate));
                }
                year++;
                guard++;
            }
        }

        for (const dateStr of candidateDates) {
            const occurrenceId = `${tpl.id}_${dateStr}`;
            const override = overrides[occurrenceId] || {};
            if (override.isDeleted) continue;

            const compEntry = completions[occurrenceId];
            const isCompleted = Boolean(compEntry && (compEntry.isCompleted || compEntry.completedAt));
            const finalDate = override.date || dateStr;

            occurrences.push({
                occurrenceId,
                templateId: tpl.id,
                title: override.title || tpl.title || "Scheduled Payment",
                amount: override.amount !== undefined ? Number(override.amount) : Number(tpl.amount) || 0,
                category: override.category || tpl.category || "bills",
                recurrence,
                date: finalDate,
                isCompleted
            });
        }
    }

    return occurrences;
}

/**
 * Check a single user's unpaid scheduled payments and send due-today or advance reminders
 */
async function checkUserDuePaymentReminders(userId, referenceDateInput = new Date()) {
    const user = db.findUserById(userId);
    if (!user) return { checked: 0, sent: 0, results: [] };

    const prefs = db.getUserNotificationPrefs(userId);
    const emailDueActive = Boolean(prefs.emailEnabled && prefs.paymentDueEnabled);
    const smsDueActive = Boolean(prefs.smsEnabled && prefs.smsPaymentDueEnabled);
    if (!emailDueActive && !smsDueActive) {
        return { checked: 0, sent: 0, skipped: true, reason: "PREFERENCES_DISABLED", skippedReason: "PREFERENCES_DISABLED", results: [] };
    }

    const refDateStr =
        typeof referenceDateInput === "string" && /^\d{4}-\d{2}-\d{2}$/.test(referenceDateInput)
            ? referenceDateInput
            : formatUtcDate(new Date(referenceDateInput));

    const refUtc = parseLocalDate(refDateStr);
    const maxDays = Math.max(0, Number(prefs.reminderDaysBefore) || 0);
    const endUtc = new Date(refUtc.getTime());
    endUtc.setUTCDate(endUtc.getUTCDate() + maxDays);
    const endDateStr = formatUtcDate(endUtc);

    const paymentData = db.getUserPayments(userId);
    const occurrences = expandUserOccurrencesInWindow(paymentData, refDateStr, endDateStr);

    const results = [];
    let sentCount = 0;
    let duplicateCount = 0;

    for (const occ of occurrences) {
        if (occ.isCompleted) continue;
        const occUtc = parseLocalDate(occ.date);
        if (!occUtc) continue;

        const diffDays = Math.round((occUtc.getTime() - refUtc.getTime()) / (24 * 60 * 60 * 1000));
        // Notify on the due date (0) and on the user's configured advance reminder day (e.g., 3 days before)
        if (diffDays === 0 || (maxDays > 0 && diffDays === maxDays)) {
            const res = await sendPaymentDueNotification(user, occ, diffDays);
            if (res.sent) sentCount++;
            if (res.duplicate) duplicateCount++;
            results.push({
                occurrenceId: occ.occurrenceId,
                title: occ.title,
                dueDate: occ.date,
                daysUntilDue: diffDays,
                ...res
            });
        }
    }

    return {
        checked: occurrences.length,
        sent: sentCount,
        duplicates: duplicateCount,
        referenceDate: refDateStr,
        results
    };
}

/**
 * Run due-payment reminder sweep across all registered users
 */
async function runDuePaymentReminderSweep(referenceDateInput = new Date()) {
    const users = db.getAllUsers();
    const summary = [];
    let totalSent = 0;

    for (const u of users) {
        try {
            const res = await checkUserDuePaymentReminders(u.id, referenceDateInput);
            totalSent += res.sent || 0;
            summary.push({ userId: u.id, username: u.username, ...res });
        } catch (err) {
            console.error(`Reminder sweep error for user ${u.id}:`, err.message);
        }
    }

    return { usersChecked: users.length, totalSent, summary };
}

let reminderIntervalHandle = null;
let weeklySchedulerHandle = null;

function startPaymentReminderScheduler(intervalMs = 15 * 60 * 1000) {
    if (reminderIntervalHandle) return reminderIntervalHandle;
    reminderIntervalHandle = setInterval(() => {
        runDuePaymentReminderSweep(new Date()).catch((err) => {
            console.error("Scheduled payment reminder sweep error:", err.message);
        });
    }, intervalMs);
    return reminderIntervalHandle;
}

/**
 * EVENT D: Proposed Deposit Allocation Notification (Email and/or SMS)
 * Notifies the user when a deposit is detected and presents the AI's proposed split
 * and proposed vs. actual account balances without transferring real money automatically.
 */
async function sendProposedDepositAllocationNotification(user, allocation) {
    if (!user || !user.id || !allocation) {
        return { sent: false, skipped: true, reason: "MISSING_DATA" };
    }

    const displayName = user.full_name || user.fullName || user.username || "FundIQ Member";
    const depAmtStr = formatMoney(allocation.depositAmount);
    const billsAmtStr = formatMoney(allocation.proposed.bills);
    const savingsAmtStr = formatMoney(allocation.proposed.savings);
    const spendingAmtStr = formatMoney(allocation.proposed.spending);

    const beforeCombined = (allocation.balancesBefore && allocation.balancesBefore.combinedWallet) || {
        bills: 0,
        savings: 0,
        spending: 0,
        total: 0
    };
    const propCombined = (allocation.proposedBalances && allocation.proposedBalances.combinedWallet) || {
        bills: allocation.proposed.bills,
        savings: allocation.proposed.savings,
        spending: allocation.proposed.spending,
        total: allocation.depositAmount
    };

    const eventKey = `deposit_allocation:${allocation.depositKey}`;
    const subject = `[FundIQ] New Deposit Detected (${depAmtStr}) — Proposed AI Money Split Ready for Review`;
    const leadText = `A deposit of ${depAmtStr} (${allocation.sourceDescription || "Deposit"}) on ${allocation.depositDate} was detected for ${allocation.accountName || "your account"}. Based on your saved FundIQ allocation preferences, Penny prepared a proposed split for your review. No money has been transferred or applied yet—open FundIQ to adjust or approve this allocation.`;

    const detailsRows = [
        { label: "Deposit Amount", value: depAmtStr },
        { label: "Deposit Date", value: allocation.depositDate },
        { label: "Account / Source", value: `${allocation.accountName || "Connected Account"} (${allocation.sourceDescription || "Deposit"})` },
        { label: "AI Recommended Split — Bills", value: billsAmtStr },
        { label: "AI Recommended Split — Savings", value: savingsAmtStr },
        { label: "AI Recommended Split — Spending", value: spendingAmtStr },
        {
            label: "Current Actual Balances (Unchanged)",
            value: `Bills: ${formatMoney(beforeCombined.bills)} | Savings: ${formatMoney(beforeCombined.savings)} | Spending: ${formatMoney(beforeCombined.spending)} (Total: ${formatMoney(beforeCombined.total)})`
        },
        {
            label: "Proposed Balances After Approval",
            value: `Bills: ${formatMoney(propCombined.bills)} | Savings: ${formatMoney(propCombined.savings)} | Spending: ${formatMoney(propCombined.spending)} (Total: ${formatMoney(propCombined.total)})`
        },
        { label: "Status", value: "Proposed — Awaiting Your Review & Approval in FundIQ" }
    ];

    const text = [
        `Hello ${displayName},`,
        ``,
        leadText,
        ``,
        ...detailsRows.map((r) => `- ${r.label}: ${r.value}`),
        ``,
        `AI Note: ${allocation.aiExplanation || "Allocated according to your saved FundIQ preferences."}`,
        ``,
        `IMPORTANT: FundIQ never transfers real money automatically. Your actual balances remain unchanged until you review, optionally edit, and approve this proposed allocation in FundIQ.`
    ].join("\n");

    const html = buildFundIQEmailHtml({
        eyebrow: "AI DEPOSIT NOTIFICATION & PROPOSED SPLIT",
        title: `${depAmtStr} Deposit Detected — Review Your Proposed Split`,
        greetingName: displayName,
        leadText,
        detailsRows,
        footerNote:
            "Important: This is a proposed allocation only. No real bank transfer has been initiated, and your actual FundIQ Wallet balances will only update after you explicitly approve the allocation."
    });

    const dispatchRes = await dispatchNotification({
        user,
        eventKey,
        eventType: "deposit_made",
        subject,
        text,
        html,
        metadata: {
            event: "deposit_proposed_allocation",
            allocationId: allocation.id,
            depositKey: allocation.depositKey,
            depositAmount: allocation.depositAmount,
            depositDate: allocation.depositDate,
            proposed: allocation.proposed
        }
    });

    if (dispatchRes.sent || (dispatchRes.sms && dispatchRes.sms.sent)) {
        db.markDepositAllocationNotified(user.id, allocation.id);
    }

    return dispatchRes;
}

/**
 * Helper: Determine user's local day of week and HH:MM in their configured IANA time zone.
 */
function getUserZonedTimeParts(dateObj = new Date(), timeZone = "America/Chicago") {
    let safeTz = timeZone || "America/Chicago";
    try {
        Intl.DateTimeFormat("en-US", { timeZone: safeTz });
    } catch (_) {
        safeTz = "America/Chicago";
    }

    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: safeTz,
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    });

    const parts = formatter.formatToParts(dateObj);
    const map = {};
    for (const p of parts) {
        map[p.type] = p.value;
    }
    const hourNum = Number(map.hour || 0) % 24;
    const minNum = Number(map.minute || 0);
    const dateIso = `${map.year}-${map.month}-${map.day}`;

    return {
        timeZone: safeTz,
        weekdayShort: map.weekday, // e.g. 'Sun'
        isSunday: map.weekday === "Sun",
        dateIso,
        hour: hourNum,
        minute: minNum,
        hhmm: `${String(hourNum).padStart(2, "0")}:${String(minNum).padStart(2, "0")}`
    };
}

/**
 * Compute and persist a user's Weekly AI Financial Summary report.
 */
async function generateWeeklyFinancialReport(userId, options = {}) {
    const uid = Number(userId);
    const user = db.findUserById(uid);
    if (!user) {
        const err = new Error("User not found.");
        err.status = 404;
        throw err;
    }

    const prefs = db.getUserNotificationPrefs(uid);
    const refDateStr =
        options.referenceDate && /^\d{4}-\d{2}-\d{2}$/.test(String(options.referenceDate))
            ? String(options.referenceDate)
            : formatUtcDate(new Date());

    const refDt = parseLocalDate(refDateStr) || new Date();
    const weekEndStr = formatUtcDate(refDt);

    const startDt = new Date(refDt.getTime());
    startDt.setUTCDate(startDt.getUTCDate() - 6);
    const weekStartStr = formatUtcDate(startDt);

    const prevEndDt = new Date(startDt.getTime());
    prevEndDt.setUTCDate(prevEndDt.getUTCDate() - 1);
    const prevWeekEndStr = formatUtcDate(prevEndDt);

    const prevStartDt = new Date(prevEndDt.getTime());
    prevStartDt.setUTCDate(prevStartDt.getUTCDate() - 6);
    const prevWeekStartStr = formatUtcDate(prevStartDt);

    // Gather verified Plaid transactions + completed scheduled payments + deposit allocations
    const allTxs = db.getUserPlaidTransactions(uid, 500);
    const paymentData = db.getUserPayments(uid);
    const depositAllocs = db.getDepositAllocationsByUser(uid, 50);
    const summary = db.getFullWalletSummary(uid);
    const connectedAccounts = db.getPlaidAccountsByUser(uid);

    const currentWeekOutflows = [];
    const prevWeekOutflows = [];
    let totalDeposited = 0;

    for (const tx of allTxs) {
        if (tx.pending) continue;
        const amt = Number(tx.amount) || 0;
        if (amt > 0) {
            if (tx.date >= weekStartStr && tx.date <= weekEndStr) {
                currentWeekOutflows.push({
                    name: tx.merchant_name || tx.name || "Expense",
                    category: formatTxCategoryLabel(tx.category_primary || "General"),
                    amount: Math.round(amt * 100) / 100,
                    date: tx.date
                });
            } else if (tx.date >= prevWeekStartStr && tx.date <= prevWeekEndStr) {
                prevWeekOutflows.push({
                    name: tx.merchant_name || tx.name || "Expense",
                    category: formatTxCategoryLabel(tx.category_primary || "General"),
                    amount: Math.round(amt * 100) / 100,
                    date: tx.date
                });
            }
        } else if (amt < 0 && tx.date >= weekStartStr && tx.date <= weekEndStr) {
            // In Plaid, negative amounts on depository accounts represent inflows/deposits
            totalDeposited += Math.abs(amt);
        }
    }

    // Include completed calendar payments during the current/previous week
    const completions = (paymentData && paymentData.completions) || {};
    const templates = (paymentData && Array.isArray(paymentData.templates)) ? paymentData.templates : [];
    for (const [occId, comp] of Object.entries(completions)) {
        if (!comp || !comp.isCompleted) continue;
        const compDate = comp.completedAt ? String(comp.completedAt).split("T")[0] : occId.split("_").pop();
        const amt = Number(comp.deductedAmount) || 0;
        if (amt <= 0 || !compDate) continue;

        const tpl = templates.find((t) => occId.startsWith(`${t.id}_`));
        const itemTitle = (tpl && tpl.title) || "Scheduled Payment";
        const catLabel = formatTxCategoryLabel(comp.deductedCategory || (tpl && tpl.category) || "Bills");

        if (compDate >= weekStartStr && compDate <= weekEndStr) {
            currentWeekOutflows.push({
                name: itemTitle,
                category: catLabel,
                amount: Math.round(amt * 100) / 100,
                date: compDate
            });
        } else if (compDate >= prevWeekStartStr && compDate <= prevWeekEndStr) {
            prevWeekOutflows.push({
                name: itemTitle,
                category: catLabel,
                amount: Math.round(amt * 100) / 100,
                date: compDate
            });
        }
    }

    // Include deposits recorded in deposit_allocations during the current week
    for (const dep of depositAllocs) {
        if (dep.depositDate >= weekStartStr && dep.depositDate <= weekEndStr && dep.status !== "rejected") {
            totalDeposited += Number(dep.depositAmount) || 0;
        }
    }

    // Allow optional sample data injection when explicitly requested for testing
    if (options.includeSampleData && currentWeekOutflows.length === 0 && prevWeekOutflows.length === 0) {
        currentWeekOutflows.push(
            { name: "Housing & Utilities", category: "Bills & Utilities", amount: 145.00, date: weekEndStr },
            { name: "Neighborhood Market", category: "Groceries", amount: 92.40, date: weekEndStr },
            { name: "Local Cafe & Dining", category: "Dining Out", amount: 44.60, date: weekStartStr }
        );
        prevWeekOutflows.push(
            { name: "Housing & Utilities", category: "Bills & Utilities", amount: 145.00, date: prevWeekEndStr },
            { name: "Neighborhood Market", category: "Groceries", amount: 105.00, date: prevWeekEndStr },
            { name: "Local Cafe & Dining", category: "Dining Out", amount: 70.00, date: prevWeekStartStr }
        );
        if (totalDeposited === 0) {
            totalDeposited = 1000.00;
        }
    }

    // A new account with no connected bank accounts, no payments, and no deposits should not have insights generated
    if (
        !options.includeSampleData &&
        currentWeekOutflows.length === 0 &&
        prevWeekOutflows.length === 0 &&
        totalDeposited === 0 &&
        connectedAccounts.length === 0
    ) {
        return {
            report: null,
            notification: null,
            reason: "NO_ACTIVITY"
        };
    }

    const totalSpent = Math.round(currentWeekOutflows.reduce((s, i) => s + i.amount, 0) * 100) / 100;
    const prevWeekSpent = Math.round(prevWeekOutflows.reduce((s, i) => s + i.amount, 0) * 100) / 100;
    totalDeposited = Math.round(totalDeposited * 100) / 100;

    let spendingChangePct = 0;
    if (prevWeekSpent > 0) {
        spendingChangePct = Math.round(((totalSpent - prevWeekSpent) / prevWeekSpent) * 1000) / 10;
    } else if (totalSpent > 0) {
        spendingChangePct = 100;
    }

    // Group by category for current week and previous week
    const currCatMap = new Map();
    const prevCatMap = new Map();
    for (const item of currentWeekOutflows) {
        currCatMap.set(item.category, Math.round(((currCatMap.get(item.category) || 0) + item.amount) * 100) / 100);
    }
    for (const item of prevWeekOutflows) {
        prevCatMap.set(item.category, Math.round(((prevCatMap.get(item.category) || 0) + item.amount) * 100) / 100);
    }

    const spendingBreakdown = Array.from(currCatMap.entries())
        .map(([category, amount]) => ({
            category,
            amount,
            sharePct: totalSpent > 0 ? Math.round((amount / totalSpent) * 1000) / 10 : 0
        }))
        .sort((a, b) => b.amount - a.amount);

    const allCats = new Set([...currCatMap.keys(), ...prevCatMap.keys()]);
    const categoryComparison = Array.from(allCats).map((category) => {
        const currentAmount = currCatMap.get(category) || 0;
        const previousAmount = prevCatMap.get(category) || 0;
        const diffAmount = Math.round((currentAmount - previousAmount) * 100) / 100;
        const changePct =
            previousAmount > 0
                ? Math.round(((currentAmount - previousAmount) / previousAmount) * 1000) / 10
                : currentAmount > 0
                ? 100
                : 0;
        return {
            category,
            currentAmount,
            previousAmount,
            diffAmount,
            changePct,
            direction: diffAmount > 0.01 ? "more" : diffAmount < -0.01 ? "less" : "same"
        };
    });

    const accountBalancesSnapshot = {
        combinedWallet: summary.combinedWallet,
        manualWallet: summary.manualWallet,
        bankBalances: summary.bankBalances,
        connectedAccounts: connectedAccounts.map((a) => ({
            name: a.name,
            institutionName: a.institution_name || "Connected Bank",
            mask: a.mask || "••••",
            subtype: a.subtype || a.type,
            balance: Math.round((Number(a.available_balance ?? a.current_balance) || 0) * 100) / 100
        }))
    };

    // Build deterministic + AI-enhanced insights and actionable suggestions
    const directionWord =
        spendingChangePct < 0
            ? `decreased by ${Math.abs(spendingChangePct)}%`
            : spendingChangePct > 0
            ? `increased by ${spendingChangePct}%`
            : "remained steady (0% change)";

    const spentLessCats = categoryComparison.filter((c) => c.direction === "less");
    const spentMoreCats = categoryComparison.filter((c) => c.direction === "more");

    let aiInsightsText = `During the week of ${weekStartStr} to ${weekEndStr}, you spent ${formatMoney(totalSpent)}, which ${directionWord} compared to ${formatMoney(prevWeekSpent)} the previous week. Total deposits recorded this week were ${formatMoney(totalDeposited)}, and your combined FundIQ & connected account balance stands at ${formatMoney(summary.combinedWallet.total)}.`;

    const aiSuggestions = [];
    if (spentLessCats.length > 0) {
        const topSaved = spentLessCats.sort((a, b) => a.diffAmount - b.diffAmount)[0];
        aiSuggestions.push(
            `You spent ${formatMoney(Math.abs(topSaved.diffAmount))} (${Math.abs(topSaved.changePct)}%) less on ${topSaved.category} this week—consider moving those savings into your Rainy Day / Savings bucket.`
        );
    }
    if (spentMoreCats.length > 0) {
        const topMore = spentMoreCats.sort((a, b) => b.diffAmount - a.diffAmount)[0];
        aiSuggestions.push(
            `Spending in ${topMore.category} rose by ${formatMoney(topMore.diffAmount)} compared to last week. Review your ${topMore.category} subcategory limit in the Wallet tab.`
        );
    }
    if (totalDeposited > totalSpent) {
        const netPositive = Math.round((totalDeposited - totalSpent) * 100) / 100;
        aiSuggestions.push(
            `Positive weekly cash flow of ${formatMoney(netPositive)}! According to CFPB and FDIC Money Smart guidance, setting aside ${ prefs.allocationSavingsPct || 30 }% of new inflows strengthens your emergency buffer.`
        );
    } else {
        aiSuggestions.push(
            `Keep your upcoming bills covered first (${prefs.allocationBillsPct || 50}% target) and check your Payment Calendar for any predicted recurring bills due next week.`
        );
    }

    if (typeof options.aiGenerator === "function") {
        try {
            const customAi = await options.aiGenerator({
                weekStart: weekStartStr,
                weekEnd: weekEndStr,
                totalSpent,
                prevWeekSpent,
                spendingChangePct,
                totalDeposited,
                spendingBreakdown,
                categoryComparison,
                accountBalances: accountBalancesSnapshot
            });
            if (customAi && customAi.insightsText) {
                aiInsightsText = customAi.insightsText;
            }
            if (customAi && Array.isArray(customAi.suggestions) && customAi.suggestions.length > 0) {
                aiSuggestions.splice(0, aiSuggestions.length, ...customAi.suggestions);
            }
        } catch (_) {}
    }

    const savedReport = db.saveWeeklyFinancialReport(uid, {
        weekStart: weekStartStr,
        weekEnd: weekEndStr,
        totalSpent,
        prevWeekSpent,
        spendingChangePct,
        totalDeposited,
        spendingBreakdown,
        categoryComparison,
        accountBalances: accountBalancesSnapshot,
        aiInsightsText,
        aiSuggestions,
        deliveryMethod: prefs.weeklyDeliveryMethod || "email",
        deliveryStatus: "generated"
    });

    if (options.sendNotification) {
        const notifyRes = await sendWeeklyFinancialReportNotification(user, savedReport, options.deliveryMethod);
        return {
            report: db.getWeeklyFinancialReportByWeek(uid, weekStartStr) || savedReport,
            notification: notifyRes
        };
    }

    return {
        report: savedReport,
        notification: null
    };
}

function formatTxCategoryLabel(rawCat) {
    const cleaned = String(rawCat || "General")
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase());
    return cleaned || "General";
}

/**
 * Send the Weekly AI Financial Summary via the user's selected delivery method (email, sms, or both).
 */
async function sendWeeklyFinancialReportNotification(user, report, overrideMethod = null) {
    if (!user || !user.id || !report) {
        return { sent: false, skipped: true, reason: "MISSING_REPORT_OR_USER" };
    }

    const prefs = db.getUserNotificationPrefs(user.id);
    const method = String(overrideMethod || prefs.weeklyDeliveryMethod || "email").toLowerCase();
    const displayName = user.full_name || user.fullName || user.username || "FundIQ Member";
    const eventKey = `weekly_report:${report.weekStart}`;

    const changeStr =
        report.spendingChangePct < 0
            ? `Down ${Math.abs(report.spendingChangePct)}% vs. prior week (${formatMoney(report.prevWeekSpent)})`
            : report.spendingChangePct > 0
            ? `Up ${report.spendingChangePct}% vs. prior week (${formatMoney(report.prevWeekSpent)})`
            : `0% change vs. prior week (${formatMoney(report.prevWeekSpent)})`;

    const breakdownStr =
        Array.isArray(report.spendingBreakdown) && report.spendingBreakdown.length > 0
            ? report.spendingBreakdown.map((b) => `${b.category}: ${formatMoney(b.amount)} (${b.sharePct}%)`).join(" | ")
            : "No categorized expenses recorded this week";

    const moreCats = (report.categoryComparison || []).filter((c) => c.direction === "more");
    const lessCats = (report.categoryComparison || []).filter((c) => c.direction === "less");
    const comparisonStr = [
        moreCats.length > 0
            ? `Spent More: ${moreCats.map((c) => `${c.category} (+${formatMoney(c.diffAmount)})`).join(", ")}`
            : "Spent More: None",
        lessCats.length > 0
            ? `Spent Less: ${lessCats.map((c) => `${c.category} (${formatMoney(c.diffAmount)})`).join(", ")}`
            : "Spent Less: None"
    ].join(" • ");

    const comb = (report.accountBalances && report.accountBalances.combinedWallet) || {
        bills: 0,
        savings: 0,
        spending: 0,
        total: 0
    };

    const subject = `[FundIQ Weekly AI Summary] ${report.weekStart} to ${report.weekEnd}: ${formatMoney(report.totalSpent)} Spent (${changeStr})`;

    const detailsRows = [
        { label: "Week Covered", value: `${report.weekStart} to ${report.weekEnd}` },
        { label: "Total Spent This Week", value: formatMoney(report.totalSpent) },
        { label: "Comparison vs. Previous Week", value: changeStr },
        { label: "Spending Breakdown", value: breakdownStr },
        { label: "Category Changes (More / Less)", value: comparisonStr },
        { label: "Total Deposited This Week", value: formatMoney(report.totalDeposited) },
        {
            label: "Current Account & Wallet Balances",
            value: `Total: ${formatMoney(comb.total)} (Bills: ${formatMoney(comb.bills)}, Savings: ${formatMoney(comb.savings)}, Spending: ${formatMoney(comb.spending)})`
        },
        { label: "AI Financial Insight", value: report.aiInsightsText },
        {
            label: "Actionable Suggestions",
            value: (report.aiSuggestions || []).join(" ")
        }
    ];

    const text = [
        `Hello ${displayName},`,
        ``,
        `Here is your Sunday FundIQ Weekly AI Financial Summary (${report.weekStart} – ${report.weekEnd}):`,
        ``,
        ...detailsRows.map((r) => `- ${r.label}: ${r.value}`),
        ``,
        `Disclaimer: AI financial insights are educational and organizational suggestions, not certified financial advice.`
    ].join("\n");

    const html = buildFundIQEmailHtml({
        eyebrow: "SUNDAY WEEKLY AI FINANCIAL SUMMARY",
        title: `Your Weekly Money Snapshot (${report.weekStart} – ${report.weekEnd})`,
        greetingName: displayName,
        leadText: report.aiInsightsText,
        detailsRows,
        footerNote:
            "Delivered automatically per your FundIQ Weekly AI Summary schedule. Educational insights only; not professional financial advice."
    });

    const smsSummaryText = `[FundIQ Weekly Summary ${report.weekStart}–${report.weekEnd}] Spent: ${formatMoney(report.totalSpent)} (${changeStr}). Deposited: ${formatMoney(report.totalDeposited)}. Balance: ${formatMoney(comb.total)}. Tip: ${(report.aiSuggestions && report.aiSuggestions[0]) || report.aiInsightsText}`;

    let emailRes = { sent: false, skipped: true };
    let smsRes = { sent: false, skipped: true };

    if (method === "email" || method === "both") {
        emailRes = await dispatchNotification({
            user,
            eventKey,
            eventType: "weekly_report",
            subject,
            text,
            html,
            metadata: {
                event: "weekly_financial_report",
                weekStart: report.weekStart,
                weekEnd: report.weekEnd,
                deliveryMethod: method
            }
        });
    }

    if (method === "sms" || method === "both") {
        if (prefs.smsEnabled && prefs.consentSms !== false) {
            smsRes = await dispatchSmsNotification({
                user,
                prefs,
                eventKey: `${eventKey}:sms`,
                eventType: "weekly_report",
                subject: smsSummaryText,
                smsText: smsSummaryText,
                metadata: {
                    event: "weekly_financial_report",
                    weekStart: report.weekStart,
                    weekEnd: report.weekEnd,
                    deliveryMethod: method
                }
            });
            db.recordNotificationDeliveryHistory({
                userId: user.id,
                eventKey: `${eventKey}:sms`,
                category: "weekly_report",
                channel: "sms",
                recipient: prefs.phoneNumber || "sms_subscriber",
                subject: `[SMS] Weekly AI Summary (${report.weekStart})`,
                messagePreview: smsSummaryText,
                status: smsRes.sent ? "sent" : "skipped",
                metadata: { weekStart: report.weekStart }
            });
        } else {
            smsRes = { sent: false, skipped: true, reason: "SMS_DISABLED_OR_NO_CONSENT" };
        }
    }

    const anySent = Boolean(emailRes.sent || smsRes.sent);
    if (anySent) {
        db.saveWeeklyFinancialReport(user.id, {
            ...report,
            deliveryMethod: method,
            deliveryStatus: "sent",
            sentAt: new Date().toISOString()
        });
    }

    return {
        sent: anySent,
        deliveryMethod: method,
        email: emailRes,
        sms: smsRes
    };
}

/**
 * Automatic Sunday Weekly Report Sweep (Timezone-aware per user)
 */
async function checkAndSendDueWeeklyReports(referenceDateObj = new Date()) {
    const users = db.getAllUsers();
    const results = [];
    let sentCount = 0;

    for (const u of users) {
        try {
            const prefs = db.getUserNotificationPrefs(u.id);
            if (!prefs.weeklyReportEnabled) continue;

            const zoned = getUserZonedTimeParts(referenceDateObj, prefs.timezone || "America/Chicago");
            if (!zoned.isSunday) continue;

            const targetTime = prefs.weeklyDeliveryTime || "09:00";
            if (zoned.hhmm < targetTime) continue;

            const existingReport = db.getWeeklyFinancialReportByWeek(u.id, zoned.dateIso);
            if (existingReport && existingReport.deliveryStatus === "sent") {
                continue;
            }

            const gen = await generateWeeklyFinancialReport(u.id, {
                referenceDate: zoned.dateIso,
                sendNotification: true
            });
            if (gen.notification && gen.notification.sent) {
                sentCount++;
            }
            results.push({ userId: u.id, weekEnd: zoned.dateIso, sent: Boolean(gen.notification && gen.notification.sent) });
        } catch (err) {
            console.error(`Weekly report scheduler error for user ${u.id}:`, err.message);
        }
    }

    return { usersChecked: users.length, sentCount, results };
}

function startWeeklyInsightsScheduler(intervalMs = 10 * 60 * 1000) {
    if (weeklySchedulerHandle) return weeklySchedulerHandle;
    weeklySchedulerHandle = setInterval(() => {
        checkAndSendDueWeeklyReports(new Date()).catch((err) => {
            console.error("Weekly insights scheduler error:", err.message);
        });
    }, intervalMs);
    if (weeklySchedulerHandle.unref) weeklySchedulerHandle.unref();
    return weeklySchedulerHandle;
}

module.exports = {
    isValidEmail,
    getEmailConfig,
    formatUtcDate,
    toDateOnlyISO: formatUtcDate,
    dispatchNotification,
    dispatchSmsNotification,
    sendPaymentDueNotification,
    sendDepositNotification,
    sendProposedDepositAllocationNotification,
    sendPaymentActivityNotification,
    generateWeeklyFinancialReport,
    sendWeeklyFinancialReportNotification,
    checkAndSendDueWeeklyReports,
    startWeeklyInsightsScheduler,
    getUserZonedTimeParts,
    expandUserOccurrencesInWindow,
    checkUserDuePaymentReminders,
    runDuePaymentReminderSweep,
    startPaymentReminderScheduler
};
