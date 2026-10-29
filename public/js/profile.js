// public/js/profile.js - Profile & Financial Connections, Recurring Bill Detection & Notification Preferences

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

let plaidItems = [];
let plaidAccounts = [];
let detectedBills = [];
let verifiedTransactions = [];
let pendingDisconnectItemId = null;

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

function applyServerSummary(data) {
    if (!data) return;
    if (data.wallet) {
        try {
            localStorage.setItem(
                "fundiqWallet",
                JSON.stringify({
                    bills: Number(data.wallet.bills) || 0,
                    spending: Number(data.wallet.spending) || 0,
                    savings: Number(data.wallet.savings) || 0
                })
            );
        } catch (_) {}
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
    if (Array.isArray(data.detectedBills)) {
        detectedBills = data.detectedBills;
    }
    if (Array.isArray(data.transactions)) {
        verifiedTransactions = data.transactions;
    }
}

// =============================================================
// PLAID LINK & BANK ACCOUNT MANAGEMENT
// =============================================================

function showPlaidAlert(message, type = "info") {
    const banner = document.getElementById("plaidAlertBanner");
    if (!banner) return;

    if (!message) {
        banner.style.display = "none";
        banner.innerHTML = "";
        return;
    }

    banner.className = `plaid-alert-banner ${type}`;
    banner.innerHTML = message;
    banner.style.display = "block";
}

function renderPlaidSection() {
    const statusBadge = document.getElementById("plaidStatusBadge");
    const connectBtn = document.getElementById("connectBankBtn");
    const refreshBtn = document.getElementById("refreshBankBtn");
    const disconnectAllBtn = document.getElementById("disconnectAllBanksBtn");
    const refreshStateEl = document.getElementById("plaidRefreshState");
    const mappingPanel = document.getElementById("plaidMappingPanel");
    const container = document.getElementById("plaidAccountsContainer");

    const isConnected = plaidItems.length > 0;

    const bannerTotalEl = document.getElementById("plaidBannerTotal");
    const bankCountStatEl = document.getElementById("plaidBankCountStat");
    const linkedBadgeEl = document.getElementById("plaidLinkedCountBadge");

    const allConnectedSum = plaidAccounts.reduce((sum, acc) => sum + (Number(acc.effective_balance) || 0), 0);
    if (bannerTotalEl) {
        bannerTotalEl.textContent = formatMoney(isConnected ? allConnectedSum : 0);
    }
    if (bankCountStatEl) {
        bankCountStatEl.textContent = String(plaidAccounts.length);
    }
    if (linkedBadgeEl) {
        linkedBadgeEl.textContent = `${plaidAccounts.length} linked`;
    }

    if (statusBadge) {
        if (isConnected) {
            statusBadge.textContent = `Connected (${plaidItems.length} ${plaidItems.length === 1 ? "Bank" : "Banks"})`;
            statusBadge.className = "plaid-status-badge connected";
        } else {
            statusBadge.textContent = "Not Connected";
            statusBadge.className = "plaid-status-badge disconnected";
        }
    }

    if (connectBtn) {
        connectBtn.textContent = "+ Add account";
    }
    if (refreshBtn) {
        refreshBtn.style.display = isConnected ? "inline-flex" : "none";
    }
    if (disconnectAllBtn) {
        disconnectAllBtn.style.display = plaidItems.length > 1 ? "inline-flex" : "none";
    }

    if (refreshStateEl) {
        if (isConnected && bankBalances.lastUpdated) {
            const dt = new Date(bankBalances.lastUpdated);
            const formattedTime = isNaN(dt.getTime())
                ? bankBalances.lastUpdated
                : dt.toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                      second: "2-digit"
                  });
            refreshStateEl.innerHTML = `
                <span>✓ Live bank balances synced: <strong>${escapeHtml(formattedTime)}</strong></span>
                <span class="plaid-mapped-summary">
                    Mapped to Wallet: <strong>🧾 Bills (${formatMoney(bankBalances.bills)})</strong> &nbsp;•&nbsp;
                    <strong>💰 Rainy Day / Savings (${formatMoney(bankBalances.savings)})</strong>
                </span>
            `;
            refreshStateEl.style.display = "flex";
        } else {
            refreshStateEl.style.display = "none";
        }
    }

    if (mappingPanel) {
        mappingPanel.style.display = isConnected && plaidAccounts.length > 0 ? "block" : "none";
        populateQuickCategorySelects();
    }

    if (!container) return;

    if (!isConnected || plaidAccounts.length === 0) {
        container.innerHTML = `
            <div class="plaid-empty-state">
                <div class="plaid-empty-icon">🏦</div>
                <h3>No Bank Accounts Connected</h3>
                <p>Click <strong>"+ Add account"</strong> above to securely link your financial institution through Plaid Link.</p>
            </div>
        `;
        return;
    }

    const accountsByItem = new Map();
    plaidItems.forEach((item) => {
        accountsByItem.set(item.item_id, []);
    });
    plaidAccounts.forEach((acc) => {
        if (!accountsByItem.has(acc.item_id)) {
            accountsByItem.set(acc.item_id, []);
        }
        accountsByItem.get(acc.item_id).push(acc);
    });

    let html = "";
    plaidItems.forEach((item) => {
        const itemAccounts = accountsByItem.get(item.item_id) || [];
        const instName = escapeHtml(item.institution_name || "Connected Financial Institution");
        const safeItemId = escapeHtml(item.item_id);

        html += `
            <div class="plaid-institution-card" data-item-id="${safeItemId}">
                <div class="plaid-institution-header">
                    <div class="plaid-inst-info">
                        <span class="plaid-inst-icon">🏛️</span>
                        <div>
                            <h3 class="plaid-inst-name">${instName}</h3>
                            <span class="plaid-inst-meta">${itemAccounts.length} ${itemAccounts.length === 1 ? "Account" : "Accounts"} Linked • Status: Active</span>
                        </div>
                    </div>
                    <button type="button" class="btn-disconnect-item" onclick="promptDisconnectBank('${safeItemId}', '${instName.replace(/'/g, "\\'")}')">
                        🔌 Disconnect Bank
                    </button>
                </div>
                <div class="plaid-accounts-list">
        `;

        itemAccounts.forEach((acc) => {
            const accId = escapeHtml(acc.account_id);
            const accName = escapeHtml(acc.name);
            const officialName = acc.official_name && acc.official_name !== acc.name ? escapeHtml(acc.official_name) : "";
            const mask = acc.mask ? `••••${escapeHtml(acc.mask)}` : "";
            const subtypeLabel = escapeHtml(acc.subtype || acc.type || "account");
            const availBal =
                acc.available_balance !== null && acc.available_balance !== undefined
                    ? formatMoney(acc.available_balance)
                    : "N/A";
            const currBal =
                acc.current_balance !== null && acc.current_balance !== undefined
                    ? formatMoney(acc.current_balance)
                    : "N/A";
            const effectiveBal = formatMoney(acc.effective_balance);

            let mappingControlHtml = "";
            if (acc.eligible_category === "bills") {
                const isMapped = acc.mapped_category === "bills";
                mappingControlHtml = `
                    <label class="plaid-acc-map-label" for="map_${accId}">FundIQ Mapping:</label>
                    <select id="map_${accId}" class="plaid-acc-map-select ${isMapped ? "is-mapped-bills" : ""}" onchange="handleAccountMappingChange('${accId}', this.value)">
                        <option value="none" ${!isMapped ? "selected" : ""}>Not Mapped ($0.00 to Wallet)</option>
                        <option value="bills" ${isMapped ? "selected" : ""}>🧾 Mapped to Bills / Checking (+${effectiveBal})</option>
                    </select>
                `;
            } else if (acc.eligible_category === "savings") {
                const isMapped = acc.mapped_category === "savings";
                mappingControlHtml = `
                    <label class="plaid-acc-map-label" for="map_${accId}">FundIQ Mapping:</label>
                    <select id="map_${accId}" class="plaid-acc-map-select ${isMapped ? "is-mapped-savings" : ""}" onchange="handleAccountMappingChange('${accId}', this.value)">
                        <option value="none" ${!isMapped ? "selected" : ""}>Not Mapped ($0.00 to Wallet)</option>
                        <option value="savings" ${isMapped ? "selected" : ""}>💰 Mapped to Rainy Day / Savings (+${effectiveBal})</option>
                    </select>
                `;
            } else {
                mappingControlHtml = `
                    <div class="plaid-acc-ineligible-note">
                        Not eligible for Bills/Savings mapping (${subtypeLabel})
                    </div>
                `;
            }

            html += `
                <div class="plaid-account-row ${acc.mapped_category !== "none" ? `mapped-${escapeHtml(acc.mapped_category)}` : ""}">
                    <div class="plaid-account-main">
                        <div class="plaid-account-title-line">
                            <strong class="plaid-account-name">${accName}</strong>
                            ${mask ? `<span class="plaid-account-mask">${mask}</span>` : ""}
                            <span class="plaid-subtype-badge ${escapeHtml(acc.eligible_category)}">${subtypeLabel}</span>
                            ${acc.mapped_category === "bills" ? `<span class="plaid-mapped-pill bills">🧾 Bills / Checking</span>` : ""}
                            ${acc.mapped_category === "savings" ? `<span class="plaid-mapped-pill savings">💰 Rainy Day / Savings</span>` : ""}
                        </div>
                        ${officialName ? `<div class="plaid-official-name">${officialName}</div>` : ""}
                    </div>

                    <div class="plaid-account-balances">
                        <div class="plaid-bal-item">
                            <span class="plaid-bal-label">Available Balance</span>
                            <strong class="plaid-bal-value available">${availBal}</strong>
                        </div>
                        <div class="plaid-bal-item">
                            <span class="plaid-bal-label">Current Balance</span>
                            <span class="plaid-bal-value current">${currBal}</span>
                        </div>
                    </div>

                    <div class="plaid-account-mapping">
                        ${mappingControlHtml}
                    </div>
                </div>
            `;
        });

        html += `
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

function populateQuickCategorySelects() {
    const billsSelect = document.getElementById("billsAccountSelect");
    const savingsSelect = document.getElementById("savingsAccountSelect");
    if (!billsSelect || !savingsSelect) return;

    const checkingAccounts = plaidAccounts.filter((a) => a.eligible_category === "bills");
    const savingsAccounts = plaidAccounts.filter((a) => a.eligible_category === "savings");

    const mappedBills = checkingAccounts.filter((a) => a.mapped_category === "bills");
    const mappedSavings = savingsAccounts.filter((a) => a.mapped_category === "savings");

    let billsOptions = `<option value="none">— None Mapped ($0.00) —</option>`;
    checkingAccounts.forEach((acc) => {
        const mask = acc.mask ? ` ••••${escapeHtml(acc.mask)}` : "";
        const label = `${escapeHtml(acc.institution_name)}: ${escapeHtml(acc.name)}${mask} (${formatMoney(acc.effective_balance)})`;
        const isSelected = mappedBills.length === 1 && mappedBills[0].account_id === acc.account_id;
        billsOptions += `<option value="${escapeHtml(acc.account_id)}" ${isSelected ? "selected" : ""}>${label}</option>`;
    });
    if (checkingAccounts.length > 1) {
        const allSelected = mappedBills.length > 1;
        billsOptions += `<option value="all_checking" ${allSelected ? "selected" : ""}>All Connected Checking Accounts (${checkingAccounts.length})</option>`;
    }
    billsSelect.innerHTML = billsOptions;
    if (mappedBills.length === 0) billsSelect.value = "none";

    let savingsOptions = `<option value="none">— None Mapped ($0.00) —</option>`;
    savingsAccounts.forEach((acc) => {
        const mask = acc.mask ? ` ••••${escapeHtml(acc.mask)}` : "";
        const label = `${escapeHtml(acc.institution_name)}: ${escapeHtml(acc.name)}${mask} (${formatMoney(acc.effective_balance)})`;
        const isSelected = mappedSavings.length === 1 && mappedSavings[0].account_id === acc.account_id;
        savingsOptions += `<option value="${escapeHtml(acc.account_id)}" ${isSelected ? "selected" : ""}>${label}</option>`;
    });
    if (savingsAccounts.length > 1) {
        const allSelected = mappedSavings.length > 1;
        savingsOptions += `<option value="all_savings" ${allSelected ? "selected" : ""}>All Connected Savings Accounts (${savingsAccounts.length})</option>`;
    }
    savingsSelect.innerHTML = savingsOptions;
    if (mappedSavings.length === 0) savingsSelect.value = "none";
}

async function loadPlaidAccounts(refresh = false) {
    try {
        const url = refresh ? "/api/plaid/accounts?refresh=true" : "/api/plaid/accounts";
        const response = await fetch(resolveApiUrl(url), {
            credentials: "include"
        });

        if (response.status === 401) {
            renderPlaidSection();
            return;
        }

        const data = await safeParseJson(response);
        if (!response.ok || !data.success) {
            showPlaidAlert(`<strong>Error:</strong> ${escapeHtml(data.error || "Could not load bank accounts.")}`, "error");
            return;
        }

        plaidItems = Array.isArray(data.items) ? data.items : [];
        plaidAccounts = Array.isArray(data.accounts) ? data.accounts : [];
        applyServerSummary(data);
        renderPlaidSection();
        await loadProfileBillAccounts();
    } catch (e) {
        console.log("Plaid accounts load skipped (offline or unauthenticated):", e.message);
    }
}

async function openPlaidLink() {
    showPlaidAlert("", "info");

    if (typeof window.Plaid === "undefined") {
        showPlaidAlert(
            `<strong>Plaid Link Unavailable:</strong> Could not load the Plaid Link script from <code>cdn.plaid.com</code>. Please check your internet connection and refresh the page.`,
            "error"
        );
        return;
    }

    const connectBtn = document.getElementById("connectBankBtn");
    if (connectBtn) {
        connectBtn.disabled = true;
        connectBtn.textContent = "Initializing Plaid...";
    }

    let tokenRes;
    try {
        tokenRes = await fetch(resolveApiUrl("/api/plaid/create_link_token"), {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify({})
        });
    } catch (netErr) {
        console.error("openPlaidLink network error:", netErr);
        showPlaidAlert(
            `<strong>Server Connection Error:</strong> Could not reach the FundIQ Express server on <code>http://localhost:3000</code>. Please ensure the server is running (<code>npm start</code>) and open FundIQ at <a href="http://localhost:3000/profile.html">http://localhost:3000/profile.html</a>.`,
            "error"
        );
        if (connectBtn) connectBtn.disabled = false;
        renderPlaidSection();
        return;
    }

    try {
        if (tokenRes.status === 401) {
            showPlaidAlert(
                `<strong>Authentication Required:</strong> Please <a href="index.html">log in to your FundIQ account</a> before connecting a bank.`,
                "error"
            );
            return;
        }

        const tokenData = await safeParseJson(tokenRes);
        if (tokenData.nonJson) {
            showPlaidAlert(
                `<strong>Invalid Server Response:</strong> The server returned a non-JSON response (HTTP ${tokenRes.status}). Make sure you are accessing FundIQ through the Node/Express server at <a href="http://localhost:3000/profile.html">http://localhost:3000/profile.html</a>.`,
                "error"
            );
            return;
        }

        if (!tokenRes.ok || !tokenData.success || !tokenData.link_token) {
            showPlaidAlert(
                `<strong>Plaid Configuration / Token Error:</strong> ${escapeHtml(tokenData.error || "Unable to create Plaid Link token.")}`,
                "error"
            );
            return;
        }

        const handler = window.Plaid.create({
            token: tokenData.link_token,
            onSuccess: async (public_token, metadata) => {
                showPlaidAlert(`🔄 Verifying bank connection and retrieving account balances...`, "info");
                try {
                    const exchangeRes = await fetch(resolveApiUrl("/api/plaid/exchange_public_token"), {
                        method: "POST",
                        credentials: "include",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ public_token, metadata })
                    });

                    const exchangeData = await safeParseJson(exchangeRes);

                    if (!exchangeRes.ok || !exchangeData.success) {
                        showPlaidAlert(
                            `<strong>Bank Connection Notice:</strong> ${escapeHtml(exchangeData.error || "Failed to exchange token.")}`,
                            "error"
                        );
                        return;
                    }

                    plaidItems = Array.isArray(exchangeData.items) ? exchangeData.items : [];
                    plaidAccounts = Array.isArray(exchangeData.accounts) ? exchangeData.accounts : [];
                    applyServerSummary(exchangeData);
                    renderPlaidSection();
                    await loadProfileBillAccounts();

                    showPlaidAlert(
                        `<strong>✓ ${escapeHtml(exchangeData.message || "Bank connected successfully!")}</strong> Your checking and savings accounts have been mapped to your FundIQ Wallet.`,
                        "success"
                    );
                } catch (exErr) {
                    console.error("Plaid token exchange error:", exErr);
                    showPlaidAlert(
                        `<strong>Network Error:</strong> Failed to finish linking your bank account. Please try again.`,
                        "error"
                    );
                }
            },
            onExit: (err) => {
                if (err) {
                    const msg = err.display_message || err.error_message || "Bank connection exited with an error.";
                    showPlaidAlert(`<strong>Plaid Link Notice:</strong> ${escapeHtml(msg)}`, "error");
                }
            }
        });

        handler.open();
    } catch (sdkErr) {
        console.error("Plaid Link initialization error:", sdkErr);
        showPlaidAlert(
            `<strong>Plaid Link Initialization Error:</strong> ${escapeHtml(sdkErr.message || "Unable to open the Plaid Link dialog.")}`,
            "error"
        );
    } finally {
        if (connectBtn) {
            connectBtn.disabled = false;
        }
        renderPlaidSection();
    }
}

