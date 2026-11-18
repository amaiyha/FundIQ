// assistantKnowledge.js - Configurable Knowledge Base & Prompt for Penny (FundIQ Assistant)
const db = require("./db");

const ASSISTANT_IDENTITY = {
    name: "Penny",
    fullName: "Penny — Your FundIQ Assistant",
    role: "AI-powered financial organization and educational assistant for FundIQ",
    persona: "Friendly, supportive, encouraging, and non-judgmental. Budgeting can feel intimidating or stressful, so Penny keeps things clear, practical, and grounded in trusted government financial education resources."
};

const SUGGESTED_PROMPTS = [
    "How does FDIC deposit insurance protect my savings?",
    "What does the CFPB recommend for budgeting & bills?",
    "How does FundIQ's AI Money Sorter allocate deposits?",
    "What are SEC and IRS tips for saving & taxes?"
];

const INFORMATIONAL_DISCLAIMER =
    "Disclaimer: Responses from Penny are for educational and organizational purposes only and do not constitute certified financial, investment, tax, or legal advice.";

const SYSTEM_PROMPT = `
You are ${ASSISTANT_IDENTITY.fullName}.
Your purpose is to help users organize their money with FundIQ and answer financial questions using verified, trustworthy public financial education sources.

--- YOUR PERSONALITY & TONE ---
- Friendly, warm, non-judgmental, and encouraging.
- Speak in clear, plain English without unnecessary jargon.
- Keep answers structured, concise, and practical.

--- TRUSTED FINANCIAL SOURCES REQUIREMENT ---
When answering financial questions, prioritize and cite authoritative U.S. government and regulatory financial education bodies:
1. Consumer Financial Protection Bureau (CFPB) — https://www.consumerfinance.gov/consumer-tools/
2. Federal Deposit Insurance Corporation (FDIC — Money Smart) — https://www.fdic.gov/resources/consumers/money-smart/
3. Federal Trade Commission (FTC — Consumer Advice) — https://consumer.ftc.gov/credit-loans-and-debt
4. Internal Revenue Service (IRS) — https://www.irs.gov/individuals
5. U.S. Securities and Exchange Commission (SEC — Investor.gov) — https://www.investor.gov/introduction-investing
6. MyMoney.gov (Federal Financial Literacy and Education Commission) — https://www.mymoney.gov/

Rules for Citations & Accuracy:
- Include the official source name and clickable markdown link (e.g., [Consumer Financial Protection Bureau (CFPB)](https://www.consumerfinance.gov/consumer-tools/)) whenever referencing financial guidance.
- Clearly distinguish **General Financial Education** (from CFPB, FDIC, FTC, IRS, SEC) from **Personalized FundIQ Suggestions** (how the user can organize their Bills, Savings, and Spending buckets inside FundIQ).
- NEVER invent financial statistics, banking policies, interest rates, APYs, tax brackets, or source citations.
- If reliable information on a specific bank policy or rate cannot be verified from the provided context, explicitly tell the user you cannot verify that specific policy or rate and direct them to their financial institution or official regulator.
- Never claim to have access to a user's private bank policies or account information unless that connected account summary is explicitly provided in the authenticated session context.
- Always end financial answers with a brief disclaimer stating that AI responses are informational and not professional financial advice.

--- FUNDIQ CORE FEATURES ---
1. Wallet (wallet.html):
   - Organizes money into 3 core buckets: Savings, Bills, and Spending.
   - Each bucket has expandable dropdown subcategories (hidden by default until the user clicks the category dropdown arrow).
   - Displays both Manual Wallet balances and read-only Live Bank balances (connected via Plaid).
2. AI Deposit Notifications & Money Sorter (sorter.html):
   - When a deposit is detected, FundIQ generates a **Proposed Allocation** across Bills, Savings, and Spending based on the user's saved allocation percentages and upcoming bills.
   - FundIQ never transfers real money automatically and never updates actual Wallet balances until the user reviews, optionally edits, and explicitly approves the proposed allocation.
3. Weekly AI Financial Insights (profile.html & Sunday schedule):
   - Every Sunday (in the user's selected time zone and delivery time), FundIQ sends a Weekly Financial Summary via Email, SMS, or both.
   - Summarizes total weekly spending, % change vs. the prior week, spending breakdown, categories where spending increased or decreased, total weekly deposits, connected account balances, and actionable insights.
4. Payment Calendar & Upcoming Bills (home.html):
   - Tracks one-time and recurring bills (weekly, biweekly, monthly, yearly), including recurring bills detected from Plaid transaction history (marked as Predicted until confirmed).
`.trim();

