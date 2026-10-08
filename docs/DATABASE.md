# PostgreSQL domain temeli

Bu katman `services/coordinator/internal/store` içindedir. Varsayılan development HTTP API fixture katalog kullanır. `authenticated` modu gerçek DB katalog/kişisel kayıtları ve mevcut lease/result/checkpoint/review metadata işlemlerini oturumdan doğrulanan kullanıcıyla bağlar; reserve/start kapalı kalır. Domain repository çağrıları güvenilir sunucu koduna aittir; bir `user_id` almak HTTP kimlik doğrulaması yerine geçmez. Hesap ve sunucu ayarları [kimlik doğrulama rehberinde](AUTHENTICATION.md).

## Çalıştırma

```powershell
npm run test:db
```

Windows x64'te bu komut proje içindeki `.tools/postgres` altında hash'i sabitlenmiş **PostgreSQL 18.6** test binary'sini kullanır. Zonky embedded-postgres-binaries Maven paketi yalnız test bağımlılığıdır; ürün installer'ına eklenmez. Test server'ı rastgele loopback portu ve her çalıştırmada yeni parola/veri diziniyle açılır, testlerden sonra kapatılır. Test parolası konsola/rapora yazılmaz. Sistem PostgreSQL kurulumu, servis kaydı veya PATH değişikliği yapılmaz.

Diğer platformlarda veya zaten ayrılmış test veritabanı varsa `CG_TEST_DATABASE_URL` verilir. **Test komutu `DATABASE_URL` kullanmaz.** Her senaryo yalnız ürettiği `cg_test_*` veya `cg_http_*` schema'sına yazar ve onu temizler. Test rolünün schema oluşturma izni olmalıdır; production veritabanı test hedefi yapılmaz. Ham loglar ve veri dizini `.local/postgres-tests/run-*` altında kalır. JSON raporu pas geçen test varsa başarılı sayılmaz.

Geliştirme için Docker kurulunca isteğe bağlı `infra/development/postgres.compose.yml` kullanılabilir; imaj PostgreSQL 18.6-bookworm digest'iyle sabitlenmiştir. `CG_DEV_POSTGRES_PASSWORD` kullanıcı tarafından yerel ortamda belirlenir. Port yalnız `127.0.0.1:54329` adresine açılır. `PGDATA` proje DB volume'undadır; kullanıcı/auth dizini bağlanmaz. Bu development tanımı production işletim veya task sandbox tanımı değildir.

```powershell
docker compose -f infra/development/postgres.compose.yml up -d
# DATABASE_URL yalnız bu geliştirme veritabanına ayarlandıktan sonra:
npm run db:migrate
```

Migrations otomatik API startup'ında çalıştırılmaz. CLI bağlantı URL'sini yazdırmaz. `db:migrate` varsayılan `commongrid` schema'sını oluşturur; `public` ve sistem schema'ları kabul edilmez. Migration transaction'ı advisory lock ile korunur, daha önce uygulanmış SQL'in SHA-256 değeri değişirse işlem durur. Yeni değişiklik yeni migration dosyasıdır; yıkıcı down komutu yoktur.

## Veri ve transaction sınırları

- Kullanıcı global eşzamanlılık limiti, proje deneme sınırı, immutable node ancestry ve proje/ata/leaf bütçe hesapları.
- Görev kimliği/node bağlantısı ve hash'e bağlı immutable `task_versions`; canlı lease, bekleyen gönderim/inceleme veya kabul edilmiş sonuç varsa yeni sürüm yayınlanamaz. Aynı sürüm/hash'in tekrar yayımlanması idempotent kalır.
- `leases`, scope bazlı `lease_budgets` ve transaction outbox. Görev/hesap kapasitesi ve aynı kullanıcı/görevde tek canlı lease birlikte kontrol edilir.
- `external_identities`, hash'i tutulan `auth_sessions` ve tek kullanımlı `oauth_flows` migration 0005 ile eklenir. AI CLI credential'ları ve sağlayıcı access/refresh/ID tokenları bu tabloların dışındadır.
- Kilit sırası: proje bütçesi → ata/leaf hesapları sabit kimlik sırasıyla → task → user → lease. Aynı projedeki rezervasyonlar ortak bütçe satırında sıralanır; throughput staging'de ölçülmelidir.
- Lease, tüm bütçe debiti ve `lease.reserved` olayı tek transaction'dadır. Outbox yazımı başarısızsa hiçbiri kalmaz. Aynı `(user, request_key)` aynı fingerprint ile aynı lease'i döndürür; farklı sözleşme/limit/görevle kullanım reddedilir.

