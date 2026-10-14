// public/js/register.js - Account Registration Client
document.addEventListener("DOMContentLoaded", () => {
    const registerForm = document.getElementById("registerForm");
    const registerBtn = document.getElementById("registerBtn");
    const registerError = document.getElementById("registerError");

    registerForm.addEventListener("submit", async function(event) {
        event.preventDefault();
        registerError.style.display = "none";

        const fullName = document.getElementById("fullName").value.trim();
        const username = document.getElementById("username").value.trim();
        const email = document.getElementById("email").value.trim();
        const password = document.getElementById("password").value;

        // Frontend validation
        if (!fullName || !username || !email || !password) {
            showError("All fields are required. Please fill out every field.");
            return;
        }

        const usernameRegex = /^[a-zA-Z0-9_]{3,30}$/;
        if (!usernameRegex.test(username)) {
            showError("Username must be between 3 and 30 characters and contain only letters, numbers, and underscores.");
            return;
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            showError("Please enter a valid email address (e.g. name@example.com).");
            return;
        }

        if (password.length < 8) {
            showError("Password must be at least 8 characters long.");
            return;
        }

        registerBtn.disabled = true;
        registerBtn.textContent = "Creating Account...";

        try {
            const response = await fetch("/api/auth/register", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    fullName,
                    username,
                    email,
                    password
                })
            });

            const data = await response.json();

            if (!response.ok || !data.success) {
                showError(data.error || "Failed to create account. Please check your information.");
                return;
            }

            // Redirect to login page with registered=1 query param
            window.location.href = "index.html?registered=1";

        } catch (err) {
            console.error("Registration request failed:", err);
            showError("Network connection error. Please make sure the server is running.");
        } finally {
            registerBtn.disabled = false;
            registerBtn.textContent = "Create Account";
        }
    });

    function showError(msg) {
        registerError.textContent = msg;
        registerError.style.display = "block";
    }
});

