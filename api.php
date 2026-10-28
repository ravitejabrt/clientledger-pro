<?php
/**
 * ClientLedger Pro - BigRock MySQL Backend API
 * Connects front-end application to BigRock cPanel MySQL database.
 */

header('Content-Type: application/json; charset=UTF-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With, Origin, Accept');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// ==============================================================
// 1. DATABASE CONFIGURATION (Update with your BigRock details)
// ==============================================================
$DB_HOST = 'localhost';               // Usually 'localhost' on BigRock
$DB_NAME = 'cpaneluser_ledgerdb';     // Your BigRock Database Name (e.g. rahul_ledgerdb)
$DB_USER = 'cpaneluser_dbuser';       // Your BigRock Database Username
$DB_PASS = 'YourStrongPassword123#';  // Your BigRock Database Password

// Database Connection
try {
    $pdo = new PDO("mysql:host={$DB_HOST};dbname={$DB_NAME};charset=utf8mb4", $DB_USER, $DB_PASS, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ]);

    // Ensure table exists
    $pdo->exec("CREATE TABLE IF NOT EXISTS `clientledger_data` (
        `id` VARCHAR(64) NOT NULL PRIMARY KEY,
        `data` LONGTEXT NOT NULL,
        `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;");

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error'   => 'Database connection failed: ' . $e->getMessage(),
        'hint'    => 'Check $DB_NAME, $DB_USER, and $DB_PASS inside api.php'
    ]);
    exit;
}

$action = isset($_GET['action']) ? $_GET['action'] : '';

// ==============================================================
// 2. API ACTIONS
// ==============================================================

// PING / STATUS TEST
if ($action === 'ping') {
    echo json_encode([
        'success'   => true,
        'message'   => 'Successfully connected to BigRock MySQL database!',
        'timestamp' => date('Y-m-d H:i:s')
    ]);
    exit;
}

// LOAD DATA
if ($action === 'load' || $_SERVER['REQUEST_METHOD'] === 'GET') {
    $stmt = $pdo->prepare("SELECT `data` FROM `clientledger_data` WHERE `id` = 'main_store' LIMIT 1");
    $stmt->execute();
    $row = $stmt->fetch();

    if ($row && !empty($row['data'])) {
        $parsed = json_decode($row['data'], true);
        echo json_encode([
            'success' => true,
            'source'  => 'bigrock_mysql',
            'data'    => $parsed
        ]);
    } else {
        echo json_encode([
            'success' => true,
            'source'  => 'empty',
            'data'    => null
        ]);
    }
    exit;
}

// SAVE DATA
if ($action === 'save' || $_SERVER['REQUEST_METHOD'] === 'POST') {
    $rawInput = file_get_contents('php://input');
    if (empty($rawInput)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'No data received']);
        exit;
    }

    // Validate JSON format
    $decoded = json_decode($rawInput, true);
    if ($decoded === null) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid JSON input']);
        exit;
    }

    $stmt = $pdo->prepare("INSERT INTO `clientledger_data` (`id`, `data`)
        VALUES ('main_store', :data)
        ON DUPLICATE KEY UPDATE `data` = VALUES(`data`)");
    
    $stmt->execute([':data' => $rawInput]);

    echo json_encode([
        'success' => true,
        'message' => 'Data saved to BigRock MySQL successfully',
        'savedAt' => date('Y-m-d H:i:s')
    ]);
    exit;
}

// DEFAULT FALLBACK
echo json_encode([
    'success' => false,
    'error'   => 'Invalid API action. Use action=load, action=save, or action=ping'
]);
