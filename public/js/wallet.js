// public/js/wallet.js - Wallet Balances, Editable Subcategories & Bills Overview Logic

let wallet = {
    bills: 0,
    spending: 0,
    savings: 0
};

let bankBalances = {
    bills: 0,
    spending: 0,
    savings: 0,
    total: 0,
    connected: false,
    institutionCount: 0,
    accountCount: 0,
    mappedBillsCount: 0,
    mappedSavingsCount: 0,
    lastUpdated: null
};

const DEFAULT_SUB_ITEMS = {
    savings: [
        { id: "sub_savings_emergency", name: "Emergency fund", ratio: 0.615, isDefault: true, isRatioSeeded: true },
        { id: "sub_savings_vacation", name: "Vacation", ratio: 0.249, isDefault: true, isRatioSeeded: true },
        { id: "sub_savings_car", name: "New car", ratio: 0.136, isDefault: true, isRatioSeeded: true }
    ],
    bills: [
        { id: "sub_bills_housing", name: "Housing", ratio: 0.657, isDefault: true, isRatioSeeded: true },
        { id: "sub_bills_utilities", name: "Utilities", ratio: 0.151, isDefault: true, isRatioSeeded: true },
        { id: "sub_bills_insurance", name: "Insurance", ratio: 0.192, isDefault: true, isRatioSeeded: true }
    ],
    spending: [
        { id: "sub_spending_groceries", name: "Groceries", ratio: 0.387, isDefault: true, isRatioSeeded: true },
        { id: "sub_spending_dining", name: "Dining out", ratio: 0.312, isDefault: true, isRatioSeeded: true },
        { id: "sub_spending_fun", name: "Fun money", ratio: 0.301, isDefault: true, isRatioSeeded: true }
    ]
};

let serverSubcategories = null;
let detectedBills = [];

// Try loading local manual wallet fallback initially
try {
    const local = localStorage.getItem("fundiqWallet");
    if (local) {
        const parsed = JSON.parse(local);
        wallet = {
            bills: Number(parsed.bills) || 0,
            spending: Number(parsed.spending) || 0,
            savings: Number(parsed.savings) || 0
        };
    }
} catch (e) {
    console.error("Local wallet parse error:", e);
}

function formatMoney(amount) {
    return `$${(Number(amount) || 0).toFixed(2)}`;
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text === null || text === undefined ? "" : String(text);
    return div.innerHTML;
}

function resolveApiUrl(apiPath) {
    if (
        window.location.protocol === "file:" ||
        (window.location.hostname &&
            (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") &&
            window.location.port &&
            window.location.port !== "3000" &&
            !window.__FUNDIQ_CUSTOM_PORT)
    ) {
        return `http://localhost:3000${apiPath}`;
    }
    return apiPath;
}

async function safeParseJson(response) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        return {
            success: false,
            nonJson: true,
            rawPreview: text ? text.slice(0, 140) : ""
        };
    }
}

function getCombinedTotals() {
    const manualBills = Number(wallet.bills) || 0;
    const manualSpending = Number(wallet.spending) || 0;
    const manualSavings = Number(wallet.savings) || 0;
    const bankBills = Number(bankBalances.bills) || 0;
    const bankSavings = Number(bankBalances.savings) || 0;

    return {
        savings: Math.round((manualSavings + bankSavings) * 100) / 100,
        bills: Math.round((manualBills + bankBills) * 100) / 100,
        spending: Math.round(manualSpending * 100) / 100
    };
}