async function refreshBankBalances() {
    const refreshBtn = document.getElementById("refreshBankBtn");
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = "🔄 Refreshing...";
    }
    showPlaidAlert("🔄 Refreshing live balances and recurring bills from Plaid...", "info");

    try {
        const res = await fetch(resolveApiUrl("/api/plaid/refresh"), {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({})
        });

        const data = await safeParseJson(res);
        if (!res.ok || !data.success) {
            showPlaidAlert(`<strong>Refresh Error:</strong> ${escapeHtml(data.error || "Could not refresh balances.")}`, "error");
            return;
        }

        plaidItems = Array.isArray(data.items) ? data.items : [];
        plaidAccounts = Array.isArray(data.accounts) ? data.accounts : [];
        applyServerSummary(data);
        renderPlaidSection();
        await loadProfileBillAccounts();

        showPlaidAlert(
            `<strong>✓ Balances &amp; Bills Refreshed:</strong> ${escapeHtml(data.message || "Live bank balances updated.")}`,
            "success"
        );
    } catch (err) {
        console.error("refreshBankBalances error:", err);
        showPlaidAlert(`<strong>Network Error:</strong> Could not refresh balances from server.`, "error");
    } finally {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.textContent = "🔄 Refresh Balances";
        }
    }
}

async function handleAccountMappingChange(accountId, targetCategory) {
    try {
        const res = await fetch(resolveApiUrl("/api/plaid/mappings"), {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mappings: {
                    [accountId]: targetCategory
                }
            })
        });

        const data = await safeParseJson(res);
        if (!res.ok || !data.success) {
            showPlaidAlert(`<strong>Mapping Error:</strong> ${escapeHtml(data.error || "Failed to update mapping.")}`, "error");
            renderPlaidSection();
            return;
        }

        plaidItems = Array.isArray(data.items) ? data.items : plaidItems;
        plaidAccounts = Array.isArray(data.accounts) ? data.accounts : plaidAccounts;
        applyServerSummary(data);
        renderPlaidSection();

        showPlaidAlert(`<strong>✓ Wallet Mapping Updated:</strong> Your live bank balance mapping has been updated.`, "success");
    } catch (err) {
        console.error("handleAccountMappingChange error:", err);
        showPlaidAlert(`<strong>Network Error:</strong> Failed to save account mapping.`, "error");
    }
}

