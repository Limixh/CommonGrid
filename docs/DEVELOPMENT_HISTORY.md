# Geliştirme kaydı

2026-10-08 · Faz 0 devam ediyor. Nihai v1.0 kapsamı `PROJECT_SPEC1.2.md` ve `implementation_roadmap1.3.md` ile korunuyor.

## İlk uygulama

- [x] npm monorepo; Go koordinatör ve Tauri/React masaüstü temeli.
- [x] Görev, execution context, checkpoint, plan önerisi şeması ve Go/TypeScript tip üretimi.
- [x] İki dilde görev doğrulaması ve JCS/SHA-256 sözleşme kontrolü; ortak hata senaryoları.
- [x] Yerel API'den örnek proje/görev yükleme, filtreleme, görev/strateji/sözleşme inceleme.
- [x] Cihazda saklanan katkı tercihleri; Türkçe/İngilizce arayüz.
- [x] CLI/araç algılama; task konteyner tanımı; Codex JSONL normalizasyonu.
- [x] Açık kaynak tercihleri spec/yol haritasına işlendi; Temporal fixture modülü ve gerçek Windows recovery denemesi.
- [x] Sabit Codex/SWE-ReX kaynak hash'leri ve kimlik okumayan version/help/engine araştırması.
- [x] PostgreSQL migration altyapısı, kalıcı kiralama/bütçe kayıtları ve transaction outbox temeli.
- [ ] Temporal staging işletim/maliyet kabulü, production sink/receiver deduplication ve workflow entegrasyonu.
- [x] Dar gerçek CLI/auth görev kanıtı, task-tools ve sentetik saldırı paketleri; tam fizibilite kabulü aşağıdaki açık kapılarda izlenir.
- [x] Claude native kurulum algılama; gerçek Docker Linux/WSL2 task-tools fixture saldırı paketi.
- [x] İki resmi CLI ile yerel model fixture + task tool yönlendirmesi, sahte auth/control sınırı ve ayrı native Windows abonelik bağlantısı.
- [x] Private managed-session/cache/stdio provider egress adayı; 16 önceki boundary kontrolü, iki gerçek görev/diff ve bağımsız verifier.
- [x] Sentetik malicious-task/control/lifecycle/artifact güçlendirmesi; ADR 0007, genel test ve Docker CI komutları.
- [x] İşlem kimliği/immutable Docker ID, sentetik oturum sürekliliği, import-safe resmi oturum/kota yardımcıları ve bounded kabul/checkpoint runner'ı; ADR 0008.
- [ ] Claude doğal expiry/refresh/relogin, gerçek kota/eşzamanlılık, tüm provider araç yolları, genel artifact importer/scanner ve üç platform fizibilite kabulü.
- [ ] GO / GO WITH LIMITATION.
- [x] Submissions/checkpoints/reviews/winner kalıcı domain temeli; ADR 0009 ve gerçek PostgreSQL kabulü.
- [x] CommonGrid GitHub/Google hesap ve oturum temeli; kişisel katkı ekranı, kimlik doğrulamalı DB API bağlantısı — ADR 0010.
- [x] Kaynak paketi, authenticated upload, immutable artifact registry/private vault, gerçek Trivy ve hash'e bağlı doğrulayıcı köprüsü — ADR 0011.
- [ ] Gerçek OAuth uygulama/staging ve native paket auth dönüşü kabulü; gerçek artifact doğrulayıcısı, puan/merge, maliyet modeli ve Lean benchmark görevleri.

Şema doğrulaması Lean bağlantı ispatını, mevcut proje grafiğinin doğruluğunu veya gerçek artifact içeriğini doğrulamaz. Bunlar temiz sunucu doğrulayıcısında yapılacaktır. Görev çalıştırma ve kiralama kapalıdır; ilk UI testleri fixture kaynaklıdır.

## Dosya teslimi ve doğrulayıcı bağlantısı — ADR 0011

Üç Sol 6.1/high alt ajan bundle formatı, HTTP upload ve DB/vault işlerini yürüttü; ana ajan TypeScript üretici, immutable byte doğrulayıcı köprüsü, gerçek Trivy adaptörü/kurulumu, startup, entegrasyon ve raporları bağladı. Ana ajan dahil dört eşzamanlı ajan sınırı korundu. Alt ajan kullanım limiti sonrası kalan test/inceleme ana ajanla tamamlandı. Gerçek AI hesabı/model inference kullanılmadı.

Append-only migration 0006 pending kota rezervasyonu ve immutable ready artifact ekler. Upload ownership/binding/header/size/scan sınırları, atomic metadata authority, private os.Root vault, exact retry, bounded scratch/output ve kaynak envanteri kontrolü uygulandı. TS→Go golden fixture doğrulandı. Worker gerçek byte'ları yeniden okuyup hash/size/format/scanner kontrolü yapar; fixed trusted harness bulunmadan claim veya verdict açmaz. ServerCommand/istemci pass flag çalıştırılmaz.

Yerel kabul: **112 PostgreSQL/HTTP kontrolü**, sıfır failure/skip; HTTP binary upload→vault→gerçek pinned Trivy→hard checkpoint/result→trusted fixture harness zinciri dahil. **115 artifact/verifier kontrolü** geçti; file-symlink yetkisi olmadığı için bir Windows kontrolü adıyla raporlandı, actual junction/reparse testi geçti. Trivy bağımsız sentetik secret reddi, suppression/config/env izolasyonu ve cleanup kabulü gerçek executable ile sınandı. Genel kontrol **174 Node testi (13+161)**, generated/typecheck, Go testleri ve frontend/Go build ile geçti; vet ayrıca çalıştırıldı. Bu sayılar alt testleri de içerir.

