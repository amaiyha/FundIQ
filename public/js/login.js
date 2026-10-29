// public/js/login.js - Secure Login Client
document.addEventListener("DOMContentLoaded", () => {
    const loginForm = document.getElementById("loginForm");
    const loginBtn = document.getElementById("loginBtn");
    const loginError = document.getElementById("loginError");
    const loginSuccess = document.getElementById("loginSuccess");
    const togglePasswordBtn = document.getElementById("togglePasswordBtn");
    const passwordInput = document.getElementById("password");
    const forgotPasswordLink = document.getElementById("forgotPasswordLink");

    if (togglePasswordBtn && passwordInput) {
        togglePasswordBtn.addEventListener("click", () => {
            const isPwd = passwordInput.type === "password";
            passwordInput.type = isPwd ? "text" : "password";
            togglePasswordBtn.setAttribute("aria-label", isPwd ? "Hide password" : "Show password");
        });
    }

    if (forgotPasswordLink) {
        forgotPasswordLink.addEventListener("click", (e) => {
            e.preventDefault();
            loginError.style.display = "none";
            loginSuccess.textContent = "Enter your username or email address above, or create a new FundIQ account below.";
            loginSuccess.style.display = "block";
        });
    }

    // Check for registration or logout query params
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("registered") === "1") {
        loginSuccess.textContent = "Account created successfully! Please log in below.";
        loginSuccess.style.display = "block";
    } else if (urlParams.get("loggedout") === "1") {
        // Ensure no stale user display data remains after logout
        localStorage.removeItem("fundiqUserId");
        localStorage.removeItem("fundiqName");
        localStorage.removeItem("fundiqUsername");
        localStorage.removeItem("fundiqEmail");
        localStorage.removeItem("fundiqWallet");
        localStorage.removeItem("fundiqPayments_v1");
        localStorage.removeItem("fundiqSubCategories_v1");
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
            loginError.textContent = "Please enter both your email/username and password.";
            loginError.style.display = "block";
            return;
        }

        loginBtn.disabled = true;
        loginBtn.innerHTML = "Logging in...";

        try {
            const response = await fetch("/api/auth/login", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                credentials: "same-origin",
                body: JSON.stringify({ username, password })
            });

            const data = await response.json();

            if (!response.ok || !data.success) {
                loginError.textContent = data.error || "Invalid username or password.";
                loginError.style.display = "block";
                return;
            }

            // Clear cached per-user data if switching accounts
            const previousUserId = localStorage.getItem("fundiqUserId");
            if (previousUserId !== String(data.user.id)) {
                localStorage.removeItem("fundiqWallet");
                localStorage.removeItem("fundiqPayments_v1");
                localStorage.removeItem("fundiqSubCategories_v1");
            }

            // Save authenticated user display info
            const resolvedName = (data.user.fullName && data.user.fullName.trim())
                ? data.user.fullName.trim()
                : data.user.username;
            localStorage.setItem("fundiqUserId", String(data.user.id));
            localStorage.setItem("fundiqName", resolvedName);
            localStorage.setItem("fundiqUsername", data.user.username);
            if (data.user.email) {
                localStorage.setItem("fundiqEmail", data.user.email);
            } else {
                localStorage.removeItem("fundiqEmail");
            }

            // Redirect to home dashboard
            window.location.href = "home.html";

        } catch (err) {
            console.error("Login request failed:", err);
            loginError.textContent = "Network connection error. Please make sure the server is running.";
            loginError.style.display = "block";
        } finally {
            loginBtn.disabled = false;
            loginBtn.innerHTML = 'Log in <span class="btn-arrow">→</span>';
        }
    });
});