function updateWallet() {
    const manualBills = Number(wallet.bills) || 0;
    const manualSpending = Number(wallet.spending) || 0;
    const manualSavings = Number(wallet.savings) || 0;
    const manualTotal = manualBills + manualSpending + manualSavings;

    const bankBills = Number(bankBalances.bills) || 0;
    const bankSavings = Number(bankBalances.savings) || 0;
    const bankTotal = bankBills + bankSavings;

    const combinedBills = Math.round((manualBills + bankBills) * 100) / 100;
    const combinedSpending = Math.round(manualSpending * 100) / 100;
    const combinedSavings = Math.round((manualSavings + bankSavings) * 100) / 100;
    const combinedTotal = Math.round((combinedBills + combinedSpending + combinedSavings) * 100) / 100;

    const billsEl = document.getElementById("billsAmount");
    const spendingEl = document.getElementById("spendingAmount");
    const savingsEl = document.getElementById("savingsAmount");
    const totalEl = document.getElementById("totalAmount");

    if (billsEl) billsEl.textContent = formatMoney(combinedBills);
    if (spendingEl) spendingEl.textContent = formatMoney(combinedSpending);
    if (savingsEl) savingsEl.textContent = formatMoney(combinedSavings);
    if (totalEl) totalEl.textContent = formatMoney(combinedTotal);

    const totalManualEl = document.getElementById("totalManualAmount");
    const totalBankEl = document.getElementById("totalBankAmount");
    const billsManualEl = document.getElementById("billsManualAmount");
    const billsBankEl = document.getElementById("billsBankAmount");
    const spendingManualEl = document.getElementById("spendingManualAmount");
    const savingsManualEl = document.getElementById("savingsManualAmount");
    const savingsBankEl = document.getElementById("savingsBankAmount");

    if (totalManualEl) totalManualEl.textContent = formatMoney(manualTotal);
    if (totalBankEl) totalBankEl.textContent = formatMoney(bankTotal);
    if (billsManualEl) billsManualEl.textContent = formatMoney(manualBills);
    if (billsBankEl) billsBankEl.textContent = formatMoney(bankBills);
    if (spendingManualEl) spendingManualEl.textContent = formatMoney(manualSpending);
    if (savingsManualEl) savingsManualEl.textContent = formatMoney(manualSavings);
    if (savingsBankEl) savingsBankEl.textContent = formatMoney(bankSavings);

    let savPct = 0;
    let bilPct = 0;
    let spdPct = 0;
    if (combinedTotal > 0) {
        savPct = Math.round((combinedSavings / combinedTotal) * 100);
        bilPct = Math.round((combinedBills / combinedTotal) * 100);
        spdPct = Math.max(0, 100 - savPct - bilPct);
    }

    const segSav = document.getElementById("barSegSavings");
    const segBil = document.getElementById("barSegBills");
    const segSpd = document.getElementById("barSegSpending");

    if (segSav && segBil && segSpd) {
        if (combinedTotal > 0) {
            segSav.style.width = `${savPct}%`;
            segBil.style.width = `${bilPct}%`;
            segSpd.style.width = `${spdPct}%`;
        } else {
            segSav.style.width = "34%";
            segBil.style.width = "33%";
            segSpd.style.width = "33%";
        }
    }

    const pctSavEl = document.getElementById("pctSavings");
    const pctBilEl = document.getElementById("pctBills");
    const pctSpdEl = document.getElementById("pctSpending");
    if (pctSavEl) pctSavEl.textContent = `${savPct}%`;
    if (pctBilEl) pctBilEl.textContent = `${bilPct}%`;
    if (pctSpdEl) pctSpdEl.textContent = `${spdPct}%`;

    renderBucketSubLists(combinedSavings, combinedBills, combinedSpending);
    renderWalletDetectedBills();
}

function getEffectiveSubItems(savTotal, bilTotal, spdTotal) {
    const totals = { savings: savTotal, bills: bilTotal, spending: spdTotal };
    const result = { savings: [], bills: [], spending: [] };

    ["savings", "bills", "spending"].forEach((bucket) => {
        const bucketTotal = totals[bucket] || 0;
        if (serverSubcategories && Array.isArray(serverSubcategories[bucket]) && serverSubcategories[bucket].length > 0) {
            result[bucket] = serverSubcategories[bucket].map((item) => {
                const amt =
                    item.isRatioSeeded && item.ratio !== null && item.ratio !== undefined
                        ? Math.round(bucketTotal * Number(item.ratio) * 100) / 100
                        : Math.round((Number(item.amount) || 0) * 100) / 100;
                return {
                    ...item,
                    bucket,
                    amount: amt
                };
            });
        } else {
            const baseItems = DEFAULT_SUB_ITEMS[bucket] || [];
            result[bucket] = baseItems.map((item) => ({
                id: item.id,
                bucket,
                name: item.name,
                amount: Math.round(bucketTotal * item.ratio * 100) / 100,
                ratio: item.ratio,
                isDefault: true,
                isRatioSeeded: true
            }));
        }
    });

    return result;
}