async function handleQuickCategorySelect(category, selectedValue) {
    const mappings = {};

    if (category === "bills") {
        plaidAccounts
            .filter((a) => a.eligible_category === "bills")
            .forEach((a) => {
                if (selectedValue === "all_checking" || selectedValue === a.account_id) {
                    mappings[a.account_id] = "bills";
                } else {
                    mappings[a.account_id] = "none";
                }
            });
    } else if (category === "savings") {
        plaidAccounts
            .filter((a) => a.eligible_category === "savings")
            .forEach((a) => {
                if (selectedValue === "all_savings" || selectedValue === a.account_id) {
                    mappings[a.account_id] = "savings";
                } else {
                    mappings[a.account_id] = "none";
                }
            });
    }

    try {
        const res = await fetch(resolveApiUrl("/api/plaid/mappings"), {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mappings })
        });

        const data = await safeParseJson(res);
        if (!res.ok || !data.success) {
            showPlaidAlert(`<strong>Mapping Error:</strong> ${escapeHtml(data.error || "Failed to update mapping.")}`, "error");
            renderPlaidSection();
            return;
        }

        plaidItems = Array.isArray(data.items) ? data.items : plaidItems;
        plaidAccounts = Array.isArray(data.accounts) ? data.accounts : plaidAccounts;
        applyServerSummary(data);
        renderPlaidSection();

        showPlaidAlert(
            `<strong>✓ Wallet Mapping Updated:</strong> Selected ${category === "bills" ? "Checking → Bills" : "Savings → Rainy Day / Savings"} mapping saved.`,
            "success"
        );
    } catch (err) {
        console.error("handleQuickCategorySelect error:", err);
        showPlaidAlert(`<strong>Network Error:</strong> Failed to save category mapping.`, "error");
    }
}