## Kapasite muhasebesi

Birimin adı **ajan milisaniyesi**dir; token, abonelik kotası veya para değildir. Etkin ajan süre limiti görev, proje ve kullanıcının önerdiği yerel limitin minimumudur. En kötü durum rezervasyonu lease penceresinin tamamını kapsar: etkin süre + %20 teslim/durdurma payı. Bu konservatif pay yeni lease'in bütçeyi aşmasını engeller; yerel CLI süre limitini uzatmaz.

`reserved` durumda bekleme harcanmış süreye yazılmaz. Sunucunun `Start` kaydıyla aktif süre başlar. `RequestStop` rezervasyonu ve slotu bırakmaz. Durdurma onayı veya expiry sonrası, PostgreSQL saatiyle ölçülen aktif süre lease penceresinde üstten sınırlanır; kalan rezervasyon serbest bırakılır. Süre limiti üzerindeki bölüm `overrun_ms` olarak ayrı görünür. Tekrar settlement bütçeyi ikinci kez değiştirmez.

Bu kayıt gerçek model çalışmasının kanıtı değildir. Heartbeat, cihaz başlatma/durdurma kanıtı, kullanım limitleri ve native sandbox kaynak sınırları F1 entegrasyonunda uygulanacaktır. `End(completed)` yalnız denemeyi bitirir; artifact doğrulamaz, görev kabul etmez, puan vermez.

## Gönderim, inceleme ve tek kazanan

Sonuç gönderme, geçerli aktif lease ile birlikte atomik kaydedilir: sözleşme sürümü/hash'i, sahip ve base commit eşleşmeli, sunucu saatine göre süre dolmamış olmalıdır. Gönderim receipt'i, lease settlement ve outbox olayları aynı transaction'dadır. `(user_id, request_key)` tekrarında aynı fingerprint aynı kaydı döndürür; farklı artifact veya bağlam reddedilir. Lease'i önceden `End(completed)` ile kapatmak sonuç göndermek yerine geçmez.

Artifact referansı opaque kimlik, SHA-256 ve 1 byte–64 MiB boyut taşır. Migration 0006 immutable owner/lease/task/version/hash/base/strategy/purpose/scan receipt ve pending→ready kaydı ekler. Kullanıcı başına 100 kayıt / 256 MiB kapasite pending dahil, byte yazılmadan ayrılır. Public SubmitUploaded/SubmitUploadedCheckpoint ready ref'i receipt transaction'ında doğrular; legacy trusted domain metotları fixture geçmişini korur. Worker byte'ları yeniden okuyup hash/boyut/format/scanner kontrolünü tekrarlar. [ARTIFACTS.md](ARTIFACTS.md) yerel depo, retry/crash sınırlarını ve genel harness'in kalan kabulünü açıklar.

Gönderimler `submitted → verifying → verified_candidate → in_review → accepted` akışını izler; doğrulama/inceleme ret ve değişiklik isteği kaydedebilir. Verifier claim süresi ve token'ı, eski worker'ın verdict'ini reddeder; verdict artifact hash'ine bağlıdır. Bu metotlar güvenilir sunucu/verifier koduna aittir; worker bir `verified` alanı göndererek aday oluşturamaz.

İlk doğrulanmış aday görevi `awaiting_review` yapar. Diğer canlı lease'lere durdurma isteği gönderilir; kapasite ve bütçe durdurma onayına veya expiry'ye kadar tutulur. Daha önce gönderilmiş rakip sonuçlar korunur. İnsan incelemesinde kişi kendi sonucunu onaylayamaz. Proje sahibi veya kalıcı bakımcı yetkileri `maintainer`, ayrı kalıcı uygunluk grant'i `community` politikasına hizmet eder; bu grant gerçek itibar hesaplamasının yerine geçmez. Otomatik kabul yalnız Lean proof görevlerinde desteklenir.

