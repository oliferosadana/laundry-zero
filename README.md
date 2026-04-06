Laundry Zero

MVP laundry dari nol dengan Node.js, Express, EJS, dan JSON storage ringan.

Fitur:
- login admin
- dashboard
- pelanggan
- layanan
- order
- nota
- laporan + export CSV
- pengeluaran + laba rugi sederhana
- notifikasi Telegram untuk order baru dan order selesai
- reminder Telegram untuk order selesai yang belum diambil
- notifikasi WhatsApp pelanggan via GoWA untuk order baru, order selesai, dan reminder belum diambil

Menjalankan:
1. cp .env.example .env
2. npm install
3. npm start

Telegram opsional:
- isi TELEGRAM_BOT_TOKEN
- isi TELEGRAM_CHAT_ID
- atur TELEGRAM_REMINDER_DELAY_HOURS untuk jeda reminder order selesai
- atur TELEGRAM_REMINDER_INTERVAL_MINUTES untuk interval pengecekan reminder

GoWA opsional:
- isi GOWA_BASE_URL
- isi GOWA_USERNAME dan GOWA_PASSWORD untuk basic auth
- isi GOWA_DEVICE_ID jika server GoWA multi-device
- pastikan nomor pelanggan tersimpan di field phone
- atur GOWA_COUNTRY_CODE jika bukan 62
- atur GOWA_REMINDER_DELAY_HOURS untuk jeda reminder WA
- atur GOWA_REMINDER_INTERVAL_MINUTES untuk interval pengecekan reminder WA
