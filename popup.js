document.addEventListener('DOMContentLoaded', async () => {
  const { theme } = await chrome.storage.local.get('theme');
  const radios = document.querySelectorAll('input[name="theme"]');
  
  const savedInput = theme ? document.querySelector(`input[value="${theme}"]`) : null;
  if (savedInput) {
    savedInput.checked = true;
  } else {
    document.querySelector('input[value="light"]').checked = true;
  }

  radios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      chrome.storage.local.set({ theme: e.target.value });
    });
  });
});