function renderBucketSubLists(savTotal, bilTotal, spdTotal) {
    const allItems = getEffectiveSubItems(savTotal, bilTotal, spdTotal);

    ["savings", "bills", "spending"].forEach((bucket) => {
        const container = document.getElementById(`subList_${bucket}`);
        if (!container) return;

        const items = allItems[bucket] || [];
        let html = "";

        items.forEach((item) => {
            const safeId = escapeHtml(item.id);
            const safeName = escapeHtml(item.name);
            const amtStr = formatMoney(item.amount);
            html += `
                <div class="bucket-sub-row" data-sub-id="${safeId}" data-bucket="${bucket}" onclick="editBucketSubItem('${bucket}', '${safeId}')" title="Click to edit ${safeName}">
                    <span class="sub-row-left">
                        <i class="sub-dot ${bucket}"></i>
                        <span class="sub-row-name">${safeName}</span>
                    </span>
                    <span class="sub-row-right">
                        <strong>${amtStr}</strong>
                        <button type="button" class="sub-edit-btn" aria-label="Edit ${safeName}" onclick="event.stopPropagation(); editBucketSubItem('${bucket}', '${safeId}')">✎ Edit</button>
                    </span>
                </div>
            `;
        });

        container.innerHTML = html;
    });
}

function openSubcategoryModal({ mode, bucket, id = "", name = "", amount = 0 }) {
    const modal = document.getElementById("subcategoryModal");
    const titleEl = document.getElementById("subcategoryModalTitle");
    const idInput = document.getElementById("subcatIdInput");
    const bucketInput = document.getElementById("subcatBucketInput");
    const nameInput = document.getElementById("subcatNameInput");
    const amountInput = document.getElementById("subcatAmountInput");
    const errEl = document.getElementById("subcategoryFormError");
    const saveBtn = document.getElementById("saveSubcategoryBtn");

    if (!modal) return;

    const bucketLabel = bucket.charAt(0).toUpperCase() + bucket.slice(1);
    if (titleEl) {
        titleEl.textContent = mode === "edit" ? `Edit ${bucketLabel} Sub-category` : `Add ${bucketLabel} Sub-category`;
    }
    if (idInput) idInput.value = mode === "edit" ? id : "";
    if (bucketInput) bucketInput.value = bucket;
    if (nameInput) nameInput.value = name;
    if (amountInput) amountInput.value = (Number(amount) || 0).toFixed(2);
    if (errEl) {
        errEl.style.display = "none";
        errEl.textContent = "";
    }
    if (saveBtn) {
        saveBtn.textContent = mode === "edit" ? "Save Changes" : "Add Sub-category";
    }

    modal.classList.add("is-visible");
    setTimeout(() => {
        if (nameInput) nameInput.focus();
    }, 30);
}

function closeSubcategoryModal() {
    const modal = document.getElementById("subcategoryModal");
    if (modal) modal.classList.remove("is-visible");
}

function addBucketSubItem(bucket) {
    openSubcategoryModal({
        mode: "add",
        bucket,
        id: "",
        name: "",
        amount: 50
    });
}

function editBucketSubItem(bucket, subId) {
    const totals = getCombinedTotals();
    const allItems = getEffectiveSubItems(totals.savings, totals.bills, totals.spending);
    const list = allItems[bucket] || [];
    const target = list.find((item) => String(item.id) === String(subId));
    if (!target) return;

    openSubcategoryModal({
        mode: "edit",
        bucket,
        id: target.id,
        name: target.name,
        amount: target.amount
    });
}

