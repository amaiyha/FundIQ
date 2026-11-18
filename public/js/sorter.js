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

// -----------------------------
// AI DEPOSIT NOTIFICATIONS, PROPOSED ALLOCATIONS & HISTORY
// -----------------------------

function escapeHtmlSorter(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function showDepositAllocBanner(msg, type = "info") {
    const el = document.getElementById("depositAllocationStatusBanner");
    if (!el) return;
    if (!msg) {
        el.style.display = "none";
        el.innerHTML = "";
        return;
    }
    el.className = `plaid-alert-banner ${type}`;
    el.innerHTML = msg;
    el.style.display = "block";
}

async function loadSorterDepositAllocations() {
    const pendingEl = document.getElementById("pendingDepositAllocationsList");
    const historyEl = document.getElementById("sorterAllocationHistoryList");
    const rulesEl = document.getElementById("savedRulesLabel");
    if (!pendingEl && !historyEl) return;

    try {
        const res = await fetch("/api/deposits/allocations", {
            credentials: "same-origin",
            cache: "no-store"
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!data.success) return;

        if (rulesEl && data.allocationRules) {
            const r = data.allocationRules;
            rulesEl.textContent = `${r.billsPct}% Bills / ${r.savingsPct}% Savings / ${r.spendingPct}% Spending`;
        }

        renderSorterPendingAllocations(data.pendingAllocations || [], data.actualBalances || {});
        renderSorterAllocationHistory(data.allocations || [], data.deliveryHistory || []);
    } catch (err) {
        console.log("Deposit allocations load skipped:", err.message);
    }
}

function renderSorterPendingAllocations(pendingList, actualBalances) {
    const pendingEl = document.getElementById("pendingDepositAllocationsList");
    if (!pendingEl) return;

    if (!Array.isArray(pendingList) || pendingList.length === 0) {
        pendingEl.innerHTML = `
            <div style="padding: 12px 14px; border-radius: 10px; background: #F9FAFB; border: 1px dashed #D1D5DB; font-size: 13px; color: #6B7280;">
                No pending deposit allocations awaiting approval. Use <strong>"+ Detect Deposit &amp; Notify Me"</strong> above or sync a connected bank account to test AI deposit sorting.
            </div>
        `;
        return;
    }

    const currComb = (actualBalances && actualBalances.combinedWallet) || { bills: 0, savings: 0, spending: 0, total: 0 };

    pendingEl.innerHTML = pendingList
        .map((alloc) => {
            const actualComb = (alloc.balancesBefore && alloc.balancesBefore.combinedWallet) || currComb;
            const propComb = (alloc.proposedBalances && alloc.proposedBalances.combinedWallet) || {
                bills: actualComb.bills + alloc.proposed.bills,
                savings: actualComb.savings + alloc.proposed.savings,
                spending: actualComb.spending + alloc.proposed.spending,
                total: actualComb.total + alloc.depositAmount
            };

            return `
                <div class="proposed-alloc-card" style="background:#FAF5FF; border:1.5px solid #C4B5FD; border-radius:12px; padding:16px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
                        <div>
                            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                                <strong style="font-size:15px; color:#111827;">${formatMoney(alloc.depositAmount)} — ${escapeHtmlSorter(alloc.sourceDescription)}</strong>
                                <span class="pred-status-pill predicted">Proposed Split (Not Applied Yet)</span>
                            </div>
                            <div style="font-size:12px; color:#6B7280; margin-top:4px;">
                                Account: <strong>${escapeHtmlSorter(alloc.accountName)}</strong> • Deposit Date: <strong>${escapeHtmlSorter(alloc.depositDate)}</strong>
                            </div>
                            <div style="font-size:12.5px; color:#374151; margin-top:6px;">
                                ${escapeHtmlSorter(alloc.aiExplanation)}
                            </div>
                        </div>
                    </div>

                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:12px; margin-top:14px;">
                        <div>
                            <label style="font-size:11.5px; font-weight:700; color:#374151; display:block; margin-bottom:4px;">Bills Allocation ($)</label>
                            <input type="number" id="sPropBills_${alloc.id}" value="${alloc.proposed.bills.toFixed(2)}" min="0" step="0.01" style="width:100%; padding:8px 10px; font-size:13px;">
                        </div>
                        <div>
                            <label style="font-size:11.5px; font-weight:700; color:#374151; display:block; margin-bottom:4px;">Savings Allocation ($)</label>
                            <input type="number" id="sPropSavings_${alloc.id}" value="${alloc.proposed.savings.toFixed(2)}" min="0" step="0.01" style="width:100%; padding:8px 10px; font-size:13px;">
                        </div>
                        <div>
                            <label style="font-size:11.5px; font-weight:700; color:#374151; display:block; margin-bottom:4px;">Spending Allocation ($)</label>
                            <input type="number" id="sPropSpending_${alloc.id}" value="${alloc.proposed.spending.toFixed(2)}" min="0" step="0.01" style="width:100%; padding:8px 10px; font-size:13px;">
                        </div>
                    </div>

                    <div style="margin-top:12px; padding:10px 12px; background:#FFFFFF; border-radius:8px; border:1px solid #E5E7EB; font-size:12px; color:#374151;">
                        <div><strong>Actual Balances (Current):</strong> Total ${formatMoney(actualComb.total)} (Bills: ${formatMoney(actualComb.bills)} • Savings: ${formatMoney(actualComb.savings)} • Spending: ${formatMoney(actualComb.spending)})</div>
                        <div style="margin-top:4px; color:#5B21B6;"><strong>Proposed Balances (After Approval):</strong> Total ${formatMoney(propComb.total)} (Bills: ${formatMoney(propComb.bills)} • Savings: ${formatMoney(propComb.savings)} • Spending: ${formatMoney(propComb.spending)})</div>
                    </div>

                    <div style="display:flex; justify-content:flex-end; gap:8px; flex-wrap:wrap; margin-top:12px;">
                        <button type="button" class="btn-mini-action" onclick="updateSorterProposedSplit(${alloc.id})">Save Edited Amounts</button>
                        <button type="button" class="btn-purple-pill" style="padding:7px 16px; font-size:12.5px;" onclick="approveSorterProposedSplit(${alloc.id})">Approve Allocation ✓</button>
                        <button type="button" class="btn-mini-action danger" onclick="rejectSorterProposedSplit(${alloc.id})">Dismiss</button>
                    </div>
                </div>
            `;
        })
        .join("");
}

function renderSorterAllocationHistory(allocations, deliveryHistory) {
    const historyEl = document.getElementById("sorterAllocationHistoryList");
    if (!historyEl) return;

    if ((!allocations || allocations.length === 0) && (!deliveryHistory || deliveryHistory.length === 0)) {
        historyEl.innerHTML = `
            <div style="font-size:12.5px; color:#6B7280; padding:8px 0;">
                No deposit notifications or allocations recorded yet.
            </div>
        `;
        return;
    }

    const rowsHtml = (allocations || []).slice(0, 10).map((a) => {
        const badgeClass = a.status === "approved" ? "confirmed" : a.status === "rejected" ? "verified" : "predicted";
        const badgeLabel =
            a.status === "approved"
                ? "✓ Approved & Applied"
                : a.status === "rejected"
                ? "Dismissed"
                : "⏳ Proposed (Pending Approval)";
        const splitObj = a.status === "approved" && a.approved ? a.approved : a.proposed;

        return `
            <div class="conn-list-item" style="align-items:flex-start;">
                <div class="conn-item-left">
                    <div class="conn-avatar-badge" aria-hidden="true">$</div>
                    <div>
                        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                            <div class="conn-item-title">${formatMoney(a.depositAmount)} — ${escapeHtmlSorter(a.sourceDescription)}</div>
                            <span class="pred-status-pill ${badgeClass}">${badgeLabel}</span>
                        </div>
                        <div class="conn-item-sub">
                            ${escapeHtmlSorter(a.accountName)} • Date: ${escapeHtmlSorter(a.depositDate)} • Split: Bills ${formatMoney(splitObj.bills)}, Savings ${formatMoney(splitObj.savings)}, Spending ${formatMoney(splitObj.spending)}
                        </div>
                    </div>
                </div>
            </div>
        `;
    });

    historyEl.innerHTML = rowsHtml.join("");
}

window.updateSorterProposedSplit = async function (allocId) {
    const bills = Number(document.getElementById(`sPropBills_${allocId}`)?.value || 0);
    const savings = Number(document.getElementById(`sPropSavings_${allocId}`)?.value || 0);
    const spending = Number(document.getElementById(`sPropSpending_${allocId}`)?.value || 0);

    try {
        const res = await fetch(`/api/deposits/allocations/${allocId}`, {
            method: "PUT",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bills, savings, spending })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            showDepositAllocBanner(`<strong>Validation Error:</strong> ${escapeHtmlSorter(data.error || "Could not update proposed amounts.")}`, "error");
            return;
        }
        showDepositAllocBanner(`<strong>✓ Proposed Split Updated:</strong> ${escapeHtmlSorter(data.message)}`, "success");
        await loadSorterDepositAllocations();
    } catch (err) {
        showDepositAllocBanner(`<strong>Network Error:</strong> Could not update proposed split.`, "error");
    }
};

window.approveSorterProposedSplit = async function (allocId) {
    const bills = Number(document.getElementById(`sPropBills_${allocId}`)?.value || 0);
    const savings = Number(document.getElementById(`sPropSavings_${allocId}`)?.value || 0);
    const spending = Number(document.getElementById(`sPropSpending_${allocId}`)?.value || 0);

    try {
        const res = await fetch(`/api/deposits/allocations/${allocId}/approve`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bills, savings, spending })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            showDepositAllocBanner(`<strong>Approval Error:</strong> ${escapeHtmlSorter(data.error || "Could not approve allocation.")}`, "error");
            return;
        }
        if (data.wallet) {
            localStorage.setItem("fundiqWallet", JSON.stringify(data.wallet));
        }
        showDepositAllocBanner(
            `<strong>✓ Allocation Approved &amp; Applied:</strong> ${escapeHtmlSorter(data.message)} <a href="wallet.html" style="font-weight:700; text-decoration:underline; margin-left:6px;">View Updated Wallet →</a>`,
            "success"
        );
        await loadSorterDepositAllocations();
    } catch (err) {
        showDepositAllocBanner(`<strong>Network Error:</strong> Could not approve allocation.`, "error");
    }
};

