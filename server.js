const express = require("express");
const OpenAI = require("openai");
const path = require("path");
require("dotenv").config();

const app = express();

const PORT = 3000;


// -----------------------------
// OPENAI CONNECTION
// -----------------------------

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});


// -----------------------------
// MIDDLEWARE
// -----------------------------

app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));


// -----------------------------
// TEST ROUTE
// -----------------------------

app.get("/api/test", (req, res) => {

    res.json({
        message: "FundIQ server is working!"
    });

});


// -----------------------------
// AI ALLOCATION ROUTE
// -----------------------------

app.post("/api/allocate", async (req, res) => {
    try {
        const { amountReceived, bills, savingsGoal } = req.body;

        // Validate input
        if (
            typeof amountReceived !== "number" ||
            typeof bills !== "number" ||
            typeof savingsGoal !== "number"
        ) {
            return res.status(400).json({
                error: "Please enter valid numbers."
            });
        }

        if (amountReceived <= 0) {
            return res.status(400).json({
                error: "The amount received must be greater than $0."
            });
        }

        if (bills < 0 || savingsGoal < 0) {
            return res.status(400).json({
                error: "Bills and savings goals cannot be negative."
            });
        }

        if (bills + savingsGoal > amountReceived) {
            return res.status(400).json({
                error: "Your bills and savings goal are greater than the money received."
            });
        }


        // ------------------------------------------------
        // TRY OPENAI
        // ------------------------------------------------

        try {

            const prompt = `
You are FundIQ, an AI-powered financial organization assistant.

The user received $${amountReceived.toFixed(2)}.

Their upcoming bills total $${bills.toFixed(2)}.

Their savings goal is $${savingsGoal.toFixed(2)}.

Create a suggested allocation into exactly three categories:

1. Bills
2. Spending
3. Savings

Rules:
- Bills should cover the user's provided bills.
- Savings should consider the user's savings goal.
- Spending should be the remaining amount.
- The three amounts must add up exactly to $${amountReceived.toFixed(2)}.
- Explain that this is a suggestion.
- Keep the explanation simple.

Return ONLY valid JSON in this format:

{
    "bills": 0,
    "spending": 0,
    "savings": 0,
    "explanation": "short explanation"
}
`;

            const response = await client.responses.create({
                model: "gpt-5-mini",
                input: prompt
            });

            const aiText = response.output_text;

            const cleanedText = aiText
                .replace(/```json/g, "")
                .replace(/```/g, "")
                .trim();

            const allocation = JSON.parse(cleanedText);

            console.log("FundIQ used OpenAI.");

            return res.json({
                success: true,
                mode: "openai",
                allocation: allocation
            });

        } catch (openAIError) {

            console.log("OpenAI unavailable. Using FundIQ Demo Mode.");

            console.log(
                "OpenAI error:",
                openAIError.message
            );


            // ------------------------------------------------
            // DEMO / MOCK AI MODE
            // ------------------------------------------------

            const demoBills = bills;

            const demoSavings = savingsGoal;

            const demoSpending =
                amountReceived - demoBills - demoSavings;


            const demoAllocation = {

                bills: Number(demoBills.toFixed(2)),

                spending: Number(demoSpending.toFixed(2)),

                savings: Number(demoSavings.toFixed(2)),

                explanation:
                    "This is a FundIQ demo suggestion. " +
                    "Your bills and savings goal were set aside first, " +
                    "and the remaining money was assigned to spending. " +
                    "This is only a suggested organization of your money."
            };


            return res.json({

                success: true,

                mode: "demo",

                allocation: demoAllocation

            });
        }

    } catch (error) {

        console.error("FundIQ server error:", error);

        res.status(500).json({

            success: false,

            error:
                "FundIQ could not create your plan. Please try again."

        });
    }
});


// -----------------------------
// START SERVER
// -----------------------------

app.listen(PORT, () => {

    console.log(
        `FundIQ is running at http://localhost:${PORT}`
    );

});