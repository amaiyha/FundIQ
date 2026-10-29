const moneyForm = document.getElementById("moneyForm");

const statusSection = document.getElementById("statusSection");
const statusMessage = document.getElementById("statusMessage");

const resultSection = document.getElementById("resultSection");

const organizeButton = document.getElementById("organizeButton");

const editButton = document.getElementById("editButton");
const regenerateButton = document.getElementById("regenerateButton");
const acceptButton = document.getElementById("acceptButton");
const rejectButton = document.getElementById("rejectButton");

const amountReceivedInput = document.getElementById("amountReceived");
const billsInput = document.getElementById("bills");
const savingsGoalInput = document.getElementById("savingsGoal");

let userTunedSubInputs = false;

if (billsInput) {
    billsInput.addEventListener("input", () => { userTunedSubInputs = true; });
}
if (savingsGoalInput) {
    savingsGoalInput.addEventListener("input", () => { userTunedSubInputs = true; });
}
if (amountReceivedInput) {
    amountReceivedInput.addEventListener("input", () => {
        const amt = Number(amountReceivedInput.value);
        if (!userTunedSubInputs && !isNaN(amt) && amt > 0) {
            if (billsInput) billsInput.value = Math.round(amt * 0.5 * 100) / 100;
            if (savingsGoalInput) savingsGoalInput.value = Math.round(amt * 0.3 * 100) / 100;
        }
    });
}

// -----------------------------
// SHOW / HIDE FUNCTIONS
// -----------------------------

function show(element) {
    if (element) element.style.display = "block";
}

function hide(element) {
    if (element) element.style.display = "none";
}

// -----------------------------
// STATUS MESSAGE
// -----------------------------

function showStatus(message) {
    show(statusSection);
    statusMessage.innerHTML = message;
}

// -----------------------------
// GET USER INFORMATION
// -----------------------------

function getUserInformation() {
    const amountReceived = Number(
        document.getElementById("amountReceived").value
    );

    const bills = Number(
        document.getElementById("bills").value
    );

    const savingsGoal = Number(
        document.getElementById("savingsGoal").value
    );

    return {
        amountReceived,
        bills,
        savingsGoal
    };
}

// -----------------------------
// VALIDATE INPUT
// -----------------------------

function validateInput(data) {
    if (!data.amountReceived || data.amountReceived <= 0) {
        return "Please enter a valid amount of money received.";
    }

    if (data.bills < 0 || data.savingsGoal < 0) {
        return "Bills and savings cannot be negative.";
    }

    if (data.bills + data.savingsGoal > data.amountReceived) {
        return "Your bills and savings goal are greater than the money you received.";
    }

    return null;
}

// -----------------------------
// CREATE AI PLAN
// -----------------------------

async function createPlan() {
    const data = getUserInformation();
    const validationError = validateInput(data);

    if (validationError) {
        showStatus(`
            <strong>Input Error</strong>
            <p>${validationError}</p>
        `);
        return;
    }

    showStatus(`
        <strong>Organizing your money...</strong>
        <p>FundIQ is creating your suggested plan. Please wait a moment.</p>
    `);

    organizeButton.disabled = true;
    organizeButton.innerHTML = "Creating Plan...";

    const startTime = performance.now();

    try {
        const response = await fetch("/api/allocate", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();
        const endTime = performance.now();
        const responseTime = ((endTime - startTime) / 1000).toFixed(2);

        if (!response.ok) {
            throw new Error(result.error || "Something went wrong.");
        }

        displayPlan(result.allocation, data.amountReceived);

        if (result.mode === "demo") {
            showStatus(`
                <strong>Suggested split ready (50/30/20 tuned)</strong>
                <p>Review your split on the right and click <strong>"Apply this split ✓"</strong> to save it to your Wallet.</p>
            `);
        } else {
            showStatus(`
                <strong>AI plan created in ${responseTime}s</strong>
                <p>Review your split on the right and click <strong>"Apply this split ✓"</strong> to save it to your Wallet.</p>
            `);
        }
    } catch (error) {
        console.error(error);
        showStatus(`
            <strong>We couldn't create your plan.</strong>
            <p>${error.message}</p>
        `);
    } finally {
        organizeButton.disabled = false;
        organizeButton.innerHTML = 'Show my recommendation <span class="btn-arrow">→</span>';
    }
}

// -----------------------------
// DISPLAY PLAN
// -----------------------------

function displayPlan(allocation, totalInput) {
    const billsResult = document.getElementById("billsResult");
    const spendingResult = document.getElementById("spendingResult");
    const savingsResult = document.getElementById("savingsResult");
    const explanationResult = document.getElementById("explanationResult");
    const splitSummaryTitle = document.getElementById("splitSummaryTitle");

    const billsAmt = Number(allocation.bills) || 0;
    const spendingAmt = Number(allocation.spending) || 0;
    const savingsAmt = Number(allocation.savings) || 0;
    const total = Number(totalInput) || (billsAmt + spendingAmt + savingsAmt) || 0;

    billsResult.textContent = formatMoney(billsAmt);
    spendingResult.textContent = formatMoney(spendingAmt);
    savingsResult.textContent = formatMoney(savingsAmt);

    billsResult.dataset.amount = billsAmt;
    spendingResult.dataset.amount = spendingAmt;
    savingsResult.dataset.amount = savingsAmt;

    if (splitSummaryTitle) {
        splitSummaryTitle.textContent = `${formatMoney(total).replace(/\.00$/, "")} organized simply.`;
    }

    const billsPctBadge = document.getElementById("billsPctBadge");
    const savingsPctBadge = document.getElementById("savingsPctBadge");
    const spendingPctBadge = document.getElementById("spendingPctBadge");

    if (total > 0) {
        const bPct = Math.round((billsAmt / total) * 100);
        const sPct = Math.round((savingsAmt / total) * 100);
        const spPct = Math.max(0, 100 - bPct - sPct);
        if (billsPctBadge) billsPctBadge.textContent = `${bPct}%`;
        if (savingsPctBadge) savingsPctBadge.textContent = `${sPct}%`;
        if (spendingPctBadge) spendingPctBadge.textContent = `${spPct}%`;
    }

    if (explanationResult) {
        explanationResult.textContent = allocation.explanation;
    }

    show(resultSection);
}

// -----------------------------
// FORMAT MONEY
// -----------------------------

function formatMoney(amount) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD"
    }).format(amount);
}

