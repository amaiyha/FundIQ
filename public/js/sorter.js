const moneyForm = document.getElementById("moneyForm");

const statusSection = document.getElementById("statusSection");
const statusMessage = document.getElementById("statusMessage");

const resultSection = document.getElementById("resultSection");

const organizeButton = document.getElementById("organizeButton");

const editButton = document.getElementById("editButton");
const regenerateButton = document.getElementById("regenerateButton");
const acceptButton = document.getElementById("acceptButton");
const rejectButton = document.getElementById("rejectButton");

console.log("editButton:", editButton);
console.log("regenerateButton:", regenerateButton);
console.log("acceptButton:", acceptButton);
console.log("rejectButton:", rejectButton);

// -----------------------------
// SHOW / HIDE FUNCTIONS
// -----------------------------

function show(element) {
    element.style.display = "block";
}

function hide(element) {
    element.style.display = "none";
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

        hide(resultSection);

        return;
    }


    // Loading message

    showStatus(`
        <h3>Organizing your money...</h3>
        <p>
            FundIQ is creating your suggested plan.
            Please wait a moment.
        </p>
    `);

    hide(resultSection);

    organizeButton.disabled = true;
    organizeButton.textContent = "Creating Plan...";


    const startTime = performance.now();


    try {

        // Send information to server

        const response = await fetch("/api/allocate", {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify(data)

        });


        const result = await response.json();


        const endTime = performance.now();

        const responseTime =
            ((endTime - startTime) / 1000).toFixed(2);


        console.log(
            "FundIQ response time:",
            responseTime,
            "seconds"
        );


        // Check for server error

        if (!response.ok) {

            throw new Error(
                result.error || "Something went wrong."
            );

        }


        // Display the plan

        displayPlan(result.allocation);


        // Show whether OpenAI or Demo Mode was used

        if (result.mode === "demo") {

            showStatus(`
                <strong>Demo Mode</strong>

                <p>
                    OpenAI is currently unavailable, so FundIQ
                    created a sample recommendation for this prototype.
                </p>
            `);

        } else {

            showStatus(`
                <strong>AI plan created successfully.</strong>

                <p>
                    FundIQ created your suggestion in
                    ${responseTime} seconds.
                </p>
            `);

        }


    } catch (error) {

        console.error(error);

        showStatus(`
            <h3>We couldn't create your plan.</h3>

            <p>
                ${error.message}
            </p>

            <button onclick="createPlan()">
                Try Again
            </button>
        `);

        hide(resultSection);

    } finally {

        organizeButton.disabled = false;

        organizeButton.textContent =
            "Let's Organize My Money";

    }
}


// -----------------------------
// DISPLAY PLAN
// -----------------------------

function displayPlan(allocation) {
    const billsResult = document.getElementById("billsResult");
    const spendingResult = document.getElementById("spendingResult");
    const savingsResult = document.getElementById("savingsResult");
    const explanationResult =
        document.getElementById("explanationResult");

    billsResult.textContent = formatMoney(allocation.bills);
    spendingResult.textContent = formatMoney(allocation.spending);
    savingsResult.textContent = formatMoney(allocation.savings);

    // Save the actual numbers to the page
    billsResult.dataset.amount = allocation.bills;
    spendingResult.dataset.amount = allocation.spending;
    savingsResult.dataset.amount = allocation.savings;

    explanationResult.textContent =
        allocation.explanation;

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
// FORM SUBMISSION
// -----------------------------

moneyForm.addEventListener("submit", function(event) {

    event.preventDefault();

    createPlan();

});


// -----------------------------
// EDIT BUTTON
// -----------------------------

editButton.addEventListener("click", function() {

    hide(resultSection);

    document
        .getElementById("amountReceived")
        .focus();

    showStatus(`
        <strong>Edit your information.</strong>

        <p>
            Change any amount above and create a new plan.
        </p>
    `);

    window.scrollTo({

        top: 0,

        behavior: "smooth"

    });

});


// -----------------------------
// REGENERATE BUTTON
// -----------------------------

regenerateButton.addEventListener("click", function() {

    createPlan();

});


// -----------------------------
// ACCEPT BUTTON
// -----------------------------

acceptButton.addEventListener("click", function () {
    const bills = Number(
        document.getElementById("billsResult").dataset.amount
    );

    const spending = Number(
        document.getElementById("spendingResult").dataset.amount
    );

    const savings = Number(
        document.getElementById("savingsResult").dataset.amount
    );

    if (
        isNaN(bills) ||
        isNaN(spending) ||
        isNaN(savings)
    ) {
        showStatus(`
            <strong>Something went wrong.</strong>
            <p>
                FundIQ could not read the suggested plan.
                Please generate the plan again.
            </p>
        `);
        return;
    }

    const wallet = {
        bills: bills,
        spending: spending,
        savings: savings
    };

    localStorage.setItem(
        "fundiqWallet",
        JSON.stringify(wallet)
    );

    showStatus(`
        <strong>Plan accepted!</strong>
        <p>
            Your FundIQ plan has been saved to your Wallet.
        </p>

        <a href="wallet.html" class="card-button">
            View My Wallet
        </a>
    `);

    hide(resultSection);
});

// -----------------------------
// REJECT BUTTON
// -----------------------------

rejectButton.addEventListener("click", function() {

    hide(resultSection);

    showStatus(`
        <strong>Plan rejected.</strong>

        <p>
            No changes were made to your wallet.
            You can create another plan whenever you're ready.
        </p>
    `);

});