function promptDisconnectBank(itemId = null, institutionName = "") {
    pendingDisconnectItemId = itemId;
    const modal = document.getElementById("disconnectBankModal");
    const promptText = document.getElementById("disconnectBankPromptText");

    if (promptText) {
        if (itemId && institutionName) {
            promptText.innerHTML = `Are you sure you want to disconnect <strong>${escapeHtml(institutionName)}</strong> from your FundIQ account?`;
        } else {
            promptText.innerHTML = `Are you sure you want to disconnect all connected bank accounts from your FundIQ account?`;
        }
    }

    if (modal) {
        modal.classList.add("is-visible");
    } else {
        if (confirm("Are you sure you want to disconnect this bank connection? Your manual wallet balances and scheduled payments will remain intact.")) {
            executeDisconnectBank();
        }
    }
}

function closeDisconnectBankModal() {
    const modal = document.getElementById("disconnectBankModal");
    if (modal) {
        modal.classList.remove("is-visible");
    }
    pendingDisconnectItemId = null;
}

async function executeDisconnectBank() {
    const itemIdToDisconnect = pendingDisconnectItemId;
    closeDisconnectBankModal();

    showPlaidAlert("🔌 Disconnecting bank connection...", "info");

    try {
        const res = await fetch(resolveApiUrl("/api/plaid/disconnect"), {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(itemIdToDisconnect ? { item_id: itemIdToDisconnect } : { disconnectAll: true })
        });

        const data = await safeParseJson(res);
        if (!res.ok || !data.success) {
            showPlaidAlert(`<strong>Disconnect Error:</strong> ${escapeHtml(data.error || "Could not disconnect bank.")}`, "error");
            return;
        }

        plaidItems = Array.isArray(data.items) ? data.items : [];
        plaidAccounts = Array.isArray(data.accounts) ? data.accounts : [];
        applyServerSummary(data);
        renderPlaidSection();
        await loadProfileBillAccounts();

        showPlaidAlert(
            `<strong>✓ Bank Disconnected:</strong> ${escapeHtml(data.message || "Bank connection removed securely.")}`,
            "success"
        );
    } catch (err) {
        console.error("executeDisconnectBank error:", err);
        showPlaidAlert(`<strong>Network Error:</strong> Failed to disconnect bank connection.`, "error");
    }
}