// -----------------------------
// FORM SUBMISSION & ACTIONS
// -----------------------------

moneyForm.addEventListener("submit", function (event) {
    event.preventDefault();
    createPlan();
});

editButton.addEventListener("click", function () {
    document.getElementById("amountReceived").focus();
    showStatus(`
        <strong>Edit your information.</strong>
        <p>Change any amount above and click "Show my recommendation →".</p>
    `);
});

regenerateButton.addEventListener("click", function () {
    createPlan();
});

acceptButton.addEventListener("click", function () {
    const bills = Number(document.getElementById("billsResult").dataset.amount);
    const spending = Number(document.getElementById("spendingResult").dataset.amount);
    const savings = Number(document.getElementById("savingsResult").dataset.amount);

    if (isNaN(bills) || isNaN(spending) || isNaN(savings)) {
        showStatus(`
            <strong>Something went wrong.</strong>
            <p>FundIQ could not read the suggested plan. Please generate the plan again.</p>
        `);
        return;
    }

    const wallet = {
        bills: bills,
        spending: spending,
        savings: savings
    };

    localStorage.setItem("fundiqWallet", JSON.stringify(wallet));

    const totalSorted = Math.round((bills + spending + savings) * 100) / 100;
    const eventId = `sorter_split_${Date.now()}_${Math.round(totalSorted * 100)}`;

    fetch("/api/wallet", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            ...wallet,
            depositEvent: {
                amount: totalSorted,
                category: "Money Sorter Split (Bills, Savings, Spending)",
                source: "AI Money Sorter",
                eventId
            }
        })
    }).catch(() => {});

    showStatus(`
        <strong>✓ Split applied to your Wallet!</strong>
        <p>Your FundIQ plan (${formatMoney(bills)} Bills, ${formatMoney(savings)} Savings, ${formatMoney(spending)} Spending) has been saved.</p>
        <p style="margin-top: 8px;"><a href="wallet.html" class="inline-wallet-link">View My Wallet →</a></p>
    `);
});

rejectButton.addEventListener("click", function () {
    showStatus(`
        <strong>Plan discarded.</strong>
        <p>No changes were made to your wallet. Adjust any amount above whenever you're ready.</p>
    `);
});

// -----------------------------
// QUICK EXPENSE LOGGER (Figma Reference)
// -----------------------------

const quickExpenseForm = document.getElementById("quickExpenseForm");
if (quickExpenseForm) {
    quickExpenseForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        const amtInput = document.getElementById("quickExpenseAmount");
        const catSelect = document.getElementById("quickExpenseCategory");
        const noticeEl = document.getElementById("quickExpenseNotice");

        const expAmt = Number(amtInput.value);
        const expCat = catSelect ? catSelect.value : "spending";

        if (isNaN(expAmt) || expAmt <= 0) {
            return;
        }

        let currentWallet = { bills: 0, spending: 0, savings: 0 };
        try {
            const wRes = await fetch("/api/wallet");
            if (wRes.ok) {
                const wData = await wRes.json();
                if (wData.success && wData.wallet) {
                    currentWallet = wData.wallet;
                }
            } else {
                const local = localStorage.getItem("fundiqWallet");
                if (local) currentWallet = JSON.parse(local);
            }
        } catch (err) {
            try {
                const local = localStorage.getItem("fundiqWallet");
                if (local) currentWallet = JSON.parse(local);
            } catch (e2) {}
        }

        currentWallet[expCat] = Math.max(0, Math.round(((Number(currentWallet[expCat]) || 0) - expAmt) * 100) / 100);
        localStorage.setItem("fundiqWallet", JSON.stringify(currentWallet));

        try {
            await fetch("/api/wallet", {
                method: "PUT",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...currentWallet,
                    suppressDepositEmail: true
                })
            });
        } catch (err) {}

        amtInput.value = "";
        if (noticeEl) {
            noticeEl.innerHTML = `<strong>✓ Expense Recorded:</strong> Logged ${formatMoney(expAmt)} from your <strong>${expCat.charAt(0).toUpperCase() + expCat.slice(1)}</strong> bucket. <a href="wallet.html" style="font-weight:700; color:inherit; text-decoration:underline; margin-left:6px;">View Wallet →</a>`;
            noticeEl.style.display = "block";
        }
    });
}