Kontroller, scanner'ın regular executable yolunu parent directory'den denetleme düzeltmesini ve io.Copy'nin embedded Buffer.ReadFrom ile output limitini atlamaması için private buffer düzeltmesini doğurdu. İlk artifact acceptance raporu Windows symlink skip nedeniyle başarısızdı; yalnız bu bilinen platform boşluğu açıkça raporlanan runner politikasıyla ayrıldı ve junction testi eklendi. Binary installer için mevcut doğru pin'i yeniden yazmama davranışı eklendi. Başarısız/ara ham denemeler .local içinde korunur.

Kanıtlar: `artifact-delivery-windows-2026-10-08.json`, `artifact-postgres-windows-2026-10-08.json`, `artifact-foundations-windows-2026-10-08.json`. Kurulum/sınırlar [ARTIFACTS.md](ARTIFACTS.md), karar ADR 0011 içindedir. Genel Lean/yazılım harness'i, production scanner OS isolation/S3/GC, soft context/binary/diff importer, istemci upload UI ve workflow wiring bekler. UI/native/Temporal/gerçek OAuth/diğer OS/uzak CI yeniden sınanmadı. execution_enabled=false ve isolation_gate=not_evaluated; v1 kapsamı korunur.

## CommonGrid hesabı, katkılar ve API — ADR 0010

Üç Sol 6.1/high alt ajan OAuth/OIDC, HTTP yetkilendirme ve arayüz işlerini yürüttü; ana ajan migration 0005, kalıcı hesap/session/read modelleri, startup, gerçek DB zincir testi ve son entegrasyonu birleştirdi. Ana ajan dahil en fazla dört eşzamanlı ajan kullanıldı. GitHub/Google platform hesabı resmi Claude/Codex abonelik oturumundan ayrıdır; bu aşamada gerçek hesap/model/Docker çağrısı yapılmadı.

Kalıcı kimlik provider subject ile eşleşir; aynı isim farklı hesapları birleştirmez. Browser/provider bağlı state tek kullanımlı ve on dakika, opaque session hash'i veritabanında ve en fazla 24 saat tutulur. PKCE, Google imza/issuer/audience/nonce/azp, oturum rotation/logout, HTTPS Secure/HttpOnly çerez ve Origin/CSRF sınırı eklendi. Provider/body/credential belirsizliği ve DB outage güvenli hata döndürür. Çerez/proxy uyumu için aynı scheme/hostname, üretimde aynı origin ve geliştirmede açık loopback port istisnası uygulanır.

`authenticated` modu kişisel lease/submission/checkpoint listelerini, güncel DB kataloğunu, domain kurallarıyla stop/end/result/checkpoint/review metadata yazmalarını bağlar. Kullanıcı kimliği gövdeden alınmaz. HTTP verifier/grant metodu sunmaz; reserve/start her zaman kapalıdır. `/end completed` kabul edilmez: sonucu ve lease kapanışını birlikte kaydeden `/result` kullanılır. Varsayılan fixture modu anonimdir ve sahte giriş açmaz. Startup migration uygulamaz, mevcut ad/hash tarihini salt okunur doğrular.

Türkçe/İngilizce hesap ve katkı ekranı, sağlayıcı readiness, hata/expiry/loading/başarısız logout ayrımını gösterir. Oturum sona erdiğinde private katalog ve receipt verileri temizlenir; gecikmiş cevap eski veriyi geri getiremez. CSRF yalnız arayüz belleğindedir. 1440 ve 390 px hesap/katkı ekranları görsel olarak incelendi; yatay taşma veya örtüşme görülmedi.

Son kabul: **PostgreSQL 18.6 + HTTP paketinde 77 adlandırılmış kontrol**, sıfır failure/skip; sayı alt testler ve saf guard/HTTP kontrollerini de içerir. Gerçek durable OAuth flow/session/identity yarışları ve HTTP üzerinden checkpoint/result/review/ownership/logout zinciri sınandı. Provider değişimi fixture'dır. **12 tarayıcı testi** (8 mock hesap + 4 mevcut fixture API çalışma alanı) geçti. **169 Node testi (13 + 156)**, generated/typecheck, Go testleri/vet ve frontend/Go build geçti. Genel Go koşusunda DB senaryoları ayrı bırakılır; bunlar dedicated DB koşusunda sıfır skip ile çalıştırıldı.

Kanıtlar `spike/results/account-api-postgres-windows-2026-10-08.json`, `account-api-foundations-windows-2026-10-08.json`, `account-ui-windows-2026-10-08.json`; son DB ham koşusu `.local/postgres-tests/run-1791469841520-19696`, genel kontrol `.local/validation/account-api-2026-10-08` içindedir. İlk DB testinde hex dışı sentetik token hash'i ve önceden derlenen credential-error davranışı, ilk UI testinde test-loader uyumsuzluğu düzeltildi; ara koşular korunur. Yeni CI paketleri mevcut DB/UI job'larıyla çalışır; uzak CI bu aşamada çalıştırılmadı.

Kurulum/adres/çerez ve endpoint sözleşmesi `docs/AUTHENTICATION.md`, karar ADR 0010 içindedir. Gerçek OAuth uygulama/staging girişi ve native paket auth dönüşü, production auth rate-limit/retention/DB rol ayrımı, artifact importer/scanner/verifier ve review workspace, puan/merge/workflow hâlâ bekler. Sonraki uygulama hedefi gerçek artifact teslimini bağımsız doğrulayıcıya bağlayan güvenli dosya paketleme/depolama sınırıdır. Tam v1 kapsamı, `execution_enabled=false` ve `isolation_gate=not_evaluated` korunur.

## Kalıcı sonuç ve devam akışı — ADR 0009

