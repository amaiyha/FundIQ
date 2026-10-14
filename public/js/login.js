const loginForm = document.getElementById("loginForm");

loginForm.addEventListener("submit", function(event) {
    event.preventDefault();

    const name = document.getElementById("name").value;
    const email = document.getElementById("email").value;

    // Save user information temporarily
    localStorage.setItem("fundiqName", name);
    localStorage.setItem("fundiqEmail", email);

    // Send user to the home page
    window.location.href = "home.html";
});