// =============================================================
// DETECTED RECURRING BILLS & VERIFIED TRANSACTIONS
// =============================================================

async function loadProfileBillAccounts() {
    const listEl = document.getElementById("walletBillAccountsList");
    const statEl = document.getElementById("plaidBillCountStat");
    const pillEl = document.getElementById("billLinkedCountBadge");
    const verifiedWrap = document.getElementById("verifiedTransactionsWrap");
    const verifiedListEl = document.getElementById("verifiedBillTransactionsList");
    if (!listEl) return;

    let activePredictedBills = [];
    let manualTemplates = [];
    let txs = [];

    try {
        const res = await fetch(resolveApiUrl("/api/bills/detected"), { credentials: "include" });
        if (res.ok) {
            const data = await safeParseJson(res);
            if (data.success) {
                detectedBills = Array.isArray(data.detectedBills) ? data.detectedBills : [];
                activePredictedBills = Array.isArray(data.activePredictions) ? data.activePredictions : [];
                txs = Array.isArray(data.transactions) ? data.transactions : [];
                verifiedTransactions = txs;
                if (data.payments && Array.isArray(data.payments.templates)) {
                    manualTemplates = data.payments.templates.filter((t) => !t.isPredicted && !t.detectedBillId);
                }
            }
        }
    } catch (_) {}

    const totalBillCount = activePredictedBills.length + manualTemplates.length;
    if (statEl) statEl.textContent = String(totalBillCount);
    if (pillEl) pillEl.textContent = `${totalBillCount} linked`;

    let html = "";

    // 1. Render Detected Recurring Bills (Predicted or Confirmed from Plaid Transaction History)
    activePredictedBills.forEach((bill) => {
        const title = escapeHtml(bill.displayName || bill.name || "Detected Bill");
        const initial = escapeHtml((bill.displayName || "B").trim().charAt(0).toUpperCase());
        const amt = formatMoney(bill.expectedAmount || bill.amount || 0);
        const freq = escapeHtml(bill.frequency || "monthly");
        const nextDue = escapeHtml(bill.nextDueDate || "");
        const lastPaid = escapeHtml(bill.lastPaidDate || "");
        const accName = escapeHtml(bill.accountName || "Connected Checking Account");
        const isPredicted = bill.status !== "confirmed";
        const statusBadge = isPredicted
            ? `<span class="pred-status-pill predicted">🔮 Predicted</span>`
            : `<span class="pred-status-pill confirmed">✓ Confirmed</span>`;

        html += `
            <div class="conn-account-row detected-bill-row" data-detected-bill-id="${bill.id}">
                <div class="conn-acc-left">
                    <span class="conn-monogram">${initial}</span>
                    <div>
                        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                            <strong class="conn-acc-name">${title}</strong>
                            ${statusBadge}
                        </div>
                        <span class="conn-acc-sub">
                            Next estimated due: <strong>${nextDue}</strong> (${freq}) • ${accName}
                        </span>
                        <span class="conn-acc-sub" style="display:block; font-size:11px; color:#6B7280;">
                            Last confirmed payment: ${lastPaid} (${formatMoney(bill.lastPaidAmount || bill.expectedAmount)})
                        </span>
                    </div>
                </div>
                <div class="conn-acc-right" style="display:flex; align-items:center; gap:10px;">
                    <div style="text-align:right;">
                        <strong class="conn-acc-bal">${amt}</strong>
                        <span class="conn-acc-status">${isPredicted ? "Predicted Future Bill" : "Confirmed Schedule"}</span>
                    </div>
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <button type="button" class="btn-mini-action" onclick="openEditDetectedBillModal(${bill.id})">Edit</button>
                        <button type="button" class="btn-mini-action danger" onclick="dismissDetectedBill(${bill.id})">Dismiss</button>
                    </div>
                </div>
            </div>
        `;
    });

    // 2. Render Manual Scheduled Bills from Calendar
    manualTemplates.forEach((tpl) => {
        const title = escapeHtml(tpl.title || "Scheduled Bill");
        const initial = escapeHtml((tpl.title || "B").trim().charAt(0).toUpperCase());
        const amt = formatMoney(tpl.amount || 0);
        const freq = escapeHtml(tpl.recurrence || "one-time");
        const dateLabel = tpl.startDate ? `Next payment: ${escapeHtml(tpl.startDate)} (${freq})` : `Schedule (${freq})`;
        html += `
            <a href="home.html" class="conn-account-row">
                <div class="conn-acc-left">
                    <span class="conn-monogram">${initial}</span>
                    <div>
                        <strong class="conn-acc-name">${title}</strong>
                        <span class="conn-acc-sub">${dateLabel}</span>
                    </div>
                </div>
                <div class="conn-acc-right">
                    <div>
                        <strong class="conn-acc-bal">${amt}</strong>
                        <span class="conn-acc-status">Scheduled</span>
                    </div>
                    <span class="conn-chevron">›</span>
                </div>
            </a>
        `;
    });

    if (!html) {
        html = `
            <div style="padding: 16px 4px; color: #6B7280; font-size: 13px;">
                No recurring bills detected yet. Connect a checking account or add a payment on your Calendar.
            </div>
        `;
    }

    listEl.innerHTML = html;

    // 3. Render Verified Past Transactions (strictly distinguished from predicted future payments)
    if (verifiedWrap && verifiedListEl) {
        const confirmedOutflows = txs.filter((t) => !t.pending && Number(t.amount) > 0).slice(0, 8);
        if (confirmedOutflows.length === 0) {
            verifiedWrap.style.display = "none";
            verifiedListEl.innerHTML = "";
        } else {
            verifiedWrap.style.display = "block";
            verifiedListEl.innerHTML = confirmedOutflows
                .map((tx) => {
                    const name = escapeHtml(tx.merchant_name || tx.name || "Transaction");
                    const amt = formatMoney(tx.amount);
                    const date = escapeHtml(tx.date);
                    const acc = escapeHtml(tx.account_name || "Bank Account");
                    return `
                        <div class="conn-account-row verified-tx-row" style="padding: 8px 0;">
                            <div class="conn-acc-left">
                                <div>
                                    <div style="display:flex; align-items:center; gap:6px;">
                                        <strong class="conn-acc-name" style="font-size:13px;">${name}</strong>
                                        <span class="pred-status-pill verified">✓ Verified Transaction</span>
                                    </div>
                                    <span class="conn-acc-sub">Paid on ${date} • ${acc}</span>
                                </div>
                            </div>
                            <div class="conn-acc-right">
                                <strong class="conn-acc-bal" style="font-size:13px;">${amt}</strong>
                            </div>
                        </div>
                    `;
                })
                .join("");
        }
    }
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
        closeEditDetectedBillModal();
        await loadProfileBillAccounts();
        showPlaidAlert(
            `<strong>✓ Predicted Bill Updated:</strong> "${escapeHtml(displayName)}" has been updated and synced to your Payment Calendar.`,
            "success"
        );
    } catch (err) {
        if (errEl) {
            errEl.textContent = "Network error while saving bill.";
            errEl.style.display = "block";
        }
    }
}

