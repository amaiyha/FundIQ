// public/js/wallet.js - Connected Wallet & Clear Wallet Logic

let wallet = {
    bills: 0,
    spending: 0,
    savings: 0
};

// Try loading local fallback initially
try {
    const local = localStorage.getItem("fundiqWallet");
    if (local) {
        wallet = JSON.parse(local);
    }
} catch (e) {
    console.error("Local wallet parse error:", e);
}

function updateWallet() {
    const total = (Number(wallet.bills) || 0) + (Number(wallet.spending) || 0) + (Number(wallet.savings) || 0);

    const billsEl = document.getElementById("billsAmount");
    const spendingEl = document.getElementById("spendingAmount");
    const savingsEl = document.getElementById("savingsAmount");
    const totalEl = document.getElementById("totalAmount");

    if (billsEl) billsEl.textContent = `$${(Number(wallet.bills) || 0).toFixed(2)}`;
    if (spendingEl) spendingEl.textContent = `$${(Number(wallet.spending) || 0).toFixed(2)}`;
    if (savingsEl) savingsEl.textContent = `$${(Number(wallet.savings) || 0).toFixed(2)}`;
    if (totalEl) totalEl.textContent = `$${total.toFixed(2)}`;
}

// Fetch authenticated wallet from server on page load
async function syncWalletFromServer() {
    try {
        const response = await fetch("/api/wallet");
        if (response.ok) {
            const data = await response.json();
            if (data.success && data.wallet) {
                wallet = {
                    bills: Number(data.wallet.bills) || 0,
                    spending: Number(data.wallet.spending) || 0,
                    savings: Number(data.wallet.savings) || 0
                };
                localStorage.setItem("fundiqWallet", JSON.stringify(wallet));
                updateWallet();
            }
        }
    } catch (e) {
        console.log("Using local wallet (server sync unavailable):", e.message);
    }
}

async function addMoney() {
    const amount = Number(
        prompt("How much money would you like to add?")
    );

    if (isNaN(amount) || amount <= 0) {
        alert("Please enter a valid amount.");
        return;
    }

    wallet.spending = Math.round(((wallet.spending || 0) + amount) * 100) / 100;
    localStorage.setItem("fundiqWallet", JSON.stringify(wallet));
    updateWallet();

    // Persist to server if authenticated
    try {
        await fetch("/api/wallet", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(wallet)
        });
    } catch (e) {
        console.error("Failed to sync addMoney to server:", e);
    }
}

function promptClearWallet() {
    const modal = document.getElementById("clearWalletModal");
    if (modal) {
        modal.classList.add("is-visible");
    } else {
        if (confirm("Are you sure you want to clear your wallet balances to $0.00? Your calendar events and recurring payments will remain completely intact.")) {
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

    // 1. Reset balances only (Bills, Spending, Savings to 0)
    wallet = { bills: 0, spending: 0, savings: 0 };
    localStorage.setItem("fundiqWallet", JSON.stringify(wallet));
    updateWallet();

    // 2. Clear via authenticated server endpoint
    try {
        const response = await fetch("/api/wallet/clear", {
            method: "POST",
            headers: { "Content-Type": "application/json" }
        });
        const data = await response.json();
        if (data.success && data.wallet) {
            wallet = data.wallet;
            updateWallet();
        }
    } catch (e) {
        console.error("Server wallet clear error:", e);
    }

    // 3. Show confirmation notice
    const notice = document.getElementById("walletNotice");
    if (notice) {
        notice.innerHTML = `
            <strong>Wallet Cleared:</strong> All wallet balances have been reset to $0.00.
            <div style="margin-top: 4px; font-size: 12.5px;">Your scheduled payments, calendar events, and completion history remain intact.</div>
        `;
        notice.style.display = "block";
    }
}

// Close modal on Escape
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        closeClearWalletModal();
    }
});

updateWallet();
syncWalletFromServer();