Üç Sol 6.1/high alt ajanla sonuç/inceleme, checkpoint ve bağımsız inceleme ayrıldı; ana ajan ortak transaction/outbox sınırını ve gerçek DB kabulünü birleştirdi. Append-only migrations 0002–0004; immutable receipt, kullanıcı/lease/version/hash/base ve artifact binding, süreli verifier claim/token, kalıcı review grant ve atomik tek kazanan eklendi. Kendi sonucunu onaylama ve iptal edilmiş yetkiyle quorum tamamlama reddedilir. İlk aday güvenli stop isteği gönderir; lease settlement ancak acknowledgment veya expiry'de kapasite bırakır. Bekleyen/kabul edilmiş sonuç yeni task sürümünü engeller.

Checkpoint yalnız sunucunun `usable` verdict'inden sonra seçilir. Strateji ve ancestry korunur, reddedilmiş/süresi dolmuş son kayıt önceki kullanılabilir kayda düşer. Bağımsız denemelerin checkpoint gizliliği, daha sonra görev modu değişse de tarihli immutable sözleşmeye bağlıdır. Review changes sonrası uygun checkpoint görevi `resumable` yapar; yeni lease/süreç kendiliğinden açılmaz. Gerçek scanner/verifier/S3 uygulaması, OAuth/HTTP ve puan/merge entegrasyonu ayrı kalır.

Son yerel kabul: **PostgreSQL 18.6 paketinde 44 adlandırılmış kontrol**, sıfır failure ve skip; bunun içinde 36 üst seviye DB senaryosu, 3 handoff alt senaryosu ve 5 guard/unit kontrolü vardır. Mevcut 0001 üzerine kayıtlı lease/outbox upgrade, idempotency, stale claim/hash, tek kazanan yarışı, grant revocation, rollback, expiry/privacy/parent/strateji ve açık kullanıcı seçimli checkpoint devamı sınandı. Rapor `spike/results/domain-postgres-windows-2026-10-08.json`; ham kayıt `.local/postgres-tests/run-1791467742656-12608` içinde.

`npm run check` **169 Node testi (13 + 156)**, Go contract/API/store testleri, generated/typecheck ve frontend/Go build ile geçti. Rapor `spike/results/domain-foundations-windows-2026-10-08.json`; ham log `.local/validation/d2634caf-5ebd-482d-a550-00509df333ab` içinde. Veritabanı testleri ayrı gerçek koşuda kabul edildi; bu aşamada model/account çağrısı yoktur. UI/native release, Temporal ve uzak CI tekrar çalıştırılmadı. CI mevcut PostgreSQL job'ında yeni testleri ve public report upload'ını kullanır.

## Test bulguları → değişiklik

| Bulgu | Değişiklik |
|---|---|
| JSON Schema dizilerinden üretilen sınırlı tuple birleşimleri `includes` tipini `never` yapıyor | Tip üretiminde min/max tuple çıkarımı kapatıldı; runtime dizi sınırları schema ile korunuyor |
| Go regexp ile uyumsuz lookahead kullanımı | Ortak pozitif yol deseni + iki dilde açık yol semantiği |
| İlk sabitlenmiş Ajv sürümünde bilinen ReDoS bildirimi | Ajv 8.20.0'a güncellendi |
| Geliştirme proxy'sinin Host başlığı API loopback kontrolüyle uyumsuz | Proxy hedefi için `changeOrigin` açık; API'de geniş CORS izni verilmedi |
| C: diskinin boş alanı test tarayıcısı indirmesi için yetersiz | Test tarayıcısı ve geçici dosyalar proje içindeki `.tools` altında tutuluyor |
| Vite hazır olduğunda soğuk Go derlemesi henüz bitmemiş olabiliyor | Birlikte geliştirme komutu UI sunucusunu API health kontrolünden sonra açıyor |
| 780 px ekranda dekoratif yörünge 12 px yatay taşma oluşturuyor | Grafik kendi sınırlarında kırpıldı; dar ekran testi geçti |

## Doğrulama — Windows x64

- `npm run check`: geçti; üretilmiş dosyalar güncel, TypeScript kontrolü, 49 Node testi, Go sözleşme/API testleri ve web/Go derlemeleri başarılı.
- `npm run test:ui`: 4/4 geçti. Gerçek loopback API ile görev/JSON/filtre, katkı tercihi, dil/API hata durumu ve 780 px ekran.
- `npm audit --omit=dev --audit-level=moderate`: bilinen açık bulunmadı.
- `npm run doctor`: Codex 0.157.1, Go 1.27.1 ve Cargo 1.99.0 algılandı; Claude, Docker ve Podman bulunamadı. İzolasyon `not_evaluated`.
- `node scripts/native.mjs build --no-bundle`: Windows x64 release derlemesi geçti. `.exe` üretildi; imzalı kurulum paketi veya dağıtım sürümü değildir. macOS/Linux CI tanımlı, henüz çalıştırılmadı.

Başlangıçta Docker/Podman ve Claude bulunamadı; Docker ve native Claude sonradan kuruldu. Aşağıdaki tarihli ek kayıtlar güncel durumu verir. Sonraki bağımlı kabul, gerçek sandbox kodlama/diff'i ile resmi auth kimlik ayrımı ve yenileme testidir; bağımsız temeller bu kapı beklenirken ilerleyebilir.

## Açık kaynak seçimi ve F0 denemeleri — 2026-10-08

Kabul edilen tercihler `PROJECT_SPEC1.2.md` §7.5/§14 ve yol haritasına işlendi. Temporal kalıcı sunucu iş akışları için seçildi; domain/bütçe/puan PostgreSQL'de kalır, teslimat transaction outbox'ıyla bağlanır. Cosign, Trivy, OpenTelemetry ve IDE bileşenlerinin fazları netleştirildi. v1 kapsamı korunuyor; henüz işletim maliyeti veya takvim kazancı ölçülmedi.