async function handleSubcategoryFormSubmit(event) {
    event.preventDefault();
    const idInput = document.getElementById("subcatIdInput");
    const bucketInput = document.getElementById("subcatBucketInput");
    const nameInput = document.getElementById("subcatNameInput");
    const amountInput = document.getElementById("subcatAmountInput");
    const errEl = document.getElementById("subcategoryFormError");
    const saveBtn = document.getElementById("saveSubcategoryBtn");

    const subId = (idInput?.value || "").trim();
    const bucket = (bucketInput?.value || "savings").trim().toLowerCase();
    const rawName = (nameInput?.value || "").trim();
    const rawAmt = Number(amountInput?.value);

    const showErr = (msg) => {
        if (errEl) {
            errEl.textContent = msg;
            errEl.style.display = "block";
        }
    };

    if (!rawName) {
        showErr("Subcategory name cannot be empty.");
        return;
    }
    if (isNaN(rawAmt) || rawAmt < 0) {
        showErr("Allocated balance must be a valid non-negative number.");
        return;
    }

    if (saveBtn) saveBtn.disabled = true;

    try {
        const isEdit = Boolean(subId);
        const url = isEdit
            ? `/api/wallet/subcategories/${encodeURIComponent(subId)}`
            : "/api/wallet/subcategories";
        const method = isEdit ? "PUT" : "POST";

        const res = await fetch(resolveApiUrl(url), {
            method,
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: subId || undefined,
                bucket,
                name: rawName,
                amount: Math.round(rawAmt * 100) / 100
            })
        });

        const data = await safeParseJson(res);
        if (!res.ok || !data.success) {
            showErr(data.error || "Could not save subcategory.");
            return;
        }

        if (data.subcategories) {
            serverSubcategories = data.subcategories;
        }
        applyServerWalletSummary(data);
        closeSubcategoryModal();

        const notice = document.getElementById("walletNotice");
        if (notice) {
            notice.innerHTML = `<strong>✓ Sub-category Saved:</strong> "${escapeHtml(rawName)}" (${formatMoney(rawAmt)}) has been updated in your ${escapeHtml(bucket.charAt(0).toUpperCase() + bucket.slice(1))} bucket.`;
            notice.style.display = "block";
        }
    } catch (err) {
        showErr("Network error while saving subcategory. Please try again.");
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

function renderWalletDetectedBills() {
    const wrap = document.getElementById("billsDetectedRecurringWrap");
    const listEl = document.getElementById("billsDetectedRecurringList");
    if (!wrap || !listEl) return;

    const activeBills = Array.isArray(detectedBills)
        ? detectedBills.filter((b) => b.status !== "dismissed")
        : [];

    if (activeBills.length === 0) {
        wrap.style.display = "none";
        listEl.innerHTML = "";
        return;
    }

    wrap.style.display = "block";
    listEl.innerHTML = activeBills
        .map((bill) => {
            const name = escapeHtml(bill.displayName || bill.name || "Recurring Bill");
            const amt = formatMoney(bill.expectedAmount || bill.amount || 0);
            const freq = escapeHtml(bill.frequency || "monthly");
            const nextDue = escapeHtml(bill.nextDueDate || "");
            const accName = escapeHtml(bill.accountName || "Connected Bank");
            const isPredicted = bill.status !== "confirmed";
            const badgeHtml = isPredicted
                ? `<span class="pred-status-pill predicted">🔮 Predicted</span>`
                : `<span class="pred-status-pill confirmed">✓ Confirmed</span>`;

            return `
                <div class="detected-bill-mini-item" data-bill-id="${bill.id}">
                    <div class="detected-bill-mini-top">
                        <div>
                            <strong class="detected-bill-mini-title">${name}</strong>
                            ${badgeHtml}
                        </div>
                        <strong class="detected-bill-mini-amount">${amt}</strong>
                    </div>
                    <div class="detected-bill-mini-meta">
                        <span>Next due: <strong>${nextDue}</strong> (${freq})</span>
                        <span>• ${accName}</span>
                    </div>
                    <div class="detected-bill-mini-actions">
                        <button type="button" class="btn-mini-action" onclick="openEditDetectedBillModal(${bill.id})">Edit</button>
                        <button type="button" class="btn-mini-action danger" onclick="dismissDetectedBillFromWallet(${bill.id})">Dismiss</button>
                    </div>
                </div>
            `;
        })
        .join("");
}

function openEditDetectedBillModal(billId) {
    const bill = (detectedBills || []).find((b) => Number(b.id) === Number(billId));
    if (!bill) return;

    const modal = document.getElementById("editDetectedBillModal");
    if (!modal) return;

    document.getElementById("detectedBillIdInput").value = String(bill.id);
    document.getElementById("detectedBillNameInput").value = bill.displayName || bill.name || "";
    document.getElementById("detectedBillAmountInput").value = (Number(bill.expectedAmount || bill.amount) || 0).toFixed(2);
    document.getElementById("detectedBillDueDateInput").value = bill.nextDueDate || "";
    document.getElementById("detectedBillFreqInput").value = bill.frequency || "monthly";
    document.getElementById("detectedBillCategoryInput").value = bill.walletCategory || "bills";

    const errEl = document.getElementById("editDetectedBillError");
    if (errEl) {
        errEl.style.display = "none";
        errEl.textContent = "";
    }

    modal.classList.add("is-visible");
}

function closeEditDetectedBillModal() {
    const modal = document.getElementById("editDetectedBillModal");
    if (modal) modal.classList.remove("is-visible");
}

async function handleEditDetectedBillSubmit(event) {
    event.preventDefault();
    const billId = document.getElementById("detectedBillIdInput")?.value;
    const displayName = document.getElementById("detectedBillNameInput")?.value.trim();
    const expectedAmount = Number(document.getElementById("detectedBillAmountInput")?.value);
    const nextDueDate = document.getElementById("detectedBillDueDateInput")?.value;
    const frequency = document.getElementById("detectedBillFreqInput")?.value;
    const walletCategory = document.getElementById("detectedBillCategoryInput")?.value;
    const errEl = document.getElementById("editDetectedBillError");

    try {
        const res = await fetch(resolveApiUrl(`/api/bills/detected/${encodeURIComponent(billId)}`), {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                displayName,
                expectedAmount,
                nextDueDate,
                frequency,
                walletCategory
            })
        });
        const data = await safeParseJson(res);
        if (!res.ok || !data.success) {
            if (errEl) {
                errEl.textContent = data.error || "Failed to update bill.";
                errEl.style.display = "block";
            }
            return;
        }
        detectedBills = Array.isArray(data.activePredictions) ? data.activePredictions : (data.detectedBills || []);
        closeEditDetectedBillModal();
        renderWalletDetectedBills();
    } catch (err) {
        if (errEl) {
            errEl.textContent = "Network error while saving bill.";
            errEl.style.display = "block";
        }
    }
}

