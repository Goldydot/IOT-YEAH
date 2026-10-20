<?php
// POST {"mode": "auto" | "on" | "off"}  -> set buzzer mode
// POST {"action": "beep"}                -> one short buzz (clap from the website)
// The ESP32 picks it up in the reply to its next reading.
require __DIR__ . '/config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') send_json(['error' => 'POST only'], 405);

$in = json_decode(file_get_contents('php://input'), true);
$controlFile = DATA_DIR . '/control.json';
$control = read_json($controlFile, ['buzzer' => 'auto', 'beep' => 0]);

if (($in['action'] ?? '') === 'beep') {
    $control['beep'] = (int)($control['beep'] ?? 0) + 1;
} else {
    $mode = $in['mode'] ?? '';
    if (!in_array($mode, ['auto', 'on', 'off'], true)) send_json(['error' => 'mode must be auto, on or off'], 400);
    $control['buzzer'] = $mode;
}

write_json($controlFile, $control);
send_json(['ok' => true] + $control);
