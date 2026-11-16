# BlueMatrix Scheduler

Web UI untuk mengatur cron di Linux OpenStick (Debian/Ubuntu/Armbian dll).
Tanpa dependensi npm, cukup Node.js >= 8 dan paket `cron`.

## Login

- Username: `username`
- Password: `password`

Untuk mengganti: jalankan dengan `AUTH_USER=... AUTH_PASS=... node server.js`.

## Instalasi di OpenStick

```bash
apt update && apt install -y nodejs cron
systemctl enable --now cron

mkdir -p /opt/bluematrix-scheduler
# salin server.js, package.json dan folder public/ ke /opt/bluematrix-scheduler

cp /opt/bluematrix-scheduler/bluematrix-scheduler.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bluematrix-scheduler
```

Buka `http://IP-OPENSTICK:8080` (mis. `http://192.168.5.1:8080`).

Tanpa systemd, jalankan manual: `PORT=8080 node server.js`.

## Cara kerja

- Setiap job disimpan di `data/jobs.json`, perintahnya ditulis ke `data/scripts/<id>.sh`.
- Aplikasi mengelola satu blok di crontab user yang menjalankannya (bagian lain crontab tidak disentuh).
- Output tiap job dicatat di `data/logs/<id>.log` (dipangkas otomatis di atas 512 KB).
- Job tetap berjalan oleh cron walau aplikasi ini dimatikan.
- Jalankan sebagai root agar job bisa memakai perintah seperti `reboot`.

## Variabel lingkungan

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | 8080 | Port web |
| `HOST` | 0.0.0.0 | Alamat bind |
| `AUTH_USER` | username | Username Basic Auth |
| `AUTH_PASS` | password | Password Basic Auth |
| `DATA_DIR` | ./data | Folder data |

## Catatan keamanan

Aplikasi ini bisa menjalankan perintah apa pun sebagai user yang menjalankannya. Basic Auth tanpa HTTPS
mengirim password dalam bentuk base64, jadi akses hanya dari jaringan lokal/VPN dan jangan expose ke internet.
