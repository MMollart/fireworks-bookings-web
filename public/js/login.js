document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('loginForm');
  const alertBox = document.getElementById('loginAlert');
  const submitBtn = document.getElementById('submitBtn');
  const usernameInput = document.getElementById('usernameInput');
  const passwordInput = document.getElementById('passwordInput');

  function showAlert(msg) {
    alertBox.textContent = msg;
    alertBox.classList.add('error');
    alertBox.style.display = 'block';
  }

  function hideAlert() {
    alertBox.textContent = '';
    alertBox.classList.remove('error');
    alertBox.style.display = 'none';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username || !password) {
      showAlert('Please enter both username and password.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in...';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        showAlert(data.message || data.error || 'Authentication failed. Please check credentials.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign In';
        return;
      }

      // Successful login
      window.location.href = '/dashboard';
    } catch {
      showAlert('Connection error. Please check your network and try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign In';
    }
  });
});