window.rejectSorterProposedSplit = async function (allocId) {
    try {
        const res = await fetch(`/api/deposits/allocations/${allocId}/reject`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" }
        });
        const data = await res.json();
        if (res.ok && data.success) {
            showDepositAllocBanner(`<strong>Dismissed:</strong> ${escapeHtmlSorter(data.message)}`, "info");
            await loadSorterDepositAllocations();
        }
    } catch (_) {}
};

const simDepositForm = document.getElementById("simulateDepositForm");
if (simDepositForm) {
    simDepositForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        const amt = Number(document.getElementById("simDepositAmount")?.value || 0);
        const src = (document.getElementById("simDepositSource")?.value || "Direct Deposit").trim();
        const acc = (document.getElementById("simDepositAccount")?.value || "Connected Checking Account").trim();
        const btn = document.getElementById("simDepositBtn");

        if (isNaN(amt) || amt <= 0) {
            showDepositAllocBanner(`<strong>Validation Error:</strong> Please enter a deposit amount greater than $0.00.`, "error");
            return;
        }

        if (btn) {
            btn.disabled = true;
            btn.textContent = "Detecting & Notifying...";
        }

        try {
            const res = await fetch("/api/deposits/simulate", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    depositAmount: amt,
                    sourceDescription: src,
                    accountName: acc
                })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                showDepositAllocBanner(`<strong>Error:</strong> ${escapeHtmlSorter(data.error || "Could not process deposit.")}`, "error");
                return;
            }
            showDepositAllocBanner(
                `<strong>✓ Deposit Detected &amp; Notification Sent:</strong> ${escapeHtmlSorter(data.message)}`,
                "success"
            );
            await loadSorterDepositAllocations();
        } catch (err) {
            showDepositAllocBanner(`<strong>Network Error:</strong> Failed to simulate deposit notification.`, "error");
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = "+ Detect Deposit & Notify Me";
            }
        }
    });
}

loadSorterDepositAllocations();