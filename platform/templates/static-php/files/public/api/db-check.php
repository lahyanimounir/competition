<?php
header('Content-Type: application/json');
try {
    $dsn = sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
        getenv('DB_HOST'), getenv('DB_PORT') ?: '3306', getenv('DB_DATABASE'));
    $pdo = new PDO($dsn, getenv('DB_USERNAME'), getenv('DB_PASSWORD'), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec('CREATE TABLE IF NOT EXISTS visits (id INT AUTO_INCREMENT PRIMARY KEY, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    $pdo->exec('INSERT INTO visits () VALUES ()');
    $count = (int) $pdo->query('SELECT COUNT(*) FROM visits')->fetchColumn();
    echo json_encode(['ok' => true, 'database' => getenv('DB_DATABASE'), 'visits' => $count]);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
}
