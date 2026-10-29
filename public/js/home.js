// public/js/home.js - Home Dashboard session integration
document.addEventListener("DOMContentLoaded", async () => {
    // Format current date eyebrow (e.g., WEDNESDAY, OCTOBER 28)
    const dateEyebrow = document.getElementById("currentDateEyebrow");
    if (dateEyebrow) {
        const now = new Date();
        dateEyebrow.textContent = now.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric"
        }).toUpperCase();
    }

    function setWelcomeNameGreeting(fullNameOrUsername) {
        const nameEl = document.getElementById("userName");
        if (!nameEl) return;
        const clean = fullNameOrUsername && String(fullNameOrUsername).trim()
            ? String(fullNameOrUsername).trim()
            : "Guest";
        nameEl.textContent = clean;
    }

    // Check authenticated session on server (authoritative source of truth)
    try {
        const response = await fetch("/api/auth/me", {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store"
        });
        if (response.ok) {
            const data = await response.json();
            if (data.authenticated && data.user) {
                const display = (data.user.fullName && data.user.fullName.trim())
                    ? data.user.fullName.trim()
                    : data.user.username;
                setWelcomeNameGreeting(display);
                localStorage.setItem("fundiqUserId", String(data.user.id));
                localStorage.setItem("fundiqName", display);
                localStorage.setItem("fundiqUsername", data.user.username);
                if (data.user.email) {
                    localStorage.setItem("fundiqEmail", data.user.email);
                }
                return;
            } else {
                // Unauthenticated session: do not fall back to another user's cached localStorage name
                localStorage.removeItem("fundiqUserId");
                localStorage.removeItem("fundiqName");
                localStorage.removeItem("fundiqUsername");
                localStorage.removeItem("fundiqEmail");
                setWelcomeNameGreeting("Guest");
                return;
            }
        }
    } catch (e) {
        console.log("Session verification offline:", e.message);
    }

    // Fallback to local storage only if server is unreachable
    const userName = localStorage.getItem("fundiqName");
    if (userName) {
        setWelcomeNameGreeting(userName);
    } else {
        setWelcomeNameGreeting("Guest");
    }
});