/**
 * Build context-enriched prompt with matched trusted sources and optional authenticated user summary.
 */
function buildTrustedSourcesContext(userMessage, userFinancialContext = null) {
    const matchedSources = db.searchTrustedFinancialSources(userMessage, 3);
    const sourceLines = matchedSources.map(
        (s) => `- ${s.agencyName} (${s.agencyShort}): "${s.title}" — ${s.url}\n  Guidance: ${s.summaryGuidance}`
    );

    let contextBlock = `VERIFIED TRUSTED FINANCIAL SOURCES FOR THIS QUERY:\n${sourceLines.join("\n")}\n`;

    if (userFinancialContext) {
        contextBlock += `\nAUTHENTICATED USER FUNDIQ CONTEXT (Only reference if relevant to their question; do not invent policies outside this data):\n${userFinancialContext}\n`;
    } else {
        contextBlock += `\nUSER ACCOUNT CONTEXT: No connected bank policy details or private account balances are loaded for this turn. Do not claim access to their bank's specific terms or policies.\n`;
    }

    return {
        matchedSources,
        contextBlock
    };
}

/**
 * Honest, source-backed fallback response when the Anthropic Claude API key is not configured
 * or when the API is temporarily unreachable. Includes clickable trusted source links and disclaimer.
 */
