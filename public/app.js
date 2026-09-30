const moneyForm = document.getElementById("moneyForm");

const statusSection = document.getElementById("statusSection");
const statusMessage = document.getElementById("statusMessage");

const resultSection = document.getElementById("resultSection");

const acceptedSection = document.getElementById("acceptedSection");
const rejectedSection = document.getElementById("rejectedSection");

const organizeButton = document.getElementById("organizeButton");

const editButton = document.getElementById("editButton");
const regenerateButton = document.getElementById("regenerateButton");
const acceptButton = document.getElementById("acceptButton");
const rejectButton = document.getElementById("rejectButton");

const newPlanButton = document.getElementById("newPlanButton");
const tryAgainButton = document.getElementById("tryAgainButton");


// -----------------------------
// SHOW / HIDE FUNCTIONS
// -----------------------------

function show(element) {
    element.classList.remove("hidden");
}

function hide(element) {
    element.classList.add("hidden");
}


// -----------------------------
// STATUS MESSAGE
// -----------------------------

function showStatus(message) {
    show(statusSection);
    statusMessage.innerHTML = message;
}


// -----------------------------
// GET USER INPUT
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


    // -----------------------------
    // LOADING STATE
    // -----------------------------

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

        // -----------------------------
        // SEND INFORMATION TO SERVER
        // -----------------------------

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
            "FundIQ AI response time:",
            responseTime,
            "seconds"
        );


        // -----------------------------
        // ERROR FROM SERVER
        // -----------------------------

        if (!response.ok) {

            throw new Error(
                result.error || "Something went wrong."
            );

        }


        // -----------------------------
        // SUCCESS STATE
        // -----------------------------

        displayPlan(result.allocation);

        showStatus(`
            <strong>Plan created successfully.</strong>
            <p>
                FundIQ created this suggestion in
                ${responseTime} seconds.
            </p>
        `);


    } catch (error) {

        console.error(error);


        // -----------------------------
        // ERROR STATE
        // -----------------------------

        showStatus(`
            <h3>We couldn't create your plan.</h3>

            <p>
                ${error.message}
            </p>

            <button onclick="createPlan()">
                Try Again
            </button>

            <p>
                You can also manually organize your money
                using your own financial information.
            </p>
        `);

        hide(resultSection);

    } finally {

        organizeButton.disabled = false;

        organizeButton.textContent =
            "Organize My Money";

    }
}


// -----------------------------
// DISPLAY AI PLAN
// -----------------------------

function displayPlan(allocation) {

    document.getElementById("billsResult").textContent =
        formatMoney(allocation.bills);

    document.getElementById("spendingResult").textContent =
        formatMoney(allocation.spending);

    document.getElementById("savingsResult").textContent =
        formatMoney(allocation.savings);

    document.getElementById("explanationResult").textContent =
        allocation.explanation;

    show(resultSection);

    hide(acceptedSection);
    hide(rejectedSection);
}


// -----------------------------
// MONEY FORMAT
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

acceptButton.addEventListener("click", function() {

    hide(resultSection);

    show(acceptedSection);

    showStatus(`
        <strong>Plan accepted.</strong>
        <p>
            Your FundIQ suggestion has been accepted.
        </p>
    `);

});


// -----------------------------
// REJECT BUTTON
// -----------------------------

rejectButton.addEventListener("click", function() {

    hide(resultSection);

    show(rejectedSection);

    showStatus(`
        <strong>Plan rejected.</strong>
        <p>
            You can create another plan whenever you're ready.
        </p>
    `);

});


// -----------------------------
// NEW PLAN
// -----------------------------

newPlanButton.addEventListener("click", function() {

    hide(acceptedSection);

    hide(statusSection);

    moneyForm.reset();

    document
        .getElementById("amountReceived")
        .focus();

});


// -----------------------------
// TRY AGAIN
// -----------------------------

tryAgainButton.addEventListener("click", function() {

    hide(rejectedSection);

    createPlan();

});