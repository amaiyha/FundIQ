// public/js/home.js - Home Dashboard session integration
document.addEventListener("DOMContentLoaded", async () => {
    // Check authenticated session
    try {
        const response = await fetch("/api/auth/me");
        if (response.ok) {
            const data = await response.json();
            if (data.authenticated && data.user) {
                const nameEl = document.getElementById("userName");
                if (nameEl) {
                    nameEl.textContent = data.user.fullName || data.user.username;
                }
                localStorage.setItem("fundiqName", data.user.fullName || data.user.username);
                localStorage.setItem("fundiqUsername", data.user.username);
                return;
            }
        }
    } catch (e) {
        console.log("Session verification offline:", e.message);
    }

    // Fallback to local storage if server offline
    const userName = localStorage.getItem("fundiqName");
    if (userName) {
        const nameEl = document.getElementById("userName");
        if (nameEl) nameEl.textContent = userName;
    }
});