- `npm run test:spike`: altı Temporal SDK testi geçti.
- `npm run spike:recovery`: gerçek Windows x64 worker ve SQLite development server kesintisi, checkpoint replay, eski hash reddi, yan etki sonrası retry, tek fixture effect, deadline ve iptal geçti. CLI 1.9.1 / server 1.32.0, SDK 1.49.0. Production HA veya gerçek doğrulama kanıtı değildir.
- `npm run spike:routing`: altı sabit kaynak SHA-256 kontrolü geçti; Codex 0.157.1 help/version var, Docker/Podman/Claude yok. SWE-ReX kaynak denemesi canlı runtime/kimlik izolasyonu sayılmaz; `not_evaluated` korunuyor.
- `npm run check`: 49 Node testi, Go şema/API testleri, tip/üretim kontrolü ve frontend/Go derlemesi geçti.
- Spike Go vet ve yeni Node script syntax kontrolleri geçti. Üç platform Temporal fixture CI işi eklendi; uzak CI henüz çalıştırılmadı. UI/native kodu bu değişiklikte değişmedi.

Bulgu → karar: Codex shell kapatma ve patch araç kaydı ayrıdır; kaldırılmış `apply_patch_freeform` flag'ine dayanan yönlendirme tasarımı yapılmayacak. Tüm araç yolları ve CLI/auth OS sınırı gerçek saldırı paketinde ayrı sınanacak. Temporal testinde Activity hata vermeden önce effect yazabileceği gösterildi; üretimde sabit idempotency anahtarı, transaction ve Job uzlaştırması zorunlu.

Tekrar çalıştırılabilir komutlar `spike/temporal/README.md` ve `spike/cli-routing/README.md`; karar ve kalan kapılar `spike/adr/0002-open-source-and-workflows.md` içinde.

## PostgreSQL / rezervasyon / outbox — 2026-10-08

Docker/Claude kurulumu sürerken bağımsız domain temeli geliştirildi. `pgx` 5.11.0 ile hash'i kontrol edilen, transaction/advisory lock kullanan embedded SQL migration; kullanıcı global eşzamanlılığı, immutable task version/node ancestry, proje/ata/leaf bütçeleri ve kiralamalar eklendi. API hâlâ fixture kullanıyor; HTTP yazma/gerçek ajan kapısı açılmadı.

- Rezervasyon tüm scope'larda ve `lease.reserved` outbox kaydıyla atomik. Aynı kullanıcı/request key'in farklı payload'la kullanımı reddedilir; aynı payload tek lease'e döner.
- Başlatılmamış süre harcamaya yazılmaz. Etkin süre + %20 lease payı konservatif rezerve edilir. Stop isteği rezervasyonu/slotu korur; onay/expiry sonrası PostgreSQL saatinden hesaplanan süre settlement ile yazılır. Overrun ayrı kaydedilir; tekrar settlement çift debit üretmez.
- Outbox bir lease'in olaylarını sırayla, farklı lease'leri `SKIP LOCKED` ile alır. Claim token/TTL fence eski worker'ın ACK/NACK'ini reddeder; yeniden teslim aynı event ID'yi korur. Production Temporal sink ve receiver deduplication henüz bağlı değildir.
- Windows portable PostgreSQL 18.6 test paketi SHA-256 ile sabitlendi; proje dışında kurulum/PATH/servis değişikliği yapılmadı. İlk pg_ctl başlatıcısında inherited pipe nedeniyle timeout görüldü; regular log dosyasıyla düzeltildi, yalnız denemeye ait test server'ı kapatılıp test tekrarlandı.
- Gerçek DB paketinde 11 PostgreSQL senaryosu + 3 unit/guard testi bulunur: 40 paralel bütçe isteği, ata bütçesinde rollback, 16 aynı-key yarışı, task/global kapasite, stop/expiry/settlement, sözleşme versiyonu, zorlanmış outbox insert hatası, replay/fencing/order ve 12 paralel claim. Son başarılı rapor `spike/results/postgres-windows-2026-10-08.json` içindedir; DB testlerinin hiçbiri pas geçilmez.
- Ayrı PostgreSQL CI işi ve digest'i sabitlenmiş development Compose tanımı eklendi. Uzak CI/staging doğrulanmış sayılmaz.
- Son doğrulama: `npm run test:db` 14/14, sıfır skip; `npm run check` 49 Node testi, Go testleri, tip/üretim kontrolü ve frontend/Go build; `go vet ./...` geçti. Owned test PostgreSQL sunucusu kapanışta durduruldu.

Komutlar ve production için kalan sınırlar: `docs/DATABASE.md`. `npm run check` normal geliştirme ortamında DB entegrasyonlarını açıkça skip eder; `npm run test:db` dedicated DB veya geçici portable server ile bunları zorunlu çalıştırır. UI/native kodu değişmedi.

## Docker / Claude kurulumu sonrası — 2026-10-08