async function dismissDetectedBill(billId) {
    try {
        const res = await fetch(resolveApiUrl(`/api/bills/detected/${encodeURIComponent(billId)}`), {
            method: "DELETE",
            credentials: "include"
        });
        const data = await safeParseJson(res);
        if (res.ok && data.success) {
            await loadProfileBillAccounts();
            showPlaidAlert(
                `<strong>✓ Prediction Dismissed:</strong> The predicted bill was dismissed and removed from your Calendar.`,
                "success"
            );
        }
    } catch (err) {
        console.error("Dismiss detected bill error:", err);
    }
}

// =============================================================
// EMAIL & SMS NOTIFICATION PREFERENCES (PROFILE PAGE ONLY)
// =============================================================

function setNotificationPanelMinimized(isMinimized, persist = true) {
    const panel = document.getElementById("emailNotificationsPanel");
    const body = document.getElementById("notifPanelBody");
    const toggleBtn = document.getElementById("toggleNotifPanelBtn");
    const toggleLabel = document.getElementById("toggleNotifPanelLabel");
    if (!panel || !body) return;

    if (isMinimized) {
        panel.classList.add("is-minimized");
        body.style.display = "none";
        if (toggleBtn) {
            toggleBtn.setAttribute("aria-expanded", "false");
            toggleBtn.setAttribute("title", "Expand notification settings");
        }
        if (toggleLabel) toggleLabel.textContent = "Expand";
    } else {
        panel.classList.remove("is-minimized");
        body.style.display = "block";
        if (toggleBtn) {
            toggleBtn.setAttribute("aria-expanded", "true");
            toggleBtn.setAttribute("title", "Minimize notification settings");
        }
        if (toggleLabel) toggleLabel.textContent = "Minimize";
    }

    if (persist) {
        try {
            localStorage.setItem("fundiqNotifPanelMinimized", isMinimized ? "1" : "0");
        } catch (_) {}
    }
}