function getHonestFallbackResponse(userMessage, isGuest = false, userFinancialContext = null) {
    const text = (userMessage || "").toLowerCase();
    const matchedSources = db.searchTrustedFinancialSources(userMessage, 3);

    const formatSourceLinks = (sources) =>
        sources
            .map((s) => `- [${s.agencyName} (${s.agencyShort}) — ${s.title}](${s.url})`)
            .join("\n");

    if (
        text.includes("unverified") ||
        text.includes("exact apy") ||
        text.includes("bank policy") ||
        text.includes("overdraft fee of my bank")
    ) {
        return [
            "**General Financial Education:**",
            "I cannot verify your specific bank's internal fee schedule, exact APY, or proprietary account policies because FundIQ only receives read-only balance and transaction summaries from connected institutions—not their legal account agreements. According to the [Consumer Financial Protection Bureau (CFPB)](https://www.consumerfinance.gov/consumer-tools/) and the [FDIC](https://www.fdic.gov/resources/consumers/money-smart/), you should review your bank's official Truth in Savings disclosure or contact your institution directly for exact rate and fee terms.",
            "",
            "**Trusted Sources:**",
            formatSourceLinks(matchedSources),
            "",
            `*${INFORMATIONAL_DISCLAIMER}*`
        ].join("\n");
    }

    if (text.includes("fdic") || text.includes("insur") || text.includes("safe") || text.includes("savings account")) {
        return [
            "**General Financial Education:**",
            "According to the [Federal Deposit Insurance Corporation (FDIC)](https://www.fdic.gov/resources/consumers/money-smart/), standard FDIC deposit insurance covers up to **$250,000 per depositor, per insured bank, for each account ownership category** in the event of a bank failure. The [CFPB](https://www.consumerfinance.gov/consumer-tools/) also recommends keeping your emergency fund in an insured depository savings account separate from your everyday checking account.",
            "",
            "**Personalized FundIQ Suggestion:**",
            "In FundIQ, you can map your connected savings account to your **Savings (Rainy Day)** bucket on the Profile page and expand the Savings dropdown on the Wallet page to track goals like your *Emergency fund* separately from *Bills* and *Spending*.",
            "",
            "**Trusted Sources:**",
            formatSourceLinks(matchedSources),
            "",
            `*${INFORMATIONAL_DISCLAIMER}*`
        ].join("\n");
    }

    if (text.includes("tax") || text.includes("irs") || text.includes("withholding") || text.includes("1099") || text.includes("refund")) {
        return [
            "**General Financial Education:**",
            "The [Internal Revenue Service (IRS)](https://www.irs.gov/individuals) recommends reviewing your paycheck withholding annually and setting aside funds proactively if you receive freelance, side-gig, or 1099 income so you are prepared for quarterly or annual tax obligations.",
            "",
            "**Personalized FundIQ Suggestion:**",
            "When a new deposit arrives in FundIQ, you can customize your proposed deposit allocation in the **Money Sorter** or **Wallet** to reserve a portion in your **Bills** or **Savings** bucket before approving the split.",
            "",
            "**Trusted Sources:**",
            formatSourceLinks(matchedSources),
            "",
            `*${INFORMATIONAL_DISCLAIMER}*`
        ].join("\n");
    }

    if (text.includes("invest") || text.includes("sec") || text.includes("stock") || text.includes("retirement") || text.includes("compound")) {
        return [
            "**General Financial Education:**",
            "According to the [U.S. Securities and Exchange Commission (SEC) at Investor.gov](https://www.investor.gov/introduction-investing), building a solid financial foundation starts with paying off high-interest debt and maintaining an emergency savings buffer before taking on market risk. When investing for long-term goals, the SEC emphasizes diversification and checking investment fees.",
            "",
            "**Personalized FundIQ Suggestion:**",
            "You can use FundIQ's **Weekly AI Financial Insights** and **Savings** subcategories to make sure your monthly bills and emergency reserve are consistently funded first.",
            "",
            "**Trusted Sources:**",
            formatSourceLinks(matchedSources),
            "",
            `*${INFORMATIONAL_DISCLAIMER}*`
        ].join("\n");
    }

    if (text.includes("scam") || text.includes("fraud") || text.includes("ftc") || text.includes("identity") || text.includes("credit")) {
        return [
            "**General Financial Education:**",
            "The [Federal Trade Commission (FTC)](https://consumer.ftc.gov/credit-loans-and-debt) and [CFPB](https://www.consumerfinance.gov/consumer-tools/) advise consumers never to share banking passwords or one-time verification codes, to review bank statements regularly for unauthorized charges, and to check credit reports for free at AnnualCreditReport.com.",
            "",
            "**Personalized FundIQ Suggestion:**",
            "FundIQ connects to banks strictly in read-only mode via Plaid and never executes bank transfers or changes your Wallet balances without your explicit review and approval.",
            "",
            "**Trusted Sources:**",
            formatSourceLinks(matchedSources),
            "",
            `*${INFORMATIONAL_DISCLAIMER}*`
        ].join("\n");
    }

    if (text.includes("sorter") || text.includes("deposit") || text.includes("allocate") || text.includes("split")) {
        return [
            "**General Financial Education:**",
            "Federal financial literacy guidance from [MyMoney.gov](https://www.mymoney.gov/) and the [CFPB](https://www.consumerfinance.gov/consumer-tools/) recommends assigning every paycheck a clear plan—covering essential obligations first, paying yourself into savings, and setting a clear limit for discretionary spending.",
            "",
            "**Personalized FundIQ Suggestion:**",
            "When a deposit is detected in FundIQ, Penny uses your saved allocation percentages (defaulting to 50% Bills, 30% Savings, 20% Spending) to create a **Proposed Allocation**. You can review the proposed vs. actual balances, adjust the dollar amounts for each bucket, and click **Approve Allocation** to update your Wallet.",
            "",
            "**Trusted Sources:**",
            formatSourceLinks(matchedSources),
            "",
            `*${INFORMATIONAL_DISCLAIMER}*`
        ].join("\n");
    }

    return [
        "**General Financial Education:**",
        "Trusted federal resources like the [Consumer Financial Protection Bureau (CFPB)](https://www.consumerfinance.gov/consumer-tools/), [FDIC Money Smart](https://www.fdic.gov/resources/consumers/money-smart/), and [MyMoney.gov](https://www.mymoney.gov/) recommend organizing income into three core priorities: essential bills, emergency and goal savings, and planned discretionary spending.",
        "",
        "**Personalized FundIQ Suggestion:**",
        isGuest
            ? "Log in to your FundIQ account to view your expandable **Wallet** categories, review **Proposed Deposit Allocations**, and receive **Weekly AI Financial Insights** every Sunday!"
            : "You can expand each category dropdown on your **Wallet** page to inspect your subcategories, review or edit proposed deposit splits in the **Money Sorter**, or configure your Sunday **Weekly AI Financial Summary** on the **Profile** page.",
        "",
        "**Trusted Sources:**",
        formatSourceLinks(matchedSources),
        "",
        `*${INFORMATIONAL_DISCLAIMER}*`
    ].join("\n");
}

module.exports = {
    ASSISTANT_IDENTITY,
    SUGGESTED_PROMPTS,
    INFORMATIONAL_DISCLAIMER,
    SYSTEM_PROMPT,
    buildTrustedSourcesContext,
    getHonestFallbackResponse
};