- Claude Code native 2.1.293; Docker CLI/engine 29.8.2, Desktop 4.94.0 ve Linux/WSL2 engine erişimi doğrulandı. Native Claude yeni `.local/bin` konumundaydı; açık uygulamanın eski process PATH'ine bağımlı algılama düzeltildi. Host ortamı/PATH değiştirilmedi.
- Read-only probe helper'ı CLI model çağrısı ve engine mutation kabul etmez; native binary argv ile, npm shim yalnız kapalı version/help listesiyle çalışır. Dört regression testi var.
- Sadece fixture başlatıcısına bağlı `TaskToolsRuntime`: immutable image, opaque workspace, non-root UID, network-off, read-only rootfs, capability/seccomp/CPU/RAM/PID sınırları, command deadline/abort/output bound ve sahiplik doğrulanan cleanup.
- İlk canlı yazma testinde Docker volume copy-up workspace sahipliğini root'a çevirdi. `volume-nocopy` eklendi; UID 65532 ile çalışma alanına yazma ve rootfs reddi tekrar doğrulandı.
- Gerçek Docker denemesinde 12/12 kontrol geçti: cgroup sınırları, canary/host/auth/socket/traversal/symlink ve `/proc` erişimi, ağ çıkışı, tmpfs/namespace, PID exhaustion, fresh attempt, detached child timeout, cancellation ve output overflow. Owned konteyner/volume'lerin temizlendiği doğrulandı.
- Güncel routing raporunda altı pinned source hash'i ve iki CLI help/version başarılı; model/hesap çağrısı yapılmadı. Ubuntu fixture CI işi eklendi, uzak CI çalıştırılmadı.
- Resmi CLI/auth OS kimliği, tüm built-in/MCP/plugin yolları, control-channel authorization, token yenileme, gerçek diff ve sağlayıcı uyumluluğu hâlâ kabul kapısıdır. Sandbox sonucu fixture task-tools sınırıyla sınırlıdır; API/masaüstü execution gate açılmadı.

Tekrar komutları ve sınırlar: `spike/sandbox/README.md`; son canlı kanıt `spike/results/sandbox-windows-2026-10-08.json`.

Son genel doğrulama: `npm run check` geçti; 4 yeni tool-probe testi + 49 mevcut Node testi, Go testleri, generated/typecheck ve frontend/Go derlemeleri başarılı. PostgreSQL, Temporal, Playwright ve native paket testleri bu değişiklikte yeniden çalıştırılmadı; önceki kanıtları korunur. Koordinatör fixture/execution gate testi genel Go paketinde geçti.

## İki resmi CLI / gerçek abonelik bağlantısı — 2026-10-08

- Resmi Codex 0.157.1 Linux arşivi ve ikilisi SHA-256; Claude 2.1.293 Linux ikilisi SHA-256 + signed manifest GPG signer pin'iyle doğrulandı. Kurulum/cache/keyring proje içinde; global kurulum ve kullanıcı auth dosyası kopyalama yok. Windows download OS trust store'u kullanır; TLS kontrolü kapatılmaz.
- `spike:cli-session`: Docker Linux/WSL2 üzerinde ayrı CLI/task namespace'lerinde toplam 20/20 kontrol ve cleanup geçti. Claude built-in-off strict MCP; Codex experimental empty environment + dynamic tool. Gerçek binary değiştirilmeden çalıştı; wire model yanıtları yerel SSE fixture'dır. Hem task roundtrip/dosya hem sahte auth/control ve broker authorization sınandı.
- İki sağlayıcı aynı kapalı `task_exec` sözleşmesine bağlı. Argümanlarla host executable/container/cwd/env/attempt seçilemez. Task `argv` host shell'e ulaşmaz. Completion yalnız protokol olayından çıkarılmaz; dosya ve başarılı task-tool sonucu da kontrol edilir.
- Codex yeni model profilindeki `additional_tools` alanı ilk envanterin eksik olduğunu gösterdi. Denetim iki wire alanını tarar; fixture için code mode/multi-agent/v2/goals/async kullanıcı araçları daraltıldı. Başarılı fixture profili `gpt-5.1-codex`; diğer modellerin araç kapsamına genellenmez. App-server thread Rust kaynağı hash lock'a eklendi; read-only routing 7/7 geçti.
- Windows Buildx child process'i timeout'ta inherited pipe tuttu. Ortak trusted launcher owned process tree/group'u durdurup deadline'da hemen reddeder; gerçek child ile regression testi geçti. Read-only rootfs'e Docker cp yapılamadığı için public binary stdin üzerinden private tmpfs'e aktarılır; binary tmpfs explicit exec, task tmpfs noexec kalır.
- Bir tekrarda 20 araç kontrolü geçti, cleanup teyidi başarısız döndü; sonraki engine sorgusunda kaynak kalmadığı görüldü. İlk rapor başarısız olarak korunur. CLI cleanup idempotent sahiplik kontrolü ve bounded absence sorgusuyla uzlaştırılır; owner mismatch silinmez, daemon erişimsizliği başarı sayılmaz. Daha önce kapanmış task runtime'ın tekrar kapatılması kaldırıldı.
- `spike:account-smoke`: ayrı native Windows resmi CLI süreçleri Claude.ai Pro ve ChatGPT oturumuyla sabit `CG_OK` yanıtı aldı. API key/provider env seçenekleri temizlendi; API fallback yok. Claude built-in/MCP kapalı, Codex environments/dynamicTools boş; kodlama görevi verilmedi. Codex resmi `model/list` listesinden seçilen `gpt-6-astra` ile geçti. Kayıtlı modelle kalan ilk deneme başarısızdı; ham provider hatası tutulmadığı için kesin kök neden çıkarılmaz. Bu smoke OS kimlik izolasyonu veya sandbox gerçek görev/diff kanıtı değildir.
- Raporlar canary/token/e-posta/auth/account ID/ham provider çıktısı içermez. Ubuntu official CLI fixture CI işi tanımlı; gerçek hesap smoke'u CI'a bağlanmaz. Uzak CI çalıştırılmadı. UI/HTTP execution gate ve tam izolasyon kararı kapalı kalır.
- Host Windows 11 x64; Docker WSL2 engine `6.6.87.2`, ~5.7 GiB engine memory. Debian Bookworm Slim + Node 22 base image 311 MiB. Public CLI ikilileri ek olarak ~241/272 MiB'dır. Cgroup RAM, CLI tmpfs binary/cache ve fixture süreçlerini de içerir. Startup/turn/memory raporu bir warm-image yerel gözlemdir; gerçek inference, production kapasitesi veya OS benchmark'ı değildir.