async function dismissDetectedBillFromWallet(billId) {
    try {
        const res = await fetch(resolveApiUrl(`/api/bills/detected/${encodeURIComponent(billId)}`), {
            method: "DELETE",
            credentials: "include"
        });
        const data = await safeParseJson(res);
        if (res.ok && data.success) {
            detectedBills = Array.isArray(data.activePredictions) ? data.activePredictions : [];
            renderWalletDetectedBills();
        }
    } catch (err) {
        console.error("Dismiss detected bill error:", err);
    }
}

function applyServerWalletSummary(data) {
    if (!data) return;
    if (data.wallet) {
        wallet = {
            bills: Number(data.wallet.bills) || 0,
            spending: Number(data.wallet.spending) || 0,
            savings: Number(data.wallet.savings) || 0
        };
        localStorage.setItem("fundiqWallet", JSON.stringify(wallet));
    }
    if (data.bankBalances) {
        bankBalances = {
            bills: Number(data.bankBalances.bills) || 0,
            spending: 0,
            savings: Number(data.bankBalances.savings) || 0,
            total: Number(data.bankBalances.total) || 0,
            connected: Boolean(data.bankBalances.connected),
            institutionCount: Number(data.bankBalances.institutionCount) || 0,
            accountCount: Number(data.bankBalances.accountCount) || 0,
            mappedBillsCount: Number(data.bankBalances.mappedBillsCount) || 0,
            mappedSavingsCount: Number(data.bankBalances.mappedSavingsCount) || 0,
            lastUpdated: data.bankBalances.lastUpdated || null
        };
    }
    if (data.subcategories) {
        serverSubcategories = data.subcategories;
    }
    if (Array.isArray(data.detectedBills)) {
        detectedBills = data.detectedBills;
    }
    updateWallet();
}

