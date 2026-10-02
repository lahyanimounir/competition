let clicks = 0;
document.getElementById('hello').addEventListener('click', () => {
  clicks += 1;
  document.getElementById('output').textContent = `JavaScript works - clicked ${clicks} time${clicks > 1 ? 's' : ''}.`;
});