Son doğrulama: `npm run check` 61 Node testi (5 script + 56 package), Go testleri, generated/typecheck ve frontend/Go build; `spike:sandbox` 12/12, `spike:cli-session` 20/20, native `spike:account-smoke` iki bağlantı ve `spike:routing` 7/7 kaynak kontrolü. PostgreSQL/Temporal/Playwright/native release tekrar çalıştırılmadı; bu katmanlar değişmedi. Son raw test raporları `.local`, yayımlanan kapsamlı kayıtlar `spike/results` altındadır.

Karar ve kalan kabul işleri: ADR 0005 ve `spike/cli-session/README.md`. Bir sonraki hedef resmi auth runtime'ını OS kimliğiyle ayırıp ağ allowlist altında gerçek kodlama/diff + bağımsız doğrulama ve token yenileme/logout testlerini birlikte geçirmektir. Tamamlanmış v1 kapsamı korunur; F1 GO kapısı açılmadı.

## Private managed session / bağımsız coding verifier — 2026-10-08

Model A için private resmi CLI home hacmi, salt okunur binary/bridge cache'i ve network-none CLI namespace'inden stdio provider egress adayı uygulandı. Task ayrı UID/filesystem/PID/network namespace'inde kalır. Host auth dosyaları okunup taşınmaz. Exact provider host:443, public IPv4 DNS ve doğrulanmış IP'ye bağlantı; relay TLS payload kaydetmez. Owner yanında operation etiketi cleanup'ın rakip komutu silmesini engeller. Private hacimler kasıtlı korunur; CLI/task namespace'leri kaldırıldı. Test sonunda iki izole profile logout uygulandı; native Windows oturumlarına logout uygulanmadı.

- Managed boundary: 16 kontrol geçti. Fake canary/env/proxy erişim reddi, provider TLS handshake, yanlış destination/port/IP, broker token/attempt, 16 çağrı sonrasında execution reddi, private home restart ve competing-command cleanup koruması. Public TLS/canary gerçek token renewal değildir.
- Coding verifier: 8 kontrol geçti. Bozuk baseline ve exit-0 spoof reddi, frozen bounded regular-file export, ayrı readonly/network-none verifier'da private oracle ile 32 örnek, git apply check, extra file, tek başına symlink ve oversized aday. Deterministik fixture patch'i `spike/results/coding-verifier-fixture.patch`; genel repository importer veya gerçek AI diff'i değildir.
- İki yeni resmi login tamamlandı. Claude Sonnet 4.6 (7 task çağrısı) ve Codex `gpt-6-astra` (2 çağrı) sabit kodlama görevinde gerçek AI adayları üretti. İki aday fresh readonly/network-none verifier'da 32'şer örnek ve git apply check geçti. Gerçek patch'ler `spike/results/managed-task-claude.patch` ve `managed-task-codex.patch` içinde; deterministik fixture patch'iyle ayrı kaydedilir.
- Codex yeni model metadata'sı kapatma bayraklarına rağmen ek araçlar etkinleştirdi. Pinned public katalogdan direct/disabled multi-agent/boş experimental tools profili oluşturuldu. Resmi CLI wire isteğinde yalnız `functions.task_exec`; 10 fixture kontrolü geçti. Profil hash'i ve başarılı fixture/cleanup kaydı gerçek görevden önce zorunludur. Binary/provider/auth değişmedi; başka model/sürüme genellenmez. Routing source lock model kataloğuyla 8/8 geçti.
- Codex resmi `account/read {refreshToken:true}` başarılı ve authenticated; token byte'ları/rotation içeriği ölçülmedi. İki izole profile resmi logout, authenticated false ve cleanup doğrulandı. Claude doğal expiry/refresh/relogin ayrı kabul olarak bekler.
- Pinned Node slim imajında sistem CA dizini yoktu; aynı imajın bundled public roots listesi readonly ca.pem olarak eklendi. Bu Windows hosttaki antivirüs HTTPS incelemesi için Windows'un doğruladığı installed Root'un yalnız public sertifikası Claude'a özel eklendi. TLS doğrulaması açık; private key/auth cache/tüm Windows trust store kopyalanmadı. CA içeriği her start'ta kontrol edilir. Certificate/proof/device code yayımlanmaz. Dar tekrar helper'ı `export-windows-trust.ps1`; farklı mevcut root'u değiştirmez.
- Host/Docker kesintisinde sonuçsuz kalan bir görev başarısız kaydedildi. Restart sonrasında sahipliği doğrulanan durmuş namespace/task hacmi temizlendi; private oturum hacimleri korundu. Bu elle uzlaştırma otomatik crash recovery değildir.
- `npm run check`: 66 Node testi (8 script + 58 package), Go tests, generated/typecheck ve frontend/Go build geçti. PostgreSQL/Temporal/UI/native katmanları değişmedi; önceki kanıtlar korunur.

Tekrar koşulları `spike/cli-session/MANAGED_SESSIONS.md`, karar/kalan kapılar ADR 0006. İki gerçek görev, Codex refresh ve izole logout kabulü kısmi F0 kanıtıdır. Claude doğal yenilemesi, geniş adversarial yollar, genel artifact scanner/importer, kota/eşzamanlılık, otomatik crash recovery ve diğer hostlar bekler. Tamamlanmış v1 kapsamı ve F1 GO kapısı korunur; desktop/HTTP execution hâlâ false.

## Sentetik saldırı / control / lifecycle / artifact — 2026-10-08

Üç paralel alt ajan görev ayrımıyla çalıştı: runtime/saldırı paketi, artifact sınırı ve resmi session lifecycle. Ana ajan broker/CI entegrasyonunu, bağımsız incelemeyi, Docker koşularını ve sonuç kaydını yönetti. Alt ajanlar `gpt-6.1-sol`, `high`; ana ajan dahil eşzamanlı üst sınır dörttü. Bu bölüm yalnız son kaynakla geçen kabulü özetler; önceki tarihli kayıtların kapsamı değişmez.

