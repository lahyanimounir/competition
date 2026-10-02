<?php $title = '__WS_APP_NAME__'; ?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title><?= htmlspecialchars($title) ?></title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <main>
    <h1><?= htmlspecialchars($title) ?></h1>
    <p>Deployed with <code>git push</code>. Edit <code>public/index.php</code> to get started.</p>
    <ul>
      <li>PHP <?= PHP_VERSION ?></li>
      <li>pdo_mysql: <?= extension_loaded('pdo_mysql') ? 'yes' : 'no' ?></li>
      <li>pdo_sqlite: <?= extension_loaded('pdo_sqlite') ? 'yes' : 'no' ?></li>
    </ul>
    <button id="check">Check database connection</button>
    <pre id="result"></pre>
  </main>
  <script src="js/app.js"></script>
</body>
</html>
