<?php
// Must match API_KEY in the Arduino sketch. Use a long random string.
const API_KEY = '8xB9P6SqQAZTpwHnt4uYFXOze5dDMCov';

// How many readings to keep for the charts (3 s interval x 400 = 20 minutes)
const HISTORY_SIZE = 400;

// Where readings are stored (JSON files, no database needed)
const DATA_DIR = __DIR__ . '/data';

function read_json($file, $default) {
    if (!is_file($file)) return $default;
    $data = json_decode(file_get_contents($file), true);
    return $data ?? $default;
}

function write_json($file, $data) {
    if (!is_dir(DATA_DIR)) mkdir(DATA_DIR, 0755, true);
    file_put_contents($file, json_encode($data), LOCK_EX);
}

function send_json($data, $status = 200) {
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode($data);
    exit;
}