function toggleNotificationPanel() {
    const panel = document.getElementById("emailNotificationsPanel");
    const currentlyMinimized = panel ? panel.classList.contains("is-minimized") : false;
    setNotificationPanelMinimized(!currentlyMinimized, true);
}

const toggleNotifBtn = document.getElementById("toggleNotifPanelBtn");
if (toggleNotifBtn) {
    toggleNotifBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleNotificationPanel();
    });
}

try {
    if (localStorage.getItem("fundiqNotifPanelMinimized") === "1") {
        setNotificationPanelMinimized(true, false);
    }
} catch (_) {}

function showNotifStatusBanner(message, type = "info") {
    const el = document.getElementById("notifStatusBanner");
    if (!el) return;
    if (!message) {
        el.style.display = "none";
        el.innerHTML = "";
        return;
    }
    el.className = `plaid-alert-banner ${type}`;
    el.innerHTML = message;
    el.style.display = "block";
}

function applyPrefsToForm(prefs) {
    if (!prefs) return;
    const emailEnabledEl = document.getElementById("prefEmailEnabled");
    const dueEl = document.getElementById("prefPaymentDueEnabled");
    const depEl = document.getElementById("prefDepositEnabled");
    const subEl = document.getElementById("prefPaymentSubmittedEnabled");
    const daysEl = document.getElementById("prefReminderDays");

    const smsEnabledEl = document.getElementById("prefSmsEnabled");
    const phoneEl = document.getElementById("prefPhoneNumber");
    const smsDueEl = document.getElementById("prefSmsPaymentDueEnabled");
    const smsDepEl = document.getElementById("prefSmsDepositEnabled");

    if (emailEnabledEl) emailEnabledEl.checked = Boolean(prefs.emailEnabled);
    if (dueEl) dueEl.checked = Boolean(prefs.paymentDueEnabled !== undefined ? prefs.paymentDueEnabled : prefs.notifyPaymentDue);
    if (depEl) depEl.checked = Boolean(prefs.depositEnabled !== undefined ? prefs.depositEnabled : prefs.notifyDepositMade);
    if (subEl) subEl.checked = Boolean(prefs.paymentSubmittedEnabled !== undefined ? prefs.paymentSubmittedEnabled : prefs.notifyPaymentSubmitted);
    if (daysEl && prefs.reminderDaysBefore !== undefined) {
        daysEl.value = String(prefs.reminderDaysBefore);
    }

    if (smsEnabledEl) smsEnabledEl.checked = Boolean(prefs.smsEnabled);
    if (phoneEl && prefs.phoneNumber !== undefined) {
        phoneEl.value = String(prefs.phoneNumber || "");
    }
    if (smsDueEl && prefs.smsPaymentDueEnabled !== undefined) {
        smsDueEl.checked = Boolean(prefs.smsPaymentDueEnabled);
    }
    if (smsDepEl && prefs.smsDepositEnabled !== undefined) {
        smsDepEl.checked = Boolean(prefs.smsDepositEnabled);
    }

    const modeBadge = document.getElementById("notifModeBadge");
    if (modeBadge) {
        const activeChannels = [];
        if (prefs.emailEnabled) activeChannels.push("Email");
        if (prefs.smsEnabled) activeChannels.push("SMS");
        modeBadge.textContent = activeChannels.length > 0 ? `${activeChannels.join(" & ")} Active` : "Paused";
    }
}