- Broker slotu body okunmadan ayrılır; execution başladıktan sonra client disconnect slotu erken bırakmaz. Strict UTF-8, body/çıktı boyutu ve çağrı sınırları fixture ile denetlendi.
- Relay kontrol alanları/ready sırası, pending DNS admission, stale connection sahipliği ve backpressure cleanup güçlendirildi. İptal edilmiş DNS flood ve drain gelmeden socket reset bağımsız incelemede yeniden üretildi; regression testleriyle kapatıldı. Beklenmedik relay hatası kalıcıdır ve provider success ile gizlenemez. Reddedilen hedef/hata raporları yalnız sabit reason code taşır.
- Session/RPC kimlik, callback/thread/turn eşleşmesi, erken login completion, process kapanışı, deadline ve iptal kontrolü ortak yardımcıya alındı. Raw byte/line sınırı readline'dan önce uygulanır. Kodlama iptali artifact/verifier/diff ve cleanup boyunca kalıcıdır. Failure raporları provider ham mesajını içermez.
- Tek `sum.mjs` artifact politikası export ve host staging öncesinde uygulanır: unsafe inventory/file type/link, size/encoding/control/bidi ve bilinen credential biçimleri reddedilir. Bu, genel importer veya production secret scanner değildir. Diff yalnız metadata başlıklarında normalize edilir; gerçekten uygulanan kaynağın hash'i verifier adayına eşit olmalıdır.
- Son Docker koşusunda yeni sentetik profiller için **Claude 11 + Codex 11 kabul grubu** geçti. Dosya/process/fd/env/socket/ptrace, namespace/UID/capability/seccomp/network, PID/tmpfs tükenmesi, proxy/broker ve teardown kontrolleri başarılıdır. Gerçek hesap/model çağrısı veya önceki private profile erişimi yapılmadı. Kaynak sınırlarının kapsamı ADR 0007'de belirtilir.
- Coding verifier **24/24 kontrol** geçti: iki adayda 32'şer oracle örneği, patch check/actual apply/hash roundtrip ve path literal regression'ı dahil. Son koşudan önce `.local` içindeki Git apply'ın patch'i atlayıp exit 0 dönebildiği bulundu; bu koşu başarısız kaydedildi. Parent repo keşfi apply/check için devre dışı bırakıldı; ignored nested repo regression'ı ve gerçek roundtrip geçti. Başarısız rapor `.local` içinde korunur.
- Önceki iki yayımlanmış gerçek AI patch'i ayrıca disposable baseline'a gerçekten uygulandı. Patch/base hash'leri ve uygulanan candidate hash'leri önceki verifier kayıtlarıyla eşittir; dar kaynak politikası da geçti. Bu replay aday kodunu çalıştırmadı veya gerçek model/verifier görevini tekrarlamadı; kanıt `artifact-replay-windows-2026-10-08.json` içindedir.
- Son `npm run check`: **121 Node testi (13 script + 108 package/spike), sıfır failure**, generated/typecheck, Go testleri ve frontend/Go build geçti. Yeni 55 regression testi genel kontrol paketindedir. PostgreSQL entegrasyonu, Temporal, UI ve native release bu aşamada yeniden çalıştırılmadı; önceki kanıtlar ayrı kalır.
- Cleanup sonunda owner etiketli test konteyneri kalmadığı doğrulandı. Yeni sentetik/task/export/verifier hacimleri kaldırıldı; yalnız önceki iki oturumsuz profile ait dört private auth/tools hacmi korunur. Native Windows oturumları kullanılmadı veya değiştirilmedi.
- Ubuntu CI'a hesapsız adversarial ve coding-verifier komutları eklendi; uzak CI çalıştırılmadı. Güncel bridge/broker hash'i eski prepared cache'i başlatmaz; otomatik auth/cache yükseltmesi yapılmaz.

Kanıtlar: `spike/results/managed-adversarial-windows-2026-10-08.json`, `coding-verifier-windows-2026-10-08.json`, iki deterministik fixture patch'i ve `foundations-windows-2026-10-08.json`. Komutlar `spike/cli-session/MANAGED_SESSIONS.md`, karar/sınırlar ADR 0007 içindedir. Claude doğal expiry/refresh/relogin, gerçek kota/eşzamanlılık, tüm provider araç yolları, genel importer/scanner, crash recovery ve diğer hostlar kapanmadan GO verilmez; desktop/HTTP execution kapalıdır. Tamamlanmış v1.0 kapsamı korunur.

## Oturum sürekliliği / kota / işlem sahipliği — 2026-10-08

Üç `gpt-6.1-sol/high` alt ajan runtime sürekliliği, oturum kabulü ve bağımsız uyumluluk/kod incelemesinde çalıştı; ana ajan dahil en fazla dört eşzamanlı ajan kullanıldı. Ana ajan immutable-ID görev gönderimini, script/CI/doküman entegrasyonunu, son Docker koşularını ve kanıt yayınını yönetti. Kullanıcı mevcut resmi CLI + katılımcının kendi aboneliği tasarımında geliştirmeye devam etmeyi seçti; API/yerel model pivot yapılmadı. Sağlayıcı değerlendirmesi yerel ve Git dışı `docs-private/PROVIDER_COMPATIBILITY.md` kaydıdır.

