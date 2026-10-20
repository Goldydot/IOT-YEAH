<?php
// POST (from ESP32, needs X-API-Key header): save a reading, reply with buzzer mode
// GET  (from website):                        latest reading [+ history with ?history=1]
require __DIR__ . '/config.php';

$latestFile  = DATA_DIR . '/latest.json';
$historyFile = DATA_DIR . '/history.json';
$controlFile = DATA_DIR . '/control.json';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $key = $_SERVER['HTTP_X_API_KEY'] ?? '';
    if (!hash_equals(API_KEY, $key)) send_json(['error' => 'invalid API key'], 401);

    $in = json_decode(file_get_contents('php://input'), true);
    if (!is_array($in)) send_json(['error' => 'body must be JSON'], 400);

    $num = fn($k) => isset($in[$k]) && is_numeric($in[$k]) ? round((float)$in[$k], 1) : null;
    $reading = [
        'temperature' => $num('temperature'),
        'humidity'    => $num('humidity'),
        'distance'    => $num('distance'),
        'raining'     => !empty($in['raining']),
        'dark'        => !empty($in['dark']),
        'buzzer'      => !empty($in['buzzer']),
        'reason'      => substr(strip_tags((string)($in['reason'] ?? '')), 0, 40),
        'time'        => time(),
    ];

    write_json($latestFile, $reading);
    $history = read_json($historyFile, []);
    $history[] = $reading;
    write_json($historyFile, array_slice($history, -HISTORY_SIZE));

    $control = read_json($controlFile, ['buzzer' => 'auto']);
    send_json(['ok' => true, 'buzzer' => $control['buzzer'] ?? 'auto', 'beep' => (int)($control['beep'] ?? 0)]);
}

$out = [
    'latest'     => read_json($latestFile, null),
    'control'    => read_json($controlFile, ['buzzer' => 'auto']),
    'serverTime' => time(),
];
if (isset($_GET['history'])) $out['history'] = read_json($historyFile, []);
send_json($out);