async function loadNotificationPreferences() {
    const form = document.getElementById("notificationPrefsForm");
    if (!form) return;

    try {
        const res = await fetch(resolveApiUrl("/api/notifications/preferences"), {
            credentials: "include",
            cache: "no-store"
        });
        if (!res.ok) return;

        const data = await safeParseJson(res);
        if (!data.success) return;

        applyPrefsToForm(data.preferences || {});
    } catch (e) {
        console.log("Notification preferences load skipped:", e.message);
    }
}

const notifFormEl = document.getElementById("notificationPrefsForm");
if (notifFormEl) {
    notifFormEl.addEventListener("submit", async (e) => {
        e.preventDefault();
        showNotifStatusBanner("", "info");

        const saveBtn = document.getElementById("saveNotifPrefsBtn");
        const phoneVal = (document.getElementById("prefPhoneNumber")?.value || "").trim();

        if (phoneVal) {
            const digits = phoneVal.replace(/\D/g, "");
            if (digits.length < 7 || digits.length > 15 || !/^[0-9+\-().\s]+$/.test(phoneVal)) {
                showNotifStatusBanner(
                    `<strong>Validation Error:</strong> Please enter a valid phone number (7 to 15 digits) or leave the field blank.`,
                    "error"
                );
                return;
            }
        }

        const payload = {
            emailEnabled: Boolean(document.getElementById("prefEmailEnabled")?.checked),
            paymentDueEnabled: Boolean(document.getElementById("prefPaymentDueEnabled")?.checked),
            notifyPaymentDue: Boolean(document.getElementById("prefPaymentDueEnabled")?.checked),
            depositEnabled: Boolean(document.getElementById("prefDepositEnabled")?.checked),
            notifyDepositMade: Boolean(document.getElementById("prefDepositEnabled")?.checked),
            paymentSubmittedEnabled: Boolean(document.getElementById("prefPaymentSubmittedEnabled")?.checked),
            notifyPaymentSubmitted: Boolean(document.getElementById("prefPaymentSubmittedEnabled")?.checked),
            reminderDaysBefore: Number(document.getElementById("prefReminderDays")?.value ?? 3),
            smsEnabled: Boolean(document.getElementById("prefSmsEnabled")?.checked),
            phoneNumber: phoneVal,
            smsPaymentDueEnabled: Boolean(document.getElementById("prefSmsPaymentDueEnabled")?.checked),
            smsDepositEnabled: Boolean(document.getElementById("prefSmsDepositEnabled")?.checked),
            smsPaymentSubmittedEnabled: Boolean(document.getElementById("prefSmsDepositEnabled")?.checked)
        };

        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = "Saving...";
        }

        try {
            const res = await fetch(resolveApiUrl("/api/notifications/preferences"), {
                method: "PUT",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const data = await safeParseJson(res);
            if (!res.ok || !data.success) {
                showNotifStatusBanner(
                    `<strong>Error:</strong> ${escapeHtml(data.error || "Could not save notification preferences.")}`,
                    "error"
                );
                return;
            }

            applyPrefsToForm(data.preferences || payload);
            showNotifStatusBanner(
                `<strong>✓ Preferences Saved:</strong> ${escapeHtml(data.message || "Your notification preferences have been saved.")}`,
                "success"
            );
        } catch (err) {
            showNotifStatusBanner(
                `<strong>Network Error:</strong> Could not save notification preferences. Please try again.`,
                "error"
            );
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = "Save Preferences";
            }
        }
    });
}

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        closeDisconnectBankModal();
        closeEditDetectedBillModal();
    }
});

renderPlaidSection();
loadPlaidAccounts(false);
loadNotificationPreferences();