- Eski işlem temizliği successor'ı silemez: owner/operation/state ve immutable ID birlikte doğrulanır. Start/exec/bridge doğrudan doğrulanmış ID'ye gönderilir; stopped recovery zorlamasız tam işlem uzlaştırmasıdır. Timeout/iptalde dispatched namespace kaldırılır, private hacim tutulur. Start/stop sinyal taşır; kaybolan create ID, yalnız bir absent snapshot nedeniyle cleanup-confirmed olmaz.
- `managed-session` ve provider yardımcıları import-safe hale geldi. `spike:session-acceptance` status/restart/status, Codex resmi refresh/status/readonly quota ve profile bağlı public checkpoint akışını denetler. Cleanup ayrı 30 saniye bütçe taşır; bekleyen işlem kabulü/cleanup kanıtını engeller. Unknown/invalid quota, kimlik alanı düşürme, iptal/deadline, takılan provider/stop ve checkpoint binding saf fixture'larla sınandı. On dakikalık device login izni tek RPC'nin 30 saniye sınırını uzatmaz.
- Yeni hesapsız Docker süreklilik koşusu **Claude 9 + Codex 9 kabul grubu** geçti. Sağlayıcı başına altı contender start reddedildi; canlı recovery/yanlış işlem exec/bridge reddi, sahte state restart, stopped uzlaştırma, stale cleanup, detached child timeout/iptal ve control/readiness kontrolü geçti. Yeni sentetik hacimler kaldırıldı; gerçek hesap/model çağrısı veya önceki private profile erişimi yoktu.
- Runtime değişikliğinden sonra adversarial paket tekrar çalıştırıldı: **Claude 11 + Codex 11 grup** ve cleanup geçti. Son public adversarial kayıt yenilendi; önceki ham koşular `.local` altında korunur. Owner etiketli test konteyneri kalmadı, yeni hacimler kaldırıldı; önceki iki oturumsuz profile ait dört hacim aynı adlarla korundu.
- Son `npm run check`: **167 Node testi (13 script + 154 package/spike), sıfır failure**, generated/typecheck, Go testleri ve frontend/Go build geçti. Önceki 121-test kaydına 46 runtime/session regression testi eklendi. PostgreSQL integration, Temporal, UI/native release bu aşamada yeniden çalıştırılmadı; uzak CI çalışmış sayılmaz.
- CI'a sadece sentetik süreklilik runner'ı eklendi; `--real-account` kabulü ayrı geliştirici komutudur. Bu aşamada gerçek hesap kabulü çalıştırılmadı. Kota `available` yalnız bilginin okunabildiğini gösterir; tükenme/reset, doğal expiry/rotation veya eşzamanlı abonelik kullanımını doğrulamaz. Resume geçen süreyi kaydeder; yenileme kanıtı üretmez.

Kanıtlar: `spike/results/managed-continuity-windows-2026-10-08.json`, `session-foundations-windows-2026-10-08.json` ve güncel `managed-adversarial-windows-2026-10-08.json`. Karar ve sınırlar ADR 0008'de, komutlar `spike/cli-session/MANAGED_SESSIONS.md` içindedir. Otomatik crash recovery/profile lock, genel artifact importer/scanner, Claude doğal expiry/renewal, gerçek kota/eşzamanlılık ve diğer hostlar açık kalır. v1 kapsamı, `execution_enabled=false` ve `isolation_gate=not_evaluated` korunur.

## İşlev testlerinde model ve kota tercihi — 2026-10-08

Kullanıcı uygulama içindeki gerçek AI işlev testleri için **Luna/Haiku**, geliştirme alt ajanları için **Sol 6.1/high** seçti. Kural root `AGENTS.md` ve `functional-test-models.mts` içinde kayıtlıdır. Native bağlantı smoke ve izole coding task artık açık Luna/Haiku ister; native Codex'in varsayılan/ilk model seçimi kaldırıldı. Luna bulunmazsa durur; Codex thread'in bildirdiği model turn'den önce seçili modele eşit olmalıdır. Claude açık fallback aynı Haiku modeline bağlanır. API veya pahalı modele otomatik geçiş yapılmaz; ürünün normal görev model seçimi değiştirilmez.

Bekleyen uzun süreli kabul, resmi CLI oturumunun zaman geçtikten sonra yenilenebilmesi veya yeniden giriş ihtiyacının doğru gösterilmesidir. Kota kabulü limit hatası geldiğinde görevin durması, limit/reset bilgisinin yalnız bildirildiğinde gösterilmesi ve güvenli devam davranışıdır. Kullanıcının kotası kasıtlı tüketilmez: hata yolları önce fixture ile sınanır, gerçek sağlayıcı davranışı normal kullanımda gözlemlenir. Son 167-test/sentetik Docker koşusu model çağrısı yapmadı.

Model kimlikleri [OpenAI Docs / Codex models](https://learn.chatgpt.com/docs/models) ve [Claude Code model configuration](https://code.claude.com/docs/en/model-config) ile kontrol edildi. Pinned Codex katalogda `gpt-6-luna` vardır; hesap erişimi resmi `model/list` ile ayrıca sınanır. Haiku alias çözümü CLI/provider sürümüne bağlıdır. Önceki Astra/Sonnet AI raporları yeni ucuz modelle tekrar yapılmış sayılmaz.

Doğrulama: `npm run typecheck` ve ilgili session/provider paketindeki **50/50 saf test** geçti. Resmi Codex 0.157.1 binary'siyle yeni Luna direct-tool profili yerel model yanıtları altında **10 kontrol** ve cleanup geçti; advertised tool yalnız `functions.task_exec`tir. Public kayıt `spike/results/codex-luna-profile-windows-2026-10-08.json` içindedir. Gerçek Haiku/Luna hesabı veya inference çalıştırılmadı; mevcut private profillere erişilmedi. İlk fixture koşusu eksik Docker image referansı nedeniyle başarısız oldu; pinned image pull sonrası tekrar geçti. Her iki ham koşu `.local` altında korunur. Önceki Astra proof'u değiştirilmiş tarihli kanıt olarak sunulmaz; yeni proof yeni model/catalog hash'ine bağlıdır.
