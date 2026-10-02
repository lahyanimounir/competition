document.getElementById('check').addEventListener('click', async () => {
  const out = document.getElementById('result');
  out.textContent = 'Checking...';
  const res = await fetch('api/db-check.php');
  out.textContent = JSON.stringify(await res.json(), null, 2);
});