Tek kazanan, task kilidi ve veritabanı uniqueness sınırıyla atomik seçilir. Kabul yeni lease'leri kapatır; başka bekleyen aday varken ret görevi tekrar açamaz. Kabul puan dağıtımı, merge/rebase, ana depo değişikliği veya node'un `solved` olması değildir; bunlar sonraki entegrasyon işleridir.

## Checkpoint ve devam kaynağı

Checkpoint mevcut JSON şemasından sıkı doğrulanır; duplicate JSON key, bilinmeyen alan veya yanlış task/lease/hash/base reddedilir. Gönderici yalnız kendi aktif veya durdurma istenmiş, süresi dolmamış lease'inden kayıt oluşturabilir. Handoff kapalıysa checkpoint alınmaz; hard snapshot ayrıca sözleşmede izin gerektirir. Metadata ve artifact kimliği daha sonra değiştirilemez.

Parent aynı task sürümü, hash, base ve uyumlu stratejiye bağlı kullanılabilir checkpoint olmalıdır. Sunucu tutulma süresini yedi günle sınırlar; child parent'tan daha uzun yaşayamaz. Sözleşmedeki `max_checkpoints` eşzamanlı gönderimlerde de uygulanır. Geçmiş zincir bu aşamada silinmez veya budanmaz; limit dolunca yeni kayıt reddedilir. Güvenli retention/pruning ve kullanılan parent'ların korunması ayrı iştir.

Checkpoint verifier'ı da süreli claim/token ve artifact hash'iyle sonuç yazar. Yalnız `usable`, süresi dolmamış, mevcut sözleşme/base/stratejiye uyan kayıt devam kaynağıdır. Son kayıt reddedilirse önceki kullanılabilir kayda dönülür. Bağımsız denemeler başka kullanıcının checkpoint'ini ortak başlangıca dönüştüremez; bunun için yeni görev sürümü gerekir. Sıralı görevlerde doğrulanmış handoff okunabilir.

Son canlı lease bitmiş, bekleyen aday/kazanan kalmamış ve uygun usable checkpoint varsa görev `resumable` olur. Bu durum yeni süreç veya yeni lease başlatmaz; kullanıcı devam etmeyi seçer. Sunucu metinleri güvenilmeyen bağlamdır; depoda saklanmaları secret/prompt-injection taramasının geçtiği anlamına gelmez.

## Outbox teslimatı

`internal/outbox.Dispatcher` bir teslimat arabirimidir; production Temporal istemcisi henüz bağlı değildir. Her kiralamada en eski teslim edilmemiş olay alınır; diğer kiralamalar `SKIP LOCKED` ile ilerleyebilir. Claim TTL ve token fence, eski worker'ın ACK/NACK'ini reddeder. Worker teslimden sonra ACK öncesinde ölürse **aynı event ID** yeniden teslim edilir.

Alıcı bu ID'yle deduplication yapmalıdır. Outbox exactly-once iddiası taşımaz. Payload yalnız sınırlı lease veya sonuç/checkpoint/inceleme metadata'sıdır; prompt, continuation metni, ham CLI logu, claim token veya artifact bytes içermez. Domain olayları isteğe bağlı `entity_id` ile lease aggregate sırasını korur. Bir lease birden fazla checkpoint/inceleme olayı üretebilir; eski lease lifecycle olaylarının tekilliği korunur. Hata kaydı yalnız `delivery_failed` kodudur. Claim sınırını aşan gönderim iptal edilir; retry yeni CLI başlatma veya katkı harcama izni değildir.

## Kalan işler

CommonGrid OAuth/HTTP ve development artifact vault/Trivy/verification bridge bağlandı. Gerçek OAuth/staging/native auth kabulü, itibar, dependency readiness/cooldown, puan, merge/rebase, genel Lean/yazılım harness'i, production S3/scanner isolation/GC, heartbeat/reconciliation worker, Temporal sink/deduplication, parasal altyapı kotaları ve staging/backup/retention/DB rol ayrımı bekler. Bu temeller tüm v1 akışının tamamlandığı anlamına gelmez.

Kaynaklar: [PostgreSQL row locking](https://www.postgresql.org/docs/current/explicit-locking.html), [SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html), [pgx Go sürücüsü](https://github.com/jackc/pgx), [Zonky test binary yayıncısı](https://github.com/zonkyio/embedded-postgres-binaries), [PostgreSQL 18.6](https://www.postgresql.org/docs/release/18.6/).