async function migrateLegacyLocalSubcategoriesIfNeeded() {
    try {
        const raw = localStorage.getItem("fundiqSubCategories_v1");
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return;

        let migratedAny = false;
        for (const bucket of ["savings", "bills", "spending"]) {
            const items = Array.isArray(parsed[bucket]) ? parsed[bucket] : [];
            for (const item of items) {
                if (!item || !item.name) continue;
                const res = await fetch(resolveApiUrl("/api/wallet/subcategories"), {
                    method: "POST",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        bucket,
                        name: String(item.name).trim(),
                        amount: Number(item.amount) || 0
                    })
                });
                if (res.ok) migratedAny = true;
            }
        }
        localStorage.removeItem("fundiqSubCategories_v1");
        if (migratedAny) {
            const subRes = await fetch(resolveApiUrl("/api/wallet/subcategories"), { credentials: "include" });
            if (subRes.ok) {
                const subData = await safeParseJson(subRes);
                if (subData.success && subData.subcategories) {
                    serverSubcategories = subData.subcategories;
                    updateWallet();
                }
            }
        }
    } catch (_) {}
}

async function syncWalletFromServer() {
    try {
        const response = await fetch(resolveApiUrl("/api/wallet"), {
            credentials: "include"
        });
        if (response.ok) {
            const data = await safeParseJson(response);
            if (data.success) {
                applyServerWalletSummary(data);
                await migrateLegacyLocalSubcategoriesIfNeeded();
            }
        }
    } catch (e) {
        console.log("Using local wallet (server sync unavailable):", e.message);
    }
}

async function addMoney() {
    const amount = Number(prompt("How much money would you like to add?"));

    if (isNaN(amount) || amount <= 0) {
        alert("Please enter a valid amount.");
        return;
    }

    wallet.spending = Math.round(((wallet.spending || 0) + amount) * 100) / 100;
    localStorage.setItem("fundiqWallet", JSON.stringify(wallet));
    updateWallet();

    try {
        const eventId = `wallet_deposit_${Date.now()}_${Math.round(amount * 100)}`;
        const response = await fetch(resolveApiUrl("/api/wallet/deposit"), {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                amount,
                category: "spending",
                source: "Wallet Add Money",
                eventId
            })
        });
        if (response.ok) {
            const data = await safeParseJson(response);
            if (data.success) {
                applyServerWalletSummary(data);
            }
        }
    } catch (e) {
        console.error("Failed to sync addMoney to server:", e);
    }
}

function promptClearWallet() {
    const modal = document.getElementById("clearWalletModal");
    if (modal) {
        modal.classList.add("is-visible");
    } else {
        if (confirm("Are you sure you want to clear your manual wallet balances to $0.00? Your calendar events and recurring payments will remain completely intact.")) {
            executeClearWallet();
        }
    }
}

function closeClearWalletModal() {
    const modal = document.getElementById("clearWalletModal");
    if (modal) {
        modal.classList.remove("is-visible");
    }
}

async function executeClearWallet() {
    closeClearWalletModal();

    wallet = { bills: 0, spending: 0, savings: 0 };
    localStorage.setItem("fundiqWallet", JSON.stringify(wallet));
    updateWallet();

    try {
        const response = await fetch(resolveApiUrl("/api/wallet/clear"), {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" }
        });
        const data = await safeParseJson(response);
        if (data.success) {
            applyServerWalletSummary(data);
        }
    } catch (e) {
        console.error("Server wallet clear error:", e);
    }

    const notice = document.getElementById("walletNotice");
    if (notice) {
        notice.innerHTML = `
            <strong>Manual Wallet Cleared:</strong> Your manual wallet balances have been reset to $0.00.
            <div style="margin-top: 4px; font-size: 12.5px;">Your scheduled payments, calendar events, completion history, and connected bank accounts remain intact.</div>
        `;
        notice.style.display = "block";
    }
}

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        closeClearWalletModal();
        closeSubcategoryModal();
        closeEditDetectedBillModal();
    }
});

updateWallet();
syncWalletFromServer();
