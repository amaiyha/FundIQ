let wallet = JSON.parse(localStorage.getItem("fundiqWallet")) || {
    bills: 0,
    spending: 0,
    savings: 0
};

function updateWallet() {

    const total =
        wallet.bills +
        wallet.spending +
        wallet.savings;

    document.getElementById("billsAmount").textContent =
        `$${wallet.bills.toFixed(2)}`;

    document.getElementById("spendingAmount").textContent =
        `$${wallet.spending.toFixed(2)}`;

    document.getElementById("savingsAmount").textContent =
        `$${wallet.savings.toFixed(2)}`;

    document.getElementById("totalAmount").textContent =
        `$${total.toFixed(2)}`;
}

function addMoney() {

    const amount = Number(
        prompt("How much money would you like to add?")
    );

    if (isNaN(amount) || amount <= 0) {
        alert("Please enter a valid amount.");
        return;
    }

    wallet.spending += amount;

    localStorage.setItem(
        "fundiqWallet",
        JSON.stringify(wallet)
    );

    updateWallet();
}

updateWallet();