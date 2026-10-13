# Kaynak paketi, yükleme ve doğrulayıcı bağlantısı

2026-10-08 · ADR 0011. Dosya teslimi temeli tamamlandı; v1 kapsamı korunur. Gerçek CLI çalıştırma, production nesne deposu ve genel Lean/yazılım harness kabulü ayrı kalır.

## Akış

İstemci izin verilen kaynakları `buildArtifactBundle` ile paketler. Güvenilir yerel scanner verilmeden paket üretilmez; scanner ve çağıran kod özel kopyalar alır. İstemci taramasının sunucuda yetkisi yoktur.

Yazılım görevi sonuç paketi (ADR 0022): `packages/agent-adapters/src/software-result.ts`, doğrulanmış diff'i sabitlenmiş başlangıç dosyasına yeniden uygulayıp tek dosyalı `result` paketi üretir; `assertSoftwareResultDeliverable` worker kapısı olarak paketi atar (artifact metin politikası aday politikasından sıkıdır: C1, U+061C, U+200E/F). Yalnız yerel metin denetimi çalışır, tarama başarısı iddia edilmez; yükleme, IPC ve arayüz yoktur çünkü lease uçları kapalıdır. Go golden: `internal/artifact/testdata/software-result-bundle.zip` (`spike/artifact-delivery/create-client-fixture.mts` üretir).

Sunucu kullanıcıyı oturumdan, görev/version/hash/lease/base/strategy bağlamını mevcut kayıtlardan bulur. Paket yapısı ve metin doğrulamasının ardından zorunlu bağımsız scanner çalışır. Eksik veya başarısız scanner kullanılabilir kayıt üretemez. İstemcinin bildirdiği dosya kimliği ya da test sonucu kabul için yeterli değildir.

Migration 0006 depolama kotasını byte yazılmadan `pending` kayıtla ayırır. Vault dosyayı sync edip hash/boyut kontrolünü bitirince kayıt `ready` olur. Public sonuç/checkpoint, aynı transaction içinde ready kayıt, sahip, lease, amaç, görev bağlamı ve digest/boyut kontrolü yapar. Exact retry aynı kayıtla devam eder; bağlam değişirse conflict. Pending dahil kullanıcı başına 100 retained kayıt / 256 MiB sınırı vardır. Bir süreçte en çok dört upload, upload başına 30 saniye uygulanır; byte limiti gövde okunurken denetlenir. Production rate-limit ve parasal maliyet modeli ayrı kalır.

`verification.Worker` immutable kaydı receipt üzerinden çözer. Sabit sunucu harness'i bulunmadan claim almaz; byte'ları depodan yeniden okur, SHA-256/boyutu bağımsız hesaplar, paket ve scanner kontrollerini tekrarlar. Scanner'ın değiştirebileceği inspection kopyası harness'e verilmez. Kontrol edilen hash, süreli claim ve verdict eşleşmeden karar yazılmaz. Resolver yalnız trusted profil/base/imaj eşlemesi seçer; task JSON'undaki komut veya istemci pass raporu çalıştırılmaz. Depo/scanner/harness hatası test sonucu diye kaydedilmez; claim süresi dolunca tekrar denenebilir.

## cg-artifact/1

| Alan | Kural |
|---|---|
| Taşıma | Deterministik, sıkıştırılmamış STORE ZIP; manifest önce, kaynaklar sıralı |
| Manifest | format, purpose, task_id/version/hash, lease_id, base_commit, strategy_id, files(path/sha256/size_bytes); exact alanlar, duplicate/eksik/unknown reddi |
| Limit | Arşiv 64 MiB, manifest 64 KiB, 1–256 dosya, dosya başına 4 MiB |
| Yollar | Exact writable_paths; ASCII harf/rakam ve `_ . / -`, en çok 512 byte; glob/dizin genişlemesi yok |
| İzinler | Absolute/traversal, Windows aliases, case/ancestor çakışması, credential paths, link/executable/special dosya reddi |
| ZIP | Compression, descriptor, ZIP64, extra/comment, prefix/suffix/gap, çelişen local/central içerik reddi |
| Kaynak | UTF-8; binary, TAB/LF/CR dışındaki C0/C1 control, bidi, bilinen credential biçimleri ve yasak literal metin reddi |
| Checkpoint | Kaynak snapshot'ı yalnız hard; handoff ve allow_workspace_snapshot açık olmalı |

`Encode` test/araç üreticisidir; scanner veya yol yetkisi vermez. TS üretici ile Go parser ortak golden ZIP/binding/task fixture'ı kullanır. Soft checkpoint için ayrı untrusted metin/context formatı, binary varlık, diff/delete ve genel repository importer sonraki entegrasyonlardır; ürün kapsamından çıkarılmadı.

## API

| Uç | Davranış |
|---|---|
| POST /api/v1/leases/{id}/artifacts?purpose=result veya checkpoint&request_key=id | Auth + exact Host/Origin + CSRF; Content-Type: application/vnd.commongrid.artifact+zip; byte gövde; item: id/sha256/size_bytes |
| GET /api/v1/artifacts/{id} | Yalnız sahip; ref/purpose/state/created_at; byte/yol/indirme bağlantısı yok |
| POST /api/v1/leases/{id}/result | Ready result ref; mevcut atomik receipt/lease completion |
| POST /api/v1/leases/{id}/checkpoint | Ready checkpoint ref + hard metadata; metadata digest'i ref ile aynı |

