// public/js/login.js - Secure Login Client
document.addEventListener("DOMContentLoaded", () => {
    const loginForm = document.getElementById("loginForm");
    const loginBtn = document.getElementById("loginBtn");
    const loginError = document.getElementById("loginError");
    const loginSuccess = document.getElementById("loginSuccess");

    // Check for registration or logout query params
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("registered") === "1") {
        loginSuccess.textContent = "Account created successfully! Please log in below.";
        loginSuccess.style.display = "block";
    } else if (urlParams.get("loggedout") === "1") {
        loginSuccess.textContent = "You have been logged out successfully.";
        loginSuccess.style.display = "block";
    }

    loginForm.addEventListener("submit", async function(event) {
        event.preventDefault();
        loginError.style.display = "none";
        loginSuccess.style.display = "none";

        const username = document.getElementById("username").value.trim();
        const password = document.getElementById("password").value;

        if (!username || !password) {
            loginError.textContent = "Please enter both your username and password.";
            loginError.style.display = "block";
            return;
        }

        loginBtn.disabled = true;
        loginBtn.textContent = "Logging in...";

        try {
            const response = await fetch("/api/auth/login", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ username, password })
            });

            const data = await response.json();

            if (!response.ok || !data.success) {
                loginError.textContent = data.error || "Invalid username or password.";
                loginError.style.display = "block";
                return;
            }

            // Save non-sensitive display preference only
            localStorage.setItem("fundiqName", data.user.fullName || data.user.username);
            localStorage.setItem("fundiqUsername", data.user.username);

            // Redirect to home dashboard
            window.location.href = "home.html";

        } catch (err) {
            console.error("Login request failed:", err);
            loginError.textContent = "Network connection error. Please make sure the server is running.";
            loginError.style.display = "block";
        } finally {
            loginBtn.disabled = false;
            loginBtn.textContent = "Log In";
        }
    });
});