# ADR 0003 — PostgreSQL rezervasyon ve outbox temeli

Tarih: 2026-10-08 · Durum: Domain primitives uygulandı ve Windows gerçek PostgreSQL testleri geçti; HTTP/auth ve production Temporal entegrasyonu bekliyor.

## Karar

Kalıcı domain verisi PostgreSQL ve `pgx` 5.11.0 ile uygulanır. Görev sürümü/hash'i immutable kayıttır. Scope ancestry değiştirilemez; yeni görev/yeniden düzenleme yeni kimlikle yapılır. Rezervasyon proje ve tüm ata/leaf budget hesaplarını aynı transaction'da kontrol eder. Kullanıcı global kapasitesi ve task kapasitesi aynı lease işlemi içinde kilitlenir.

Yalnız rezervasyonu atomik yapmak yeterli değildir: lease satırı ve outbox olayı da bu transaction'a dahildir. Tekrar istek sabit request hash'iyle aynı lease'i döndürür. Durdurma isteği slotu/bütçeyi bırakmaz. Onay/expiry kayıtlarıyla server-clock aktif süre settlement yapılır; bekleme ücretsizdir. Konservatif rezervasyon %20 lease payını kapsar ve aktif süre aşımı ayrı raporlanır. Bu ölçüm abonelik tüketiminin kanıtı değildir.

Outbox alıcıya **at least once** teslim eder; aynı lease'in olayları sırayla alınır. Claim token/TTL eski worker'ı fence eder. Retry event ID'yi değiştirmez. Dispatcher gerçek Temporal SDK'sına henüz bağlı değildir ve CLI başlatma yetkisi taşımaz. Receiver deduplication, workflow start/signal uzlaştırması ve actual verification/winner transaction'ları sonraki entegrasyondadır.

## Kanıt

Windows x64'te resmi PostgreSQL motorunun 18.6 sürümü ile SQL transaction testleri çalıştırılır. Test-only binary Zonky Maven paketinden SHA-256 sabitlenerek proje içinde tutulur; production dağıtımı değildir. Testler yalnız rastgele `cg_test_*` schema'ları oluşturur/temizler. `DATABASE_URL` yerine ayrı `CG_TEST_DATABASE_URL` kullanılır.

11 gerçek PostgreSQL senaryosu ve 3 unit/guard testi: migration re-entry/immutability, bütçe ve aynı-key eşzamanlılığı, global/task kapasite, ancestor rollback, stop/expiry/settlement, versiyon geçişi, outbox hata rollback'i, delivery replay/fence/order ve paralel claim. Kayıt: `spike/results/postgres-windows-2026-10-08.json`.

## Sınırlar

HTTP development modu fixture ve kapalı kiralamada kalır. Auth/roller, heartbeat, dependency/cooldown, artifact/review/winner/puan, Temporal sink/receiver ve merkezi parasal altyapı kotaları tamamlanmadan bu primitives public mutation API'si olmaz. Aynı proje bütçe satırı yoğunluk altında ortak kilittir; throughput ve staging/backup/least-privilege kabulü bekler. CLI kimlik izolasyonu kapısı bu işten bağımsızdır.

Migration uygulanmış dosya değiştirilmez; hash uyuşmazlığı durdurur, yeni değişiklik yeni SQL dosyasıdır. Sistem schema'ları migration hedefi olamaz. Domain/checkpoint/workflow ownership ayrımı ADR 0002'yle korunur.