Upload request_key kullanıcı genelinde benzersizdir. Dosya ID'sini sunucu deterministik opaque kimlik olarak üretir. Başkasının kaydı veya yanlış purpose/digest/size kullanılamaz. Exact retry kapalı lease sonrası kaydedilmiş receipt'i döndürebilir; yeni geç yükleme kabul edilmez.

## Yerel kurulum

```powershell
npm run install:trivy
npm run test:artifacts
# AUTHENTICATION.md'deki authenticated DB/origin/provider ayarlarına ek:
$env:CG_ARTIFACT_ROOT = Join-Path (Get-Location) '.local/coordinator-artifacts'
$env:CG_TRIVY_BINARY = Join-Path (Get-Location) '.tools/trivy/trivy.exe'
$trivyPin = Get-Content .tools/trivy/installed.json | ConvertFrom-Json
$env:CG_TRIVY_SHA256 = $trivyPin.binary_sha256
$env:CG_ALLOW_LOOPBACK_AUTH = 'true'
npm run dev:api
```

Root mutlak, sunucuya özel ve üreticinin workspace'inden ayrı olmalıdır. Scanner scratch `.scanner` altındadır. Yerel vault/scanner yalnız açık development modunda açılır; production bu adaptörü reddeder. Ayar yoksa upload/result/checkpoint 503 ile kapalıdır; metadata-only veya baseline-only geçiş yoktur. Fixture modu bu ayarlarla hesap/çalıştırma açmaz.

Trivy 0.75.0 resmi arşivleri SHA-256 ile sabitlenmiştir: `spike/artifact-delivery/trivy.lock.json`. Installer yalnız binary'yi `.tools/trivy` içine çıkarır; Windows binary hash'i de sabittir. Doğru hash'li mevcut binary kullanımdayken üstüne yazılmaz. Sistem PATH ve CLI auth dosyaları değiştirilmez. Linux/macOS pinleri kaydedildi; yalnız Windows yerel kabulü çalıştırıldı.

Scanner her çağrıdan önce binary hash'ini kontrol eder. 20 saniye, yalnız secret taraması, offline/update/telemetry kapatma ve private home kullanır. Host provider tokenı/proxy/PATH/TRIVY_* ayarları child'a aktarılmaz. Source, server-generated nötr .txt adlarıyla; trusted config altında default path/example allowlist ve skipping kapatılarak taranır. Source scanner config/ignore olarak yüklenmez. Stdout/stderr 1 MiB sınırındadır ve API/log/outbox'a taşınmaz; hatalar sabittir. Offline bayrakları OS ağ sandbox'ı değildir; production scanner ayrı OS/konteyner izolasyonu gerektirir. Tarama bilinmeyen/gizlenmiş her sırrı bulacağı iddiası taşımaz.

Vault os.Root containment, regular-file/reparse/hardlink kontrolleri, Unix 0700/0600, exclusive temp, byte fsync ve atomik publish kullanır. Mevcut nesne üstüne yazılmaz; exact retry tekrar doğrulanır. Windows izinleri ayrı OS kimliği sandbox'ı değildir; directory fsync desteklenmez. Publish ile temp unlink arasında crash, nesneyi iki link nedeniyle fail-closed bırakabilir. Startup en az bir saat eski temp'leri, en çok 128 isimde temizler. Pending kota kendiliğinden silinmez; exact retry tamamlayabilir. Production S3/retention/GC/crash kabulü bekler.

## Test ve kalan işler

`npm run check`: tip/şema/test/build. `npm run test:artifacts`: gerçek pinned Trivy + paket/vault/worker kontrolleri. Baseline'ın görmediği sentetik Stripe biçimli anahtar bağımsız taramada reddedilir; gerçek anahtar/hesap kullanılmaz. Windows file-symlink yetkisi yoksa yalnız adı raporlanan bu test platform açığı olarak kaydedilir; actual junction/reparse testi ayrıca zorunludur. Gerçek scanner testi veya başka skip başarı sayılmaz.

Gerçek DB zinciri için CG_TEST_TRIVY_BINARY, CG_TEST_TRIVY_SHA256 ve CG_REQUIRE_TRIVY_TESTS=1 ile `npm run test:db` çalıştırılır. HTTP upload → gerçek vault bytes → Trivy → immutable ready record → sonuç/hard checkpoint → trusted fixture harness sınanır. Harness sabit kaynak byte'larını kontrol eder; Lean compiler/genel yazılım runner'ı değildir. OAuth identity exchange fixture'dır.

Public raporlar `spike/results/artifact-*-windows-2026-10-08.json`; ham ve başarısız denemeler .local altında korunur. UI/native, Temporal, gerçek OAuth, diğer OS ve AI hesapları bu aşamada yeniden sınanmadı. Reserve/start ve desktop execution kapalı, isolation_gate=not_evaluated. Sonraki uygulama: pinned orijinal repository üzerinde bağımsız yazılım/Lean harness'i, production scanner isolation/S3, güvenli soft context ve istemci upload akışı.

Kaynaklar: [Trivy release](https://github.com/aquasecurity/trivy/releases/tag/v0.75.0), [pinned secret scanner](https://github.com/aquasecurity/trivy/blob/v0.75.0/pkg/fanal/secret/scanner.go), [CLI seçenekleri](https://trivy.dev/docs/latest/guide/references/configuration/cli/trivy_filesystem/), [Go os.Root](https://pkg.go.dev/os#Root), [Go archive/zip](https://pkg.go.dev